// سابقاً كان الكابتن لا يرى توصيل المتجر إلا إذا كانت الأجرة ≥ 2000 د.ع.
// أُلغي الشرط: كل طلب توصيل داخل التطبيق يُعرض على المندوبين والكباتن معاً.
const DRIVER_DELIVERY_MIN_FEE_IQD = 0;

function readDeliveryFeeIqd(source) {
  const payload = source?.payload || source || {};
  const explicit = Number(payload.deliveryFeeIqd ?? payload.delivery_fee_iqd ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

  const note = `${String(payload.noteAr ?? '')}\n${String(payload.noteEn ?? '')}`;
  const match = note.match(/(?:رسوم التوصيل|Delivery fee)\s*:\s*(\d+)/i);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

function isDriverDeliveryEligible(_source) {
  return true;
}

function normalizeCourierMode(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'private' || value === 'خاص' || value === 'مندوب_خاص') {
    return 'private';
  }
  return 'public';
}

function resolveEffectiveCourierMode(metaOrPayload) {
  const payload =
    metaOrPayload?.payload && typeof metaOrPayload.payload === 'object'
      ? metaOrPayload.payload
      : metaOrPayload || {};
  return normalizeCourierMode(
    payload.courierModeEffective ??
      payload.courier_mode_effective ??
      payload.courierMode ??
      payload.courier_mode,
  );
}

/**
 * هل يحق للمندوب/الكابتن رؤية أو قبول طلب التوصيل حسب وضع التاجر؟
 * public: أي مندوب نشط أو كابتن مؤهل (السلوك الحالي).
 * private: فقط مندوبين/كابتن مربوطين ومعتمدين تحت ذلك المتجر — بدون تصعيد زمني.
 */
async function canActorTakeDeliveryOrder(actor, meta, deps = {}) {
  if (!actor?.active) return false;

  const mode = resolveEffectiveCourierMode(meta);
  if (mode !== 'private') {
    if (actor.role === 'delivery') return true;
    return actor.role === 'driver' && isDriverDeliveryEligible(meta);
  }

  const merchantPhone = String(
    meta?.merchantPhone ||
      meta?.payload?.merchantPhone ||
      meta?.payload?.merchant_phone ||
      '',
  ).trim();
  if (!merchantPhone || !actor.phone) return false;

  const checker =
    deps.isApprovedMerchantCourier ||
    require('../supabase_repo/merchant_couriers').isApprovedMerchantCourier;
  try {
    return Boolean(await checker(merchantPhone, actor.phone));
  } catch (error) {
    console.error('private courier eligibility error:', error?.message || error);
    return false;
  }
}

module.exports = {
  DRIVER_DELIVERY_MIN_FEE_IQD,
  readDeliveryFeeIqd,
  isDriverDeliveryEligible,
  normalizeCourierMode,
  resolveEffectiveCourierMode,
  canActorTakeDeliveryOrder,
};
