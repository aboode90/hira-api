/**
 * خدمة "الرحلة المفتوحة" (عداد) — تسعير يعمل بالمسافة + الوقت.
 *
 * النموذج:
 *   أجرة = 1,500 د.ع (بداية) + 300 د.ع لكل كم بعد أول 100م مجاناً
 *          + 45 د.ع لكل دقيقة
 *
 * يبدأ العداد عند رفع حالة الرحلة إلى picked_up (صعود الزبون مع الكابتن)،
 * وتُجمَّع المسافة من تحديثات موقع الكابتن أثناء الرحلة.
 */

const OPEN_TRIP_PRICING = {
  base: 1500,
  perKm: 300,
  perMin: 45,
  freeKm: 0.1,
};

/** أول 100 متر مجاناً — العداد لا يضيف قيمة للمسافة قبل تجاوزها. */
const METER_FREE_DISTANCE_KM = OPEN_TRIP_PRICING.freeKm;

function _positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** هل هذه رحلة مفتوحة (عداد)؟ */
function isOpenTrip(payload = {}) {
  return (
    String(payload.tripMode || '').trim() === 'open' ||
    String(payload.serviceKind || '').trim() === 'open_trip'
  );
}

/** قراءة إعدادات العداد من الحمولة مع القيم الافتراضية. */
function openTripPricing(payload = {}) {
  return {
    base: _positiveNumber(payload.base ?? payload.tripMeterBase, OPEN_TRIP_PRICING.base),
    perKm: _positiveNumber(payload.perKm ?? payload.tripPerKm, OPEN_TRIP_PRICING.perKm),
    perMin: _positiveNumber(payload.perMin ?? payload.tripPerMin, OPEN_TRIP_PRICING.perMin),
    freeKm: _positiveNumber(payload.freeKm ?? payload.tripFreeKm, OPEN_TRIP_PRICING.freeKm),
  };
}

/** عدد الدقائق المنقضية منذ بدء العداد (بحد أدنى 0). */
function openTripMinutesSince(startedAtIso, nowMs = Date.now()) {
  const started = Date.parse(String(startedAtIso || ''));
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 60_000));
}

/**
 * حساب أجرة الرحلة المفتوحة.
 * @param {number} km - المسافة المجمّعة بالكيلومتر
 * @param {number} minutes - الدقائق المنقضية
 * @param {Object} pricing - إعدادات { base, perKm, perMin, freeKm } أو حمولة الطلب
 * @returns {number} الأجرة النهائية (لا تقل عن الحد الأدنى)
 */
function computeOpenTripFare({ km = 0, minutes = 0, pricing = OPEN_TRIP_PRICING } = {}) {
  const p = openTripPricing(pricing || {});
  const distance = Math.max(Number(km) || 0, 0);
  const time = Math.max(Number(minutes) || 0, 0);
  const chargeableDistance = Math.max(distance - p.freeKm, 0);
  return Math.max(
    Math.round(p.base + p.perKm * chargeableDistance + p.perMin * time),
    p.base
  );
}

/**
 * أجرة الإكمال النهائية: نفس حساب العداد ثم تقريب للأقرب بخطوة طلب التكسي (افتراضي 250).
 * لا يُستخدم أثناء عرض العداد الحي — فقط عند إنهاء الرحلة.
 */
function finalizeOpenTripFare({
  km = 0,
  minutes = 0,
  pricing = OPEN_TRIP_PRICING,
  roundingStep = 250,
} = {}) {
  const { roundFareToNearestStep } = require('./taxi_pricing_service');
  const raw = computeOpenTripFare({ km, minutes, pricing });
  const step = Number(roundingStep);
  return roundFareToNearestStep(raw, Number.isFinite(step) && step > 0 ? step : 250);
}

/** مسافة هافرسين بين نقطتين بالكيلومتر. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * تجميع مسافة العداد من تحديث موقع جديد.
 * @param {Object} payload - request_payload الحالي
 * @param {number} lat - خط عرض جديد
 * @param {number} lng - خط طول جديد
 * @returns {Object} الحمولة بعد التحديث { tripDistanceKm, tripLastLat, tripLastLng, meterFare }
 */
function accumulateOpenTripMeter(payload = {}, lat, lng) {
  // لا تُجمَّع المسافة قبل بدء العداد (صعد زبون).
  if (!payload.meterStartedAt) return { ...payload };

  const next = { ...payload };
  const currentKm = Number(payload.tripDistanceKm) || 0;
  const prevLat = Number(payload.tripLastLat);
  const prevLng = Number(payload.tripLastLng);
  const newLat = Number(lat);
  const newLng = Number(lng);
  if (!newLat || !newLng) return next;

  let km = currentKm;
  if (prevLat && prevLng && Math.abs(prevLat - newLat) > 0.0000001) {
    km += haversineKm(prevLat, prevLng, newLat, newLng);
  }
  next.tripDistanceKm = Math.round(km * 1000) / 1000;
  next.tripLastLat = newLat;
  next.tripLastLng = newLng;
  const minutes = openTripMinutesSince(payload.meterStartedAt);
  next.meterFare = computeOpenTripFare({
    km: next.tripDistanceKm,
    minutes,
    pricing: openTripPricing(payload),
  });
  return next;
}

module.exports = {
  OPEN_TRIP_PRICING,
  METER_FREE_DISTANCE_KM,
  isOpenTrip,
  openTripPricing,
  openTripMinutesSince,
  computeOpenTripFare,
  finalizeOpenTripFare,
  haversineKm,
  accumulateOpenTripMeter,
};
