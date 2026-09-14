const { randomUUID } = require('crypto');
const {
  MAX_LEVEL,
  MIN_LEVEL_FOR_COUPONS,
  COMPLETION_POINTS,
  levelFromLifetimePoints,
  nextLevelProgress,
  couponGrantsForLevel,
} = require('./loyalty_config');
const localStore = require('./loyalty_local_store');
const { isConfigured: isSupabaseConfigured } = require('../../supabase_repo/common');

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function calculateDiscount(coupon, subtotalIqd) {
  const subtotal = Math.max(0, Number(subtotalIqd) || 0);
  if (!coupon || subtotal <= 0) return 0;
  const minSubtotal = Number(coupon.minSubtotalIqd) || 0;
  if (subtotal < minSubtotal) return 0;

  let discount =
    coupon.discountType === 'fixed'
      ? Number(coupon.discountValue) || 0
      : Math.round((subtotal * (Number(coupon.discountValue) || 0)) / 100);
  const maxDiscount = coupon.maxDiscountIqd;
  if (maxDiscount != null && maxDiscount > 0) {
    discount = Math.min(discount, maxDiscount);
  }
  return Math.max(0, Math.min(discount, subtotal));
}

function buildCouponCode(prefix, level) {
  return `${prefix}${level}${randomUUID().slice(0, 4).toUpperCase()}`;
}

function grantLevelCoupons(phone, level) {
  const grants = couponGrantsForLevel(level);
  const created = [];
  for (const grant of grants) {
    for (let i = 0; i < (grant.uses || 1); i += 1) {
      const row = localStore.addCoupon(phone, {
        code: buildCouponCode('HIRA', level),
        labelAr: grant.labelAr,
        discountType: grant.discountType,
        discountValue: grant.discountValue,
        scope: grant.scope || 'marketplace',
        minSubtotalIqd: 3000,
        maxDiscountIqd: grant.discountValue >= 30 ? 50000 : 25000,
        grantedLevel: level,
        usesLeft: 1,
      });
      created.push(row);
    }
  }
  return created;
}

function getProfile(phone) {
  const profile = localStore.getProfile(phone);
  const progress = nextLevelProgress(profile.lifetimePoints || 0);
  profile.level = progress.level;
  return {
    phone: profile.phone,
    level: profile.level,
    maxLevel: MAX_LEVEL,
    lifetimePoints: profile.lifetimePoints || 0,
    /** النقاط للترقية فقط — لا تُخصم من الطلبات. */
    pointsPurpose: 'level_only',
    completedMarketplace: profile.completedMarketplace || 0,
    completedTaxi: profile.completedTaxi || 0,
    completedTotal:
      (profile.completedMarketplace || 0) + (profile.completedTaxi || 0),
    couponsUnlocked: profile.level >= MIN_LEVEL_FOR_COUPONS,
    progress,
    updatedAt: profile.updatedAt,
  };
}

function listCustomerCoupons(phone) {
  const profile = getProfile(phone);
  const coupons = localStore
    .listCoupons(phone)
    .filter((c) => (c.usesLeft ?? 0) > 0)
    .map((c) => ({
      id: c.id,
      code: c.code,
      labelAr: c.labelAr || `خصم ${c.discountValue}%`,
      discountType: c.discountType,
      discountValue: c.discountValue,
      scope: c.scope || 'marketplace',
      usesLeft: c.usesLeft ?? 1,
      grantedLevel: c.grantedLevel ?? null,
      expiresAt: c.expiresAt ?? null,
    }));
  return {
    profile,
    coupons,
    canUseCoupons: profile.level >= MIN_LEVEL_FOR_COUPONS,
  };
}

