/**
 * بحث متوسّع (رادار): مُعطّل — إشعار FCM مرة واحدة عند إنشاء الطلب فقط.
 * الإبقاء على الدوال للتوافق مع الشاشات/الاختبارات القديمة دون إعادة إرسال.
 */

const WAVE_MS = 30 * 1000;
const START_RADIUS_KM = 1;
const STEP_KM = 1;
const SEARCH_TIMEOUT_MS = 300 * 1000;

/** رادار الإشعارات المتكرر متوقف — لا موجات إعادة إرسال. */
function usesExpandingTaxiSearch(_taxiType) {
  return false;
}

function matchingWaveIndex(createdAt, nowMs = Date.now()) {
  const start = Date.parse(createdAt);
  const origin = Number.isFinite(start) ? start : nowMs;
  const elapsed = Math.max(0, nowMs - origin);
  return Math.floor(elapsed / WAVE_MS);
}

function matchingRadiusKm(createdAt, nowMs = Date.now()) {
  return START_RADIUS_KM + matchingWaveIndex(createdAt, nowMs) * STEP_KM;
}

function isWithinSearchTimeout(createdAt, nowMs = Date.now()) {
  const start = Date.parse(createdAt);
  if (!Number.isFinite(start)) return true;
  return nowMs - start < SEARCH_TIMEOUT_MS;
}

module.exports = {
  WAVE_MS,
  START_RADIUS_KM,
  STEP_KM,
  SEARCH_TIMEOUT_MS,
  usesExpandingTaxiSearch,
  matchingWaveIndex,
  matchingRadiusKm,
  isWithinSearchTimeout,
};
