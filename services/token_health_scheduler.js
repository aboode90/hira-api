const admin = require('firebase-admin');
const logger = require('../lib/logger');
const { initFirebaseAdmin } = require('../push_notifications');
const {
  removeDeviceTokens,
} = require('../supabase_repo/push_notifications');
const {
  assertSupabaseAdmin,
} = require('../supabase_repo/common');

// كل 12 ساعة — خفيف ولا يؤثر على الإرسال الفوري.
const TOKEN_HEALTH_INTERVAL_MS = 12 * 60 * 60 * 1000;
// أي توكن لم يُحدَّث خلال هذه المدة يُعد مرشحاً للحذف بعد فحص FCM.
const STALE_AFTER_DAYS = 14;
const BATCH_LIMIT = 500;
const MAX_DAILY_INVALID_TOKENS = 2000;

let running = false;
let timer = null;

async function findStaleDeviceTokens(days = STALE_AFTER_DAYS) {
  const supabase = assertSupabaseAdmin();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('device_tokens')
    .select('id, token')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => String(row.token || '').trim()).filter(Boolean);
}

/**
 * يفحص التوكنات القديمة عند FCM (رسالة تحقق فقط) ويحذف المؤكَّد لاغيها.
 * التوكن الصالح لا يُلمس — التطبيق يجدّد updated_at تلقائياً عند كل ربط.
 */
async function validateAndPruneStaleTokens() {
  if (!initFirebaseAdmin()) {
    return { skipped: true, reason: 'fcm_not_configured' };
  }

  const tokens = await findStaleDeviceTokens();
  if (tokens.length === 0) {
    return { checked: 0, removed: 0 };
  }

  const messaging = admin.messaging();
  const invalid = [];
  for (const token of tokens) {
    try {
      await messaging.send(
        {
          token,
          data: { category: 'health_check', eventKey: 'token:health_check' },
        },
        true // dryRun — لا يصل المستخدم إشعار فعلي
      );
    } catch (error) {
      const code = error?.errorInfo?.code || error?.code || '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        invalid.push(token);
        if (invalid.length >= MAX_DAILY_INVALID_TOKENS) break;
      }
    }
  }

  if (invalid.length > 0) {
    await removeDeviceTokens(invalid);
  }

  logger.info(
    `Token health: checked=${tokens.length} removedInvalid=${invalid.length}`
  );
  return { checked: tokens.length, removed: invalid.length };
}

/**
 * يرصد الكباتن المتصلين (is_online) بلا أي توكن إشعارات — مصدر
 * شكاوى «طلب تكسي والإشعار لا يصل» قبل أن يشتكي الزبون.
 */
async function reportOnlineDriversWithoutTokens() {
  const supabase = assertSupabaseAdmin();
  const { data: onlineRows, error } = await supabase
    .from('driver_locations')
    .select('phone, taxi_type')
    .eq('is_online', true)
    .eq('available', true)
    .eq('is_approved', true)
    .limit(500);
  if (error) throw new Error(error.message);

  const onlinePhones = [...new Set((onlineRows || []).map((r) => String(r.phone || '').trim()).filter(Boolean))];
  if (onlinePhones.length === 0) return { online: 0, withoutToken: 0 };

  const { getPhoneVariants } = require('../supabase_repo/common');
  const variants = onlinePhones.flatMap((p) => getPhoneVariants(p));
  const { data: tokenRows, error: tokenError } = await supabase
    .from('device_tokens')
    .select('phone')
    .in('phone', variants);
  if (tokenError) throw new Error(tokenError.message);

  const withTokenPhones = new Set((tokenRows || []).map((r) => String(r.phone || '').replace(/\D/g, '').slice(-10)));
  const withoutToken = onlinePhones.filter((p) => !withTokenPhones.has(String(p).replace(/\D/g, '').slice(-10)));

  if (withoutToken.length > 0) {
    logger.warn(
      `Token health: ${withoutToken.length} online driver(s) have NO device token — ${withoutToken.join(', ')}`
    );
  }
  return { online: onlinePhones.length, withoutToken: withoutToken.length };
}

async function runTokenHealthTick() {
  try {
    await validateAndPruneStaleTokens();
  } catch (error) {
    logger.error('Token health prune failed:', error?.message || error);
  }
  try {
    await reportOnlineDriversWithoutTokens();
  } catch (error) {
    logger.error('Token health online-driver report failed:', error?.message || error);
  }
}

function startTokenHealthScheduler() {
  if (running) return;
  running = true;
  void runTokenHealthTick();
  timer = setInterval(runTokenHealthTick, TOKEN_HEALTH_INTERVAL_MS);
  logger.info('Token health scheduler started');
}

module.exports = {
  startTokenHealthScheduler,
  runTokenHealthTick,
  validateAndPruneStaleTokens,
  reportOnlineDriversWithoutTokens,
};
