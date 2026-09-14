const { randomUUID } = require('crypto');
const {
  nowIso,
  resolvePhoneKey,
  getPhoneVariants,
  selectMany,
  assertSupabaseAdmin,
} = require('./common');
const { assertAdminAccess } = require('./users');
const { sendPushToTokensDirect } = require('../services/notification_delivery');
const { recordPushInboxDelivered } = require('./push_notifications');

const INSERT_CHUNK_SIZE = 200;

function mapRoleToAudience(role) {
  const normalized = String(role || '').trim().toLowerCase();
  switch (normalized) {
    case 'merchant':
      return 'merchant';
    case 'driver':
      return 'driver';
    case 'delivery':
      return 'delivery';
    case 'admin':
      return 'admin';
    default:
      return 'customer';
  }
}

async function resolveAudiencePhones(audience) {
  const supabase = assertSupabaseAdmin();
  const target = String(audience || 'all').trim().toLowerCase();

  if (target === 'all') {
    const { data, error } = await supabase.from('app_users').select('phone');
    if (error) throw new Error(error.message);
    return [...new Set((data || []).map((row) => String(row.phone || '').trim()).filter(Boolean))];
  }

  if (target === 'customers') {
    const { data, error } = await supabase.from('customer_profiles').select('phone');
    if (error) throw new Error(error.message);
    return [...new Set((data || []).map((row) => String(row.phone || '').trim()).filter(Boolean))];
  }

  if (target === 'merchants') {
    const { data, error } = await supabase.from('merchant_profiles').select('phone');
    if (error) throw new Error(error.message);
    return [...new Set((data || []).map((row) => String(row.phone || '').trim()).filter(Boolean))];
  }

  if (target === 'drivers') {
    const { data, error } = await supabase.from('driver_profiles').select('phone');
    if (error) throw new Error(error.message);
    return [...new Set((data || []).map((row) => String(row.phone || '').trim()).filter(Boolean))];
  }

  if (target === 'delivery' || target === 'couriers') {
    const { data, error } = await supabase.from('courier_profiles').select('phone');
    if (error) throw new Error(error.message);
    return [...new Set((data || []).map((row) => String(row.phone || '').trim()).filter(Boolean))];
  }

  throw new Error('الجمهور المستهدف غير صالح.');
}

async function buildPhoneAudienceMap(phones) {
  const unique = [...new Set((phones || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!unique.length) return {};

  const users = await selectMany(
    'app_users',
    [{ method: 'in', column: 'phone', value: unique }],
    { column: 'updated_at', ascending: false },
    unique.length,
  );

  const map = {};
  for (const phone of unique) {
    map[phone] = 'customer';
  }
  for (const user of users) {
    const phone = String(user.phone || '').trim();
    if (!phone) continue;
    map[phone] = mapRoleToAudience(user.role);
  }
  return map;
}

async function insertUserNotificationsBulk(rows) {
  const payload = (rows || []).filter(
    (row) => row && String(row.phone || '').trim() && String(row.title || '').trim(),
  );
  if (!payload.length) return 0;

  const supabase = assertSupabaseAdmin();
  let inserted = 0;

  for (let offset = 0; offset < payload.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = payload.slice(offset, offset + INSERT_CHUNK_SIZE);
    const { error } = await supabase.from('user_notifications').insert(chunk);
    if (error) throw new Error(error.message);
    inserted += chunk.length;
  }

  return inserted;
}

function serializeUserNotificationRow(row) {
  if (!row || typeof row !== 'object') return null;
  const createdAt = row.created_at || row.createdAt || null;
  const createdAtMs = createdAt ? Date.parse(String(createdAt)) : Date.now();
  return {
    id: String(row.id || ''),
    phone: String(row.phone || ''),
    title: String(row.title || ''),
    body: String(row.body || ''),
    audience: String(row.audience || 'customer'),
    category: String(row.category || 'admin'),
    eventKey: String(row.event_key || row.eventKey || ''),
    broadcastId: row.broadcast_id || row.broadcastId || null,
    read: row.is_read === true || row.read === true,
    createdAt,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
  };
}

async function listUserNotifications(phone, options = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const since = String(options.since || '').trim();

  let query = supabase
    .from('user_notifications')
    .select('*')
    .eq('phone', phoneKey)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (since) {
    query = query.gt('created_at', since);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).map(serializeUserNotificationRow).filter(Boolean);
}

async function markUserNotificationsRead(phone, ids = null) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const payload = { is_read: true };

  let query = supabase.from('user_notifications').update(payload).eq('phone', phoneKey);

  if (Array.isArray(ids) && ids.length > 0) {
    const normalizedIds = ids.map((id) => String(id || '').trim()).filter(Boolean);
    if (!normalizedIds.length) return { updated: 0 };
    query = query.in('id', normalizedIds);
  } else {
    query = query.eq('is_read', false);
  }

  const { data, error } = await query.select('id');
  if (error) throw new Error(error.message);
  return { updated: Array.isArray(data) ? data.length : 0 };
}

async function countUnreadUserNotifications(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const { count, error } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phoneKey)
    .eq('is_read', false);
  if (error) throw new Error(error.message);
  return Number(count || 0);
}

