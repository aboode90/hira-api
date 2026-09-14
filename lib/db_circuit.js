/**
 * قاطع دائرة خفيف لـ Supabase + ممر أولوية للإدارة:
 * - عند توالي Abort/timeout تُفتح الدائرة لفترة قصيرة.
 * - عند طلبات /db/admin/* يُفعَّل adminPriority حتى تتنازل المسارات الساخنة للتطبيق.
 */

const FAILURE_THRESHOLD = 8;
const OPEN_MS = 45_000;
const WINDOW_MS = 60_000;
const ADMIN_PRIORITY_DEFAULT_MS = 75_000;

let failureTimestamps = [];
let openedAt = 0;
let adminPriorityUntil = 0;

function prune(now = Date.now()) {
  failureTimestamps = failureTimestamps.filter((ts) => now - ts <= WINDOW_MS);
}

function isTransientDbFailure(error) {
  const msg = String(error?.message || error?.name || error || '');
  return /aborted|AbortError|timeout|مهلة|مشغول|ETIMEDOUT|ECONNRESET|fetch failed|upstream/i.test(
    msg,
  );
}

function recordDbSuccess() {
  failureTimestamps = [];
  openedAt = 0;
}

function recordDbFailure(error) {
  if (!isTransientDbFailure(error)) return;
  const now = Date.now();
  // أثناء فتح الدائرة لا نمدّد العاصفة بآلاف الإخفاقات — يكفي الإبقاء مفتوحاً.
  if (openedAt && now - openedAt < OPEN_MS) {
    return;
  }
  prune(now);
  failureTimestamps.push(now);
  // سقف حتى لا تنتفخ الذاكرة تحت الحمل
  if (failureTimestamps.length > FAILURE_THRESHOLD * 4) {
    failureTimestamps = failureTimestamps.slice(-FAILURE_THRESHOLD * 2);
  }
  if (failureTimestamps.length >= FAILURE_THRESHOLD) {
    openedAt = now;
  }
}

function clearDbCircuit() {
  failureTimestamps = [];
  openedAt = 0;
}

function isDbCircuitOpen() {
  if (!openedAt) return false;
  if (Date.now() - openedAt >= OPEN_MS) {
    openedAt = 0;
    failureTimestamps = [];
    return false;
  }
  return true;
}

function beginAdminPriority(ttlMs = ADMIN_PRIORITY_DEFAULT_MS) {
  const ttl = Number(ttlMs);
  const windowMs =
    Number.isFinite(ttl) && ttl > 0 ? ttl : ADMIN_PRIORITY_DEFAULT_MS;
  adminPriorityUntil = Math.max(adminPriorityUntil, Date.now() + windowMs);
}

function isAdminPriorityActive() {
  if (!adminPriorityUntil) return false;
  if (Date.now() >= adminPriorityUntil) {
    adminPriorityUntil = 0;
    return false;
  }
  return true;
}

/**
 * تنازل المسارات الاختيارية فقط (صوت/توكن) وفقط عند انهيار القاعدة.
 * لا يعتمد على adminPriority — لوحة الإدارة يجب ألا توقف خدمات المستخدمين.
 * التاكسي مستثنى نهائياً: خدمة حرجة لا تُسكَت مسبقاً.
 */
function shouldShedOptionalPolling() {
  return isDbCircuitOpen();
}

function getDbCircuitState() {
  const now = Date.now();
  prune(now);
  const adminActive = isAdminPriorityActive();
  return {
    open: isDbCircuitOpen(),
    failuresInWindow: failureTimestamps.length,
    openRemainingMs: openedAt ? Math.max(0, OPEN_MS - (now - openedAt)) : 0,
    adminPriority: adminActive,
    adminPriorityRemainingMs: adminActive
      ? Math.max(0, adminPriorityUntil - now)
      : 0,
  };
}

module.exports = {
  isTransientDbFailure,
  recordDbSuccess,
  recordDbFailure,
  clearDbCircuit,
  isDbCircuitOpen,
  beginAdminPriority,
  isAdminPriorityActive,
  shouldShedOptionalPolling,
  getDbCircuitState,
};
