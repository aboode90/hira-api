/**
 * Taxi Pricing Service
 *
 * الأسعار تُقرأ من app_configs (قابلة للتعديل بدون تحديث).
 * القيم الافتراضية:
 *   تكتك: حتى 2 كم = 1,000 د.ع، ثم +250 لكل كم إضافي
 *   واز: حتى 2 كم = 1,500 د.ع، ثم +300 لكل كم إضافي
 *   تكسي اقتصادي (يومية حتى 15 كم): حتى 1.5 كم = 2,000 د.ع، ثم +500 لكل كم
 *   ستاركس 11: أجرة الاقتصادي + نسبة قابلة للتعديل (افتراضي +50٪)
 *   ذهاب وعودة ≤ 15 كم: الذهاب + 70٪ عودة
 *   فوق 15 كم: 300 د.ع لكل كم من أول كيلومتر (ذهاب وعودة = الذهاب + 60٪)
 */

const { getTaxiPricing } = require('./app_config_service');

const ECONOMIC_ONLY_DISTANCE_KM = 10;
const DEFAULT_FLAT_KM_RATE_MIN_KM = 15;
const DEFAULT_STARX11_MARKUP_PERCENT = 50;

const _DEFAULTS = {
  tuktuk: { base: 1000, extraKm: 250, min: 1000 },
  wazz: { base: 1500, extraKm: 300, min: 1500 },
  economic: { base: 2000, extraKm: 500, min: 2000, includedKm: 1.5 },
  starx11MarkupPercent: DEFAULT_STARX11_MARKUP_PERCENT,
  includedKm: 2.0,
  longDistanceThresholdKm: 15.0,
  longDistanceExtraKm: 400,
  roundingStep: 250,
  interGovernorateKmRate: 300,
  flatKmRateMinKm: DEFAULT_FLAT_KM_RATE_MIN_KM,
  interGovernorateMinKm: DEFAULT_FLAT_KM_RATE_MIN_KM,
  interGovernorateReturnRate: 0.6,
  localRoundTripReturnRate: 0.7,
  interGovernorateMinOneWayFare: 0,
  interGovernorateMinRoundTripFare: 0,
};

async function _loadPricing() {
  try {
    return await getTaxiPricing();
  } catch (error) {
    const msg = String(error?.message || '');
    console.error('taxi_pricing_service: fallback to defaults:', msg.substring(0, 120));
    return { ..._DEFAULTS };
  }
}

async function _pricing() {
  return await _loadPricing();
}

function normalizeTaxiType(value) {
  const type = String(value || 'economic').trim().toLowerCase();
  if (type === 'tuktuk' || type === 'tuk_tuk') return 'tuktuk';
  if (type === 'wazz') return 'wazz';
  if (type === 'starx11' || type === 'starx') return 'starx11';
  if (type === 'super') return 'economic';
  return type in { tuktuk: 1, wazz: 1, economic: 1, starx11: 1 } ? type : 'economic';
}

function isEconomicOnlyDistance(distanceKm) {
  const distance = Number(distanceKm);
  return Number.isFinite(distance) && distance > ECONOMIC_ONLY_DISTANCE_KM;
}

function isAllowedOnLongDistance(taxiType) {
  const type = normalizeTaxiType(taxiType);
  return type === 'economic' || type === 'starx11';
}

function starx11MarkupPercent(pricing) {
  const raw = Number(pricing?.starx11MarkupPercent);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_STARX11_MARKUP_PERCENT;
}

function applyStarx11Markup(economicFare, pricing) {
  const roundingStep = Number(pricing?.roundingStep) || 250;
  const factor = 1 + starx11MarkupPercent(pricing) / 100;
  const raw = Math.round(Math.max(0, Number(economicFare) || 0) * factor);
  return roundFareToNearestStep(raw, roundingStep);
}

async function fareForType(distanceKm, taxiType, options = {}) {
  const pricing = await _pricing();
  const type = normalizeTaxiType(taxiType);
  const roundingStep = Number(pricing.roundingStep) || 250;
  const safeDistance = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;

  if (type === 'starx11') {
    const economic = await fareForType(distanceKm, 'economic', options);
    return applyStarx11Markup(economic, pricing);
  }

  if (options.interGovernorate && type === 'economic') {
    const rate = Number(pricing.interGovernorateKmRate) || 300;
    const raw = Math.round(safeDistance * rate);
    return roundFareToNearestStep(raw, roundingStep);
  }

  const config = pricing[type] || { base: 2000, extraKm: 500, min: 2000, includedKm: 1.5 };
  const { base, extraKm, min } = config;
  const includedKm = Number(config.includedKm ?? pricing.includedKm) || 2.0;
  const longDistanceThresholdKm = Math.max(
    Number(pricing.longDistanceThresholdKm) || 15,
    includedKm,
  );
  const longDistanceExtraKm = Number(pricing.longDistanceExtraKm) || 400;

  const regularDistance = Math.max(
    Math.min(safeDistance, longDistanceThresholdKm) - includedKm,
    0,
  );
  const longDistance = Math.max(safeDistance - longDistanceThresholdKm, 0);
  const raw =
    base +
    Math.round(regularDistance * extraKm) +
    Math.round(longDistance * longDistanceExtraKm);
  const bounded = Math.max(raw, min);
  return roundFareToNearestStep(bounded, roundingStep);
}