async function queryDeviceTokensForAudience(audience, platformFilter) {
  const supabase = assertSupabaseAdmin();
  let query = supabase.from('device_tokens').select('token, platform, phone');

  if (audience && audience !== 'all') {
    const phones = await resolveAudiencePhones(audience);
    if (!phones.length) return [];
    query = query.in('phone', phones);
  }

  const normalizedPlatform = String(platformFilter || 'all').trim().toLowerCase();
  if (normalizedPlatform === 'android' || normalizedPlatform === 'ios') {
    query = query.eq('platform', normalizedPlatform);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function broadcastAdminUserMessage(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  const audience = String(payload.audience || 'all').trim().toLowerCase() || 'all';
  const platformFilter = String(payload.platform || 'all').trim().toLowerCase() || 'all';
  const storeUpdate = payload.storeUpdate === true;

  if (!title || !body) {
    throw new Error('العنوان والنص مطلوبان.');
  }

  const allowedPlatforms = new Set(['all', 'android', 'ios', 'both']);
  if (!allowedPlatforms.has(platformFilter)) {
    throw new Error('نوع الجهاز غير صالح.');
  }

  const broadcastId = randomUUID();
  const eventKey = `admin:broadcast:${broadcastId}`;
  const targetPhones = await resolveAudiencePhones(audience);

  if (!targetPhones.length) {
    return {
      broadcastId,
      inAppCount: 0,
      sent: 0,
      failed: 0,
      invalidTokens: 0,
      tokenCount: 0,
      platforms: [],
      platformFilter,
      message: 'لا يوجد مستخدمون في الجمهور المحدد.',
    };
  }

  const audienceByPhone = await buildPhoneAudienceMap(targetPhones);
  const notificationRows = targetPhones.map((phone) => ({
    phone,
    title,
    body,
    audience: audienceByPhone[phone] || 'customer',
    category: 'admin',
    event_key: eventKey,
    broadcast_id: broadcastId,
    is_read: false,
    created_at: nowIso(),
  }));

  let inAppCount = 0;
  try {
    inAppCount = await insertUserNotificationsBulk(notificationRows);
  } catch (error) {
    if (!/does not exist|relation .*user_notifications/i.test(error.message || '')) {
      throw error;
    }
    console.warn('broadcastAdminUserMessage: user_notifications table missing — push only');
  }

  const tokenRows = await queryDeviceTokensForAudience(audience, platformFilter);
  const uniqueTokens = [...new Set(tokenRows.map((row) => row.token).filter(Boolean))];
  const platforms = [...new Set(tokenRows.map((row) => row.platform).filter(Boolean))];

  let pushResult = { sent: 0, failed: 0, invalidTokens: [] };
  if (uniqueTokens.length) {
    pushResult = await sendPushToTokensDirect(uniqueTokens, {
      title,
      body,
      data: {
        category: 'admin',
        audience,
        platform: platformFilter,
        eventKey,
        broadcastId,
        storeUpdate: storeUpdate ? 'true' : 'false',
        role: audience === 'all' ? '' : audience,
      },
      showSystemBanner: true,
    });

    const phonesWithTokens = [...new Set(tokenRows.map((row) => row.phone).filter(Boolean))];
    await Promise.allSettled(
      phonesWithTokens.map((phone) => recordPushInboxDelivered(phone)),
    );
  }

  const platformLabel =
    platformFilter === 'android'
      ? ' (أندرويد)'
      : platformFilter === 'ios'
        ? ' (آيفون)'
        : '';

  const messageParts = [
    `تم حفظ الرسالة لـ ${inAppCount} مستخدم داخل التطبيق`,
    pushResult.sent > 0 ? `وإرسال إشعار خارجي إلى ${pushResult.sent} جهاز${platformLabel}` : 'بدون أجهزة push مسجّلة',
  ];
  if (pushResult.failed > 0) {
    messageParts.push(`فشل الإرسال الخارجي: ${pushResult.failed}`);
  }

  return {
    broadcastId,
    inAppCount,
    sent: pushResult.sent || 0,
    failed: pushResult.failed || 0,
    invalidTokens: pushResult.invalidTokens?.length || 0,
    tokenCount: uniqueTokens.length,
    platforms,
    platformFilter,
    message: `${messageParts.join('، ')}.`,
  };
}

module.exports = {
  mapRoleToAudience,
  resolveAudiencePhones,
  listUserNotifications,
  markUserNotificationsRead,
  countUnreadUserNotifications,
  broadcastAdminUserMessage,
  serializeUserNotificationRow,
  insertUserNotificationsBulk,
};