function validateCouponForCheckout(phone, code, subtotalIqd, scope = 'marketplace') {
  const profile = getProfile(phone);
  if (profile.level < MIN_LEVEL_FOR_COUPONS) {
    return {
      valid: false,
      messageAr: `استخدام الكوبونات يتطلب الوصول للمستوى ${MIN_LEVEL_FOR_COUPONS}.`,
    };
  }

  const coupon = localStore.findCoupon(phone, code);
  if (!coupon) {
    return {
      valid: false,
      messageAr: 'الكوبون غير متاح أو منتهي.',
    };
  }

  const couponScope = String(coupon.scope || 'marketplace');
  if (couponScope !== 'both' && couponScope !== scope) {
    return {
      valid: false,
      messageAr: 'هذا الكوبون لا ينطبق على هذا النوع من الطلبات.',
    };
  }

  const discountAmountIqd = calculateDiscount(coupon, subtotalIqd);
  if (discountAmountIqd <= 0) {
    return {
      valid: false,
      messageAr: 'لا يمكن تطبيق هذا الكوبون على المبلغ الحالي.',
    };
  }

  return {
    valid: true,
    couponId: coupon.id,
    code: coupon.code,
    labelAr: coupon.labelAr || `خصم ${coupon.discountValue}%`,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discountAmountIqd,
    platformFeeWaived: true,
    platformFeeWaivedPercent: 100,
    messageAr: 'تم التحقق من الكوبون.',
  };
}

function redeemCoupon(phone, couponId, context = {}) {
  const coupon = localStore.consumeCoupon(phone, couponId);
  if (!coupon) {
    throw new Error('الكوبون غير صالح أو مستخدم.');
  }
  localStore.appendLedger(phone, {
    type: 'coupon_redeemed',
    couponId,
    orderId: context.orderId || null,
    taxiRequestId: context.taxiRequestId || null,
    discountIqd: context.discountIqd || 0,
    at: new Date().toISOString(),
  });
  return coupon;
}

function awardOrderCompletion(phone, type, referenceId) {
  const normalizedPhone = String(phone || '').trim();
  if (!normalizedPhone) return null;

  const profile = localStore.getProfile(normalizedPhone);
  const completionKey =
    type === 'taxi' ? 'completedTaxi' : 'completedMarketplace';
  profile[completionKey] = (profile[completionKey] || 0) + 1;

  const points = COMPLETION_POINTS[type] || COMPLETION_POINTS.marketplace;
  profile.lifetimePoints = (profile.lifetimePoints || 0) + points;
  profile.updatedAt = new Date().toISOString();

  const previousLevel = profile.level || 1;
  const newLevel = levelFromLifetimePoints(profile.lifetimePoints);
  profile.level = newLevel;

  localStore.saveProfile(profile);
  localStore.appendLedger(normalizedPhone, {
    type: 'points_earned',
    delta: points,
    balanceAfter: profile.lifetimePoints,
    reason: type === 'taxi' ? 'taxi_completed' : 'marketplace_completed',
    referenceId,
    at: profile.updatedAt,
  });

  const levelUpCoupons = [];
  if (newLevel > previousLevel) {
    for (let lv = previousLevel + 1; lv <= newLevel; lv += 1) {
      levelUpCoupons.push(...grantLevelCoupons(normalizedPhone, lv));
    }
  }

  const levelUp = newLevel > previousLevel;
  void require('./loyalty_notifications')
    .notifyLoyaltyPointsAwarded({
      phone: normalizedPhone,
      points,
      type,
      referenceId,
      levelUp,
      newLevel,
      lifetimePoints: profile.lifetimePoints,
    })
    .catch((error) => {
      console.error('loyalty notify error:', error?.message || error);
    });

  return {
    profile: getProfile(normalizedPhone),
    pointsAwarded: points,
    levelUp,
    previousLevel,
    newLevel,
    couponsGranted: levelUpCoupons.length,
  };
}

/** إنشاء كوبون إداري لمستخدمين محددين (محلي — لحين لوحة الإدارة). */
function adminAssignCoupon(phone, payload = {}) {
  const row = localStore.addCoupon(phone, {
    code: normalizeCode(payload.code) || buildCouponCode('HIRA', 'X'),
    labelAr: payload.labelAr || 'كوبون حيرة',
    discountType: payload.discountType || 'percent',
    discountValue: Number(payload.discountValue) || 10,
    scope: payload.scope || 'marketplace',
    minSubtotalIqd: Number(payload.minSubtotalIqd) || 3000,
    maxDiscountIqd: payload.maxDiscountIqd ?? 50000,
    usesLeft: Number(payload.usesLeft) || 1,
    grantedLevel: null,
  });
  return row;
}

module.exports = {
  isSupabaseConfigured,
  getProfile,
  listCustomerCoupons,
  validateCouponForCheckout,
  redeemCoupon,
  awardOrderCompletion,
  adminAssignCoupon,
  calculateDiscount,
  MIN_LEVEL_FOR_COUPONS,
};
