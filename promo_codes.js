const PROMO_DEFINITIONS = [
  {
    code: 'HIRA20',
    discountType: 'percent',
    discountValue: 20,
    labelAr: 'خصم 20%',
    labelEn: 'Hira 20% off',
    minSubtotalIqd: 5000,
    maxDiscountIqd: 50000,
    active: true,
  },
];

function normalizePromoCode(code) {
  return String(code || '').trim().toUpperCase();
}

function calculatePromoDiscount(promo, subtotalIqd) {
  const subtotal = Math.max(0, Number(subtotalIqd) || 0);
  if (!promo || subtotal <= 0) {
    return 0;
  }
  let discount =
    promo.discountType === 'fixed'
      ? Number(promo.discountValue) || 0
      : Math.round((subtotal * (Number(promo.discountValue) || 0)) / 100);
  if (promo.maxDiscountIqd != null) {
    discount = Math.min(discount, Number(promo.maxDiscountIqd) || 0);
  }
  return Math.max(0, Math.min(discount, subtotal));
}

/**
 * @typedef {Object} PromoResult
 * @property {boolean} valid
 * @property {string} [messageAr]
 * @property {string} [messageEn]
 * @property {string} [code]
 * @property {string} [discountType]
 * @property {number} [discountValue]
 * @property {number} [discountAmountIqd]
 */

/**
 * @param {string} code
 * @param {number} subtotalIqd
 * @returns {PromoResult}
 */
function validatePromoCode(code, subtotalIqd) {
  const normalized = normalizePromoCode(code);
  if (!normalized) {
    return {
      valid: false,
      messageAr: 'يرجى إدخال كود الخصم.',
      messageEn: 'Please enter a promo code.',
    };
  }

  const promo = PROMO_DEFINITIONS.find(
    (entry) => entry.code === normalized && entry.active !== false
  );
  if (!promo) {
    return {
      valid: false,
      messageAr: 'كود الخصم غير صحيح أو منتهي.',
      messageEn: 'Promo code is invalid or expired.',
    };
  }

  const subtotal = Math.max(0, Number(subtotalIqd) || 0);
  const minSubtotal = Number(promo.minSubtotalIqd) || 0;
  if (subtotal < minSubtotal) {
    return {
      valid: false,
      messageAr: `الحد الأدنى لتطبيق هذا الكود ${minSubtotal.toLocaleString('en-US')} د.ع.`,
      messageEn: `Minimum order for this code is ${minSubtotal} IQD.`,
    };
  }

  const discountAmountIqd = calculatePromoDiscount(promo, subtotal);
  if (discountAmountIqd <= 0) {
    return {
      valid: false,
      messageAr: 'لا يمكن تطبيق هذا الكود على السلة الحالية.',
      messageEn: 'This promo cannot be applied to the current cart.',
    };
  }

  return {
    valid: true,
    code: promo.code,
    labelAr: promo.labelAr,
    labelEn: promo.labelEn,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    minSubtotalIqd: minSubtotal,
    maxDiscountIqd: promo.maxDiscountIqd ?? null,
    discountAmountIqd,
  };
}

module.exports = {
  validatePromoCode,
  calculatePromoDiscount,
};
