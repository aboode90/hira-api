const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'loyalty');

function cleanup(phone) {
  const files = [
    path.join(DATA_DIR, 'profiles', `${phone}.json`),
    path.join(DATA_DIR, 'coupons', `${phone}.json`),
    path.join(DATA_DIR, 'ledger', `${phone}.json`),
  ];
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch (_) {}
  }
}

const {
  getProfile,
  awardOrderCompletion,
  adminAssignCoupon,
  validateCouponForCheckout,
  MIN_LEVEL_FOR_COUPONS,
} = require('../services/loyalty/loyalty_service');
const {
  levelFromLifetimePoints,
  MAX_LEVEL,
  couponGrantsForLevel,
} = require('../services/loyalty/loyalty_config');

test('loyalty level increases with completed orders', () => {
  const phone = '07700000001';
  cleanup(phone);
  for (let i = 0; i < 4; i += 1) {
    awardOrderCompletion(phone, 'marketplace', `order-${i}`);
  }
  let profile = getProfile(phone);
  assert.equal(profile.completedMarketplace, 4);
  assert.equal(profile.lifetimePoints, 100);
  assert.equal(profile.level, 1);

  awardOrderCompletion(phone, 'marketplace', 'order-4');
  profile = getProfile(phone);
  assert.equal(profile.completedMarketplace, 5);
  assert.equal(profile.lifetimePoints, 125);
  assert.equal(profile.level, 2);
  assert.equal(profile.pointsPurpose, 'level_only');
  cleanup(phone);
});

test('coupon requires minimum level', () => {
  const phone = '07700000002';
  cleanup(phone);
  adminAssignCoupon(phone, { code: 'HIRA-TEST', discountValue: 20 });
  const blocked = validateCouponForCheckout(phone, 'HIRA-TEST', 10000, 'marketplace');
  assert.equal(blocked.valid, false);
  assert.ok(blocked.messageAr.includes(String(MIN_LEVEL_FOR_COUPONS)));

  for (let i = 0; i < 5; i += 1) {
    awardOrderCompletion(phone, 'marketplace', `o-${i}`);
  }
  const ok = validateCouponForCheckout(phone, 'HIRA-TEST', 10000, 'marketplace');
  assert.equal(ok.valid, true);
  assert.equal(ok.discountAmountIqd, 2000);
  assert.equal(ok.platformFeeWaived, true);
  cleanup(phone);
});

test('level curve supports 100 levels (L2 = 5 marketplace orders)', () => {
  assert.equal(MAX_LEVEL, 100);
  assert.equal(levelFromLifetimePoints(0), 1);
  assert.equal(levelFromLifetimePoints(124), 1);
  assert.equal(levelFromLifetimePoints(125), 2);
  assert.equal(levelFromLifetimePoints(618750), 100);
});

test('higher levels grant more coupons', () => {
  const low = couponGrantsForLevel(4).length;
  const mid = couponGrantsForLevel(20).length;
  const high = couponGrantsForLevel(50).length;
  assert.ok(mid > low);
  assert.ok(high > mid);
});