function roundFareToNearestStep(raw, step = 250) {
  const safe = Math.max(0, Math.round(Number(raw) || 0));
  if (safe <= 0) return step;
  return Math.round(safe / step) * step;
}

function _flatKmRateMinKm(pricing, override) {
  const raw = Number(override ?? pricing?.flatKmRateMinKm);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_FLAT_KM_RATE_MIN_KM;
}

async function isInterGovernorateTrip(oneWayDistanceKm, options = {}) {
  if (options.interGovernorate !== undefined && options.interGovernorate !== null) {
    return Boolean(options.interGovernorate);
  }
  if (options.insideCityTrip !== undefined && options.insideCityTrip !== null) {
    return !Boolean(options.insideCityTrip);
  }
  const pricing = await _pricing();
  const minKm = _flatKmRateMinKm(pricing, options.minKm);
  const distance = Number(oneWayDistanceKm);
  return Number.isFinite(distance) && distance > minKm;
}

function applyInterGovernorateRoundTrip(oneWayFare, returnRate, roundingStep) {
  const outbound = Math.max(0, Math.round(Number(oneWayFare) || 0));
  const rate = Number.isFinite(Number(returnRate)) ? Number(returnRate) : 0.6;
  const total = Math.round(outbound * (1 + rate));
  return roundFareToNearestStep(total, roundingStep);
}

function applyLocalRoundTrip(oneWayFare, returnRate, roundingStep) {
  const outbound = Math.max(0, Math.round(Number(oneWayFare) || 0));
  const rate = Number.isFinite(Number(returnRate)) ? Number(returnRate) : 0.7;
  const total = Math.round(outbound * (1 + rate));
  return roundFareToNearestStep(total, roundingStep);
}

async function calculateFare(distanceKm, taxiType = 'economic', tripType = 'one_way', options = {}) {
  const type = normalizeTaxiType(taxiType);
  const interGovernorate = await isInterGovernorateTrip(distanceKm, options);
  const isRoundTrip = tripType === 'round_trip';
  const fareOpts = { interGovernorate };
  const pricing = await _pricing();
  const roundingStep = Number(pricing.roundingStep) || 250;

  if (interGovernorate && isRoundTrip) {
    const returnRate = Number.isFinite(Number(pricing.interGovernorateReturnRate))
      ? Number(pricing.interGovernorateReturnRate)
      : 0.6;
    const oneWay = await fareForType(distanceKm, type, fareOpts);
    const oneWayEconomic = await fareForType(distanceKm, 'economic', fareOpts);
    const fare = applyInterGovernorateRoundTrip(oneWay, returnRate, roundingStep);
    const fareEconomic = applyInterGovernorateRoundTrip(
      oneWayEconomic,
      returnRate,
      roundingStep,
    );
    return { fareEconomic, fareSuper: fare, fare, interGovernorate };
  }

  if (isRoundTrip) {
    const returnRate = Number.isFinite(Number(pricing.localRoundTripReturnRate))
      ? Number(pricing.localRoundTripReturnRate)
      : 0.7;
    const oneWay = await fareForType(distanceKm, type, fareOpts);
    const oneWayEconomic = await fareForType(distanceKm, 'economic', fareOpts);
    const fare = applyLocalRoundTrip(oneWay, returnRate, roundingStep);
    const fareEconomic = applyLocalRoundTrip(oneWayEconomic, returnRate, roundingStep);
    return { fareEconomic, fareSuper: fare, fare, interGovernorate };
  }

  const fare = await fareForType(distanceKm, type, fareOpts);
  const fareEconomic = await fareForType(distanceKm, 'economic', fareOpts);
  return { fareEconomic, fareSuper: fare, fare, interGovernorate };
}

module.exports = {
  calculateFare,
  normalizeTaxiType,
  isEconomicOnlyDistance,
  isAllowedOnLongDistance,
  isInterGovernorateTrip,
  fareForType,
  applyStarx11Markup,
  roundFareToNearestStep,
};
