/**
 * إعدادات ولاء حيرة — 100 مستوى، نقاط للترقية فقط (لا تُستخدم كخصم).
 */

const MAX_LEVEL = 100;

/** طلب متجر مكتمل = 25 نقطة — المستوى 2 يتطلب 5 طلبات (125 نقطة). */
const ORDERS_REQUIRED_FOR_LEVEL_2 = 5;

/**
 * نقاط تراكمية مطلوبة للوصول إلى مستوى N.
 * منحنى تصاعدي: 125 × (n-1) × n / 2
 * L2=125 (5 طلبات متجر), L10≈5,625, L50≈153,125, L100≈618,750
 */
function minLifetimePointsForLevel(level) {
  const n = Math.max(1, Math.min(MAX_LEVEL, Number(level) || 1));
  if (n <= 1) return 0;
  return Math.floor((125 * (n - 1) * n) / 2);
}

function levelFromLifetimePoints(lifetimePoints) {
  const pts = Math.max(0, Number(lifetimePoints) || 0);
  for (let level = MAX_LEVEL; level >= 1; level -= 1) {
    if (pts >= minLifetimePointsForLevel(level)) return level;
  }
  return 1;
}

function nextLevelProgress(lifetimePoints) {
  const level = levelFromLifetimePoints(lifetimePoints);
  if (level >= MAX_LEVEL) {
    return {
      level,
      maxLevel: MAX_LEVEL,
      currentLevelMin: minLifetimePointsForLevel(level),
      nextLevelMin: null,
      pointsToNext: 0,
      progressRatio: 1,
    };
  }
  const currentMin = minLifetimePointsForLevel(level);
  const nextMin = minLifetimePointsForLevel(level + 1);
  const span = Math.max(1, nextMin - currentMin);
  const inLevel = Math.max(0, lifetimePoints - currentMin);
  return {
    level,
    maxLevel: MAX_LEVEL,
    currentLevelMin: currentMin,
    nextLevelMin: nextMin,
    pointsToNext: Math.max(0, nextMin - lifetimePoints),
    progressRatio: Math.min(1, inLevel / span),
  };
}

/** نقاط تُمنح عند إكمال طلب/رحلة — للترقية فقط. */
const COMPLETION_POINTS = Object.freeze({
  marketplace: 25,
  taxi: 15,
});

/**
 * كوبونات تُمنح عند كل مستوى جديد.
 * كلما ارتفع المستوى → عدد أكبر + نسب خصم أعلى.
 */
function couponGrantsForLevel(level) {
  const grants = [];
  const lv = Number(level) || 0;
  if (lv < 2) return grants;

  const basePercent = Math.min(50, 5 + Math.floor(lv / 4));

  // كل مستوى: كوبون متجر واحد على الأقل
  grants.push({
    discountType: 'percent',
    discountValue: basePercent,
    scope: 'marketplace',
    uses: 1,
    labelAr: `مكافأة المستوى ${lv} — خصم ${basePercent}%`,
  });

  // من المستوى 5+: كوبون إضافي كل مستويين
  if (lv >= 5 && lv % 2 === 0) {
    grants.push({
      discountType: 'percent',
      discountValue: Math.min(45, 8 + Math.floor(lv / 6)),
      scope: 'both',
      uses: 1,
      labelAr: `كوبون إضافي — المستوى ${lv}`,
    });
  }

  // كل 5 مستويات: حزمة (العدد يزيد مع المستوى)
  if (lv % 5 === 0) {
    const packSize = 1 + Math.floor(lv / 20);
    const packPercent = Math.min(55, 10 + Math.floor(lv / 3));
    for (let i = 0; i < packSize; i += 1) {
      grants.push({
        discountType: 'percent',
        discountValue: packPercent,
        scope: 'both',
        uses: 1,
        labelAr: `حزمة المستوى ${lv} — خصم ${packPercent}%`,
      });
    }
  }

  // كل 10 مستويات: كوبونات تاكسي (عدد يتضاعف تدريجياً)
  if (lv % 10 === 0) {
    const taxiCount = 1 + Math.floor(lv / 25);
    const taxiPercent = Math.min(40, 10 + Math.floor(lv / 12));
    for (let i = 0; i < taxiCount; i += 1) {
      grants.push({
        discountType: 'percent',
        discountValue: taxiPercent,
        scope: 'taxi',
        uses: 1,
        labelAr: `خصم تاكسي — المستوى ${lv} (${taxiPercent}%)`,
      });
    }
  }

  // مستويات عليا (50+): مكافأة VIP إضافية
  if (lv >= 50 && lv % 5 === 0) {
    grants.push({
      discountType: 'percent',
      discountValue: Math.min(60, 20 + Math.floor((lv - 50) / 5)),
      scope: 'both',
      uses: 2,
      labelAr: `مكافأة VIP — المستوى ${lv}`,
    });
  }

  return grants;
}

/** الحد الأدنى لاستخدام الكوبونات (وليس لجمع النقاط). */
const MIN_LEVEL_FOR_COUPONS = 2;

module.exports = {
  MAX_LEVEL,
  MIN_LEVEL_FOR_COUPONS,
  ORDERS_REQUIRED_FOR_LEVEL_2,
  COMPLETION_POINTS,
  minLifetimePointsForLevel,
  levelFromLifetimePoints,
  nextLevelProgress,
  couponGrantsForLevel,
};
