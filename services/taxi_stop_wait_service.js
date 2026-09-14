/**
 * رسوم الانتظار عند نقطة التوقف.
 *
 * رحلة أقل من 20 كم:
 *   15 دقيقة = 500 د.ع، 30 دقيقة = 1,000 د.ع، وكل ساعة = 4,000 د.ع
 *
 * رحلة 20 كم فأكثر:
 *   أول 4 ساعات مجانية، ثم 4,000 د.ع لكل ساعة إضافية على أجرة الرحلة
 */

const { getTaxiPricing } = require('./app_config_service');

const CITY_STOP_WAIT_OPTIONS = Object.freeze([
  { minutes: 15, extraFare: 500 },
  { minutes: 30, extraFare: 1000 },
  { minutes: 60, extraFare: 4000 },
  { minutes: 120, extraFare: 8000 },
  { minutes: 180, extraFare: 12000 },
  { minutes: 240, extraFare: 16000 },
  { minutes: 300, extraFare: 20000 },
]);

const LONG_TRIP_HOUR_MINUTES = Object.freeze(
  Array.from({ length: 12 }, (_, i) => (i + 1) * 60),
);

const ALL_ALLOWED_MINUTES = Object.freeze([
  ...new Set([
    ...CITY_STOP_WAIT_OPTIONS.map((row) => row.minutes),
    ...LONG_TRIP_HOUR_MINUTES,
  ]),
].sort((a, b) => a - b));

const DEFAULTS = {
  longTripWaitMinKm: 20,
  longTripWaitFreeHours: 4,
  longTripWaitHourlyFee: 4000,
};

function _num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function longTripWaitConfig(pricing = {}) {
  return {
    minKm: _num(pricing.longTripWaitMinKm, DEFAULTS.longTripWaitMinKm),
    freeHours: _num(pricing.longTripWaitFreeHours, DEFAULTS.longTripWaitFreeHours),
    hourlyFee: _num(pricing.longTripWaitHourlyFee, DEFAULTS.longTripWaitHourlyFee),
  };
}

function isLongTripWait(distanceKm, pricing = {}) {
  const distance = Number(distanceKm);
  const { minKm } = longTripWaitConfig(pricing);
  return Number.isFinite(distance) && distance >= minKm;
}

function normalizeStopWaitMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return ALL_ALLOWED_MINUTES.includes(minutes) ? minutes : null;
}

function _cityFee(minutes) {
  const match = CITY_STOP_WAIT_OPTIONS.find((option) => option.minutes === minutes);
  return match ? match.extraFare : 0;
}

function _longTripFee(minutes, pricing = {}) {
  const { freeHours, hourlyFee } = longTripWaitConfig(pricing);
  const hours = Math.floor(minutes / 60);
  const extraHours = Math.max(0, hours - freeHours);
  return extraHours * hourlyFee;
}

function stopWaitFeeSync(minutes, distanceKm = 0, pricing = {}) {
  const normalized = normalizeStopWaitMinutes(minutes);
  if (!normalized) return 0;
  if (isLongTripWait(distanceKm, pricing)) {
    return _longTripFee(normalized, pricing);
  }
  return _cityFee(normalized);
}

async function stopWaitFee(minutes, distanceKm = 0) {
  let pricing = {};
  try {
    pricing = await getTaxiPricing();
  } catch (_) {
    pricing = {};
  }
  return stopWaitFeeSync(minutes, distanceKm, pricing);
}

module.exports = {
  CITY_STOP_WAIT_OPTIONS,
  STOP_WAIT_OPTIONS: CITY_STOP_WAIT_OPTIONS,
  ALL_ALLOWED_MINUTES,
  DEFAULTS,
  normalizeStopWaitMinutes,
  isLongTripWait,
  stopWaitFeeSync,
  stopWaitFee,
};
