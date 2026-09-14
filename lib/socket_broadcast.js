/**
 * بث الأحداث لحظياً عبر خادم Socket.io (VPS).
 *
 * المتغيرات:
 *   SOCKET_BROADCAST_URL  — أساس HTTPS (أو مسار HTTP مؤقت للمنفذ المنشور على الـ VPS)
 *   SOCKET_URL            — توافق قديم؛ يُستخدم إن لم تُضبط SOCKET_BROADCAST_URL
 *   SOCKET_BROADCAST_KEY  — يجب أن يطابق BROADCAST_KEY في خادم VPS (≥ 24 حرفاً).
 *
 * يُستدعى من مسارات التكسي/الطلبات لإعلام العملاء فوراً
 * دون إفشال الطلب الأصلي إن فشل البث.
 */

const crypto = require('crypto');

const MIN_KEY_LENGTH = 24;
/** مفاتيح معروفة/قديمة — مرفوضة حتى لو طُبّقت يدوياً في البيئة */
const BLOCKED_KEYS = new Set(['alghaith-socket-broadcast-key']);

/**
 * عناوين HTTP مسموحة مؤقتاً لبث الخادم→السوكيت عندما يكون
 * https://socket.hirasite.com خلف Traefik بدون مسار صحيح.
 * لا تُستخدم من تطبيق الموبايل كافتراضي عام.
 */
const ALLOWED_HTTP_BROADCAST_HOSTS = new Set([
  '155.117.43.250',
  '127.0.0.1',
  'localhost',
]);

let _warnedMissingConfig = false;

function timingSafeEqualString(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function getBroadcastConfig(env = process.env) {
  const key = String(env.SOCKET_BROADCAST_KEY || '').trim();
  const baseUrl = String(
    env.SOCKET_BROADCAST_URL || env.SOCKET_URL || '',
  )
    .trim()
    .replace(/\/+$/, '');

  if (!key || key.length < MIN_KEY_LENGTH) {
    return { ok: false, reason: 'SOCKET_BROADCAST_KEY missing or shorter than 24 chars' };
  }
  if (BLOCKED_KEYS.has(key)) {
    return {
      ok: false,
      reason: 'SOCKET_BROADCAST_KEY is a known/compromised default — rotate it',
    };
  }
  if (!baseUrl) {
    return { ok: false, reason: 'SOCKET_BROADCAST_URL missing' };
  }

  let url;
  try {
    url = new URL(baseUrl.includes('/api/') ? baseUrl : `${baseUrl}/api/broadcast`);
  } catch {
    return { ok: false, reason: 'SOCKET_BROADCAST_URL is not a valid URL' };
  }

  if (url.protocol === 'https:') {
    return { ok: true, key, url };
  }

  if (
    url.protocol === 'http:' &&
    ALLOWED_HTTP_BROADCAST_HOSTS.has(url.hostname)
  ) {
    return { ok: true, key, url };
  }

  return {
    ok: false,
    reason:
      'SOCKET_BROADCAST_URL must use https:// (or allowed http host for VPS publish port)',
  };
}

/**
 * يبث حدثاً إلى غرفة معينة في خادم Socket.io.
 * fire-and-forget — أي فشل يُسجّل فقط ولا يعطل العملية.
 */
async function socketBroadcast({ room, event, payload }) {
  const config = getBroadcastConfig();
  if (!config.ok) {
    if (!_warnedMissingConfig) {
      _warnedMissingConfig = true;
      console.warn(`[socket_broadcast] disabled: ${config.reason}`);
    }
    return;
  }
  const r = String(room || '').trim();
  const e = String(event || '').trim();
  if (!r || !e) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(config.url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: config.key,
        room: r,
        event: e,
        payload: payload || {},
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `socket broadcast ${e} -> ${r}: HTTP ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`,
      );
    }
  } catch (error) {
    console.warn(`socket broadcast ${e} -> ${r}:`, error?.message || error);
  }
}

/** غرفة الكباتن من نفس النوع (economic/tuktuk/wazz...). */
function driverTypeRoom(taxiType) {
  const type = String(taxiType || 'economic').trim() || 'economic';
  return `drivers:${type}`;
}

/** غرفة كابتن واحد — لبث حصري (أولوية التكسي الاقتصادي). */
function driverRoom(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  const last10 = digits.slice(-10);
  return `driver:+964${last10}`;
}

/** غرفة الزبون (تُحجز عند تسجيل دخول الزبون في التطبيق). */
function customerRoom(phone) {
  return `customer:${String(phone || '').trim()}`;
}

/** غرفة رحلة محددة (التتبع اللحظي للكابتن). */
function tripRoom(requestId) {
  return `trip:${String(requestId || '').trim()}`;
}

/** غرفة التاجر — طلبات/حالات تصل فوراً بدل الاستطلاع. */
function merchantRoom(phone) {
  return `merchant:${String(phone || '').trim()}`;
}

/** غرفة عمليات الأدمن — أحداث جديدة (طلبات/شكاوى/تذاكر) فوراً. */
function adminOpsRoom() {
  return 'admin:ops';
}

/** غرفة مجمّع المندوبين — طلبات توصيل جديدة/محجوزة فوراً. */
function couriersRoom() {
  return 'couriers';
}

/** غرفة مندوب محدد — تحديثات الطلبات المعيّنة له. */
function courierRoom(phone) {
  return `courier:${String(phone || '').trim()}`;
}

/** غرفة مستخدم — إشعارات لحظية (رسائل جديدة/غير مقروء...) خارج غرف المحادثة. */
function userRoom(phone) {
  return `user:${String(phone || '').trim()}`;
}

/** غرفة محادثة بين طرفين — تطابق room = threadType:threadId في التطبيق. */
function chatRoom(threadType, threadId) {
  return `${String(threadType || '').trim()}:${String(threadId || '').trim()}`;
}

/**
 * بث رسالة محادثة لغرفة المحادثة.
 * best-effort فقط — أي فشل يُسجَّل ولا يمنع حفظ الرسالة أو إطلاق الإشعار.
 */
function broadcastChatMessage(threadType, threadId, message) {
  try {
    void socketBroadcast({
      room: chatRoom(threadType, threadId),
      event: 'message',
      payload: message || {},
    });
  } catch (error) {
    console.warn('chat broadcast error:', error?.message || error);
  }
}

module.exports = {
  MIN_KEY_LENGTH,
  timingSafeEqualString,
  getBroadcastConfig,
  socketBroadcast,
  driverTypeRoom,
  driverRoom,
  customerRoom,
  tripRoom,
  merchantRoom,
  adminOpsRoom,
  couriersRoom,
  courierRoom,
  userRoom,
  chatRoom,
  broadcastChatMessage,
};
