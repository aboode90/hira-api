'use strict';
const test = require('node:test');
const assert = require('node:assert');

const pricing = require('../services/taxi_pricing_service');

test('calculateFare يحسب أجرة اقتصادية أساسية', async () => {
  const fare = await pricing.calculateFare(3, 'economic', 'one_way');
  assert.ok(fare.fare > 0, 'fare يجب أن يكون موجباً');
  assert.ok(fare.fareEconomic > 0);
  assert.ok(fare.fareSuper > 0);
  // اقتصادي ≤ عادي ≤ سوبر
  assert.ok(fare.fareEconomic <= fare.fare);
  assert.ok(fare.fare <= fare.fareSuper);
});

test('calculateFare المسافة الأطول أجرة أعلى', async () => {
  const short = await pricing.calculateFare(2, 'economic', 'one_way');
  const long = await pricing.calculateFare(8, 'economic', 'one_way');
  assert.ok(long.fare > short.fare, 'المسافة الأطول يجب أن ترفع الأجرة');
});

test('normalizeTaxiType يعيد الاقتصادي للقيم غير الصالحة', () => {
  assert.equal(pricing.normalizeTaxiType('economic'), 'economic');
  assert.equal(pricing.normalizeTaxiType('tuktuk'), 'tuktuk');
  assert.equal(pricing.normalizeTaxiType('xyz'), 'economic');
  assert.equal(pricing.normalizeTaxiType(undefined), 'economic');
});

test('أجرة المحافظات 300 د.ع/كم للصويرة → كربلاء', async () => {
  const opts = {
    pickupAddress: 'الصويرة، محافظة واسط',
    dropoffAddress: 'شارع باب بغداد، كربلاء',
    pickupLat: 32.948441,
    pickupLng: 44.777220,
    dropoffLat: 32.621012,
    dropoffLng: 44.038816,
  };
  const one = await pricing.calculateFare(93.5, 'economic', 'one_way', opts);
  const round = await pricing.calculateFare(93.5, 'economic', 'round_trip', opts);
  assert.equal(one.interGovernorate, true);
  assert.equal(one.fare, 28000);
  assert.equal(round.fare, 44750);
});

test('تسعيرة المحافظات حسب الكم بدون حد أدنى وطني', async () => {
  const opts = {
    pickupAddress: 'الصويرة، محافظة واسط',
    dropoffAddress: 'بغداد',
    pickupLat: 32.948441,
    pickupLng: 44.777220,
    dropoffLat: 33.315241,
    dropoffLng: 44.366067,
  };
  const one = await pricing.calculateFare(63, 'economic', 'one_way', opts);
  const round = await pricing.calculateFare(63, 'economic', 'round_trip', opts);
  assert.equal(one.interGovernorate, true);
  assert.equal(one.fare, 19000);
  assert.equal(round.fare, 30500);
});

test('الرحلات الأطول بين المحافظات تتجاوز الحد الأدنى حسب الكم', async () => {
  const opts = {
    pickupAddress: 'البصرة',
    dropoffAddress: 'بغداد',
  };
  const one = await pricing.calculateFare(150, 'economic', 'one_way', opts);
  const round = await pricing.calculateFare(150, 'economic', 'round_trip', opts);
  assert.equal(one.interGovernorate, true);
  assert.equal(one.fare, 45000);
  assert.equal(round.fare, 72000);
});

test('فوق 15 كم يحسب 300 د.ع من أول كم حتى داخل نفس المحافظة', async () => {
  const opts = {
    pickupAddress: 'الصويرة، محافظة واسط',
    dropoffAddress: 'الكوت، محافظة واسط',
  };
  const long = await pricing.calculateFare(35, 'economic', 'one_way', opts);
  const round = await pricing.calculateFare(35, 'economic', 'round_trip', opts);
  assert.equal(long.interGovernorate, true);
  assert.equal(long.fare, 10500);
  assert.equal(round.fare, 16750);
});

test('15 كم تبقى على تسعيرة المدينة', async () => {
  const city13 = await pricing.calculateFare(13, 'economic', 'one_way');
  assert.equal(city13.interGovernorate, false);
  assert.equal(city13.fare, 7750);
  const city15 = await pricing.calculateFare(15, 'economic', 'one_way');
  assert.equal(city15.interGovernorate, false);
  assert.equal(city15.fare, 8750);
});

test('المسافة القصيرة لا تستخدم تسعيرة المحافظات', async () => {
  const opts = {
    pickupAddress: 'الصويرة، واسط',
    dropoffAddress: 'كربلاء',
  };
  const short = await pricing.calculateFare(8, 'economic', 'one_way', opts);
  assert.equal(short.interGovernorate, false);
  assert.equal(short.fare, 5250);
});

test('insideCityTrip يفرض تسعيرة المدينة حتى فوق 15 كم', async () => {
  const forcedCity = await pricing.calculateFare(35, 'economic', 'one_way', {
    insideCityTrip: true,
  });
  assert.equal(forcedCity.interGovernorate, false);
  assert.equal(forcedCity.fare, 16750);
});

test('خارج المدينة يفرض تسعيرة المسافات الطويلة حتى تحت 15 كم', async () => {
  const forcedOutside = await pricing.calculateFare(8, 'economic', 'one_way', {
    insideCityTrip: false,
  });
  assert.equal(forcedOutside.interGovernorate, true);
  assert.equal(forcedOutside.fare, 2500);
});

test('ذهاب وعودة قصيرة ≤ 15 كم = الذهاب + 70٪', async () => {
  const one = await pricing.calculateFare(8, 'economic', 'one_way');
  const round = await pricing.calculateFare(8, 'economic', 'round_trip');
  assert.equal(one.interGovernorate, false);
  assert.equal(one.fare, 5250);
  // 5250 * 1.7 = 8925 → تقريب لأقرب 250 = 9000
  assert.equal(round.fare, 9000);
});
