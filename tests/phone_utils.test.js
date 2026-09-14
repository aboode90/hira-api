'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { getPhoneVariants, canonicalPhone, phonesOverlap, phonesEqual } = require('../supabase_repo/common');
const { normalizeTaxiType } = require('../services/taxi_pricing_service');

test('getPhoneVariants يولد صيغ +964/964/0/أساسية', () => {
  const v = getPhoneVariants('+9647901234567');
  assert.ok(v.includes('+9647901234567'));
  assert.ok(v.includes('9647901234567'));
  assert.ok(v.includes('07901234567'));
  assert.ok(v.includes('7901234567'));
});

test('canonicalPhone يوحّد كل الصيغ إلى +964', () => {
  assert.equal(canonicalPhone('+9647901234567'), '+9647901234567');
  assert.equal(canonicalPhone('9647901234567'), '+9647901234567');
  assert.equal(canonicalPhone('07901234567'), '+9647901234567');
  assert.equal(canonicalPhone('7901234567'), '+9647901234567');
});

test('phonesOverlap يطابق أرقاماً بصيغ مختلفة', () => {
  assert.ok(phonesOverlap('+9647901234567', '07901234567'));
  assert.ok(phonesOverlap('9647901234567', '+9647901234567'));
  assert.ok(phonesOverlap('7901234567', '07701234567') === false);
  assert.ok(phonesOverlap('', '07901234567') === false);
});

test('phonesEqual مطابقة دقيقة مستقلة عن الصيغة', () => {
  assert.ok(phonesEqual('+9647901234567', '07901234567'));
  assert.ok(phonesEqual('9647901234567', '+9647901234567'));
  assert.ok(phonesEqual('07901234567', '07901234567'));
  assert.ok(phonesEqual('07901234567', '07901234568') === false);
});

test('normalizeTaxiType يعيد القيم الصالحة فقط', () => {
  assert.equal(normalizeTaxiType('economic'), 'economic');
  assert.equal(normalizeTaxiType('tuktuk'), 'tuktuk');
  assert.equal(normalizeTaxiType('wazz'), 'wazz');
  assert.equal(normalizeTaxiType('غير معروف'), 'economic');
  assert.equal(normalizeTaxiType(''), 'economic');
});
