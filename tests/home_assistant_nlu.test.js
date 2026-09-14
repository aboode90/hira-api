'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { parseAssistantUtterance, detectIntent } = require('../services/home_assistant_nlu');

test('detectIntent يفهم وديني للمطعم كطلب أكل', () => {
  assert.equal(detectIntent('وديني للمطعم'), 'food');
});

test('detectIntent يفهم خذني للسوق كتكسي', () => {
  assert.equal(detectIntent('خذني للسوق'), 'taxi');
});

test('تدفق تكسي كامل من جملة واحدة', () => {
  const result = parseAssistantUtterance('تكسي داخل المدينة من موقعي', {});
  assert.equal(result.step, null);
  assert.equal(result.action?.type, 'open_taxi');
  assert.equal(result.action?.params?.insideCityTrip, true);
  assert.equal(result.action?.params?.autoPickupFromCurrentLocation, true);
});

test('تأكيد داخل المدينة قبل المتابعة', () => {
  const first = parseAssistantUtterance('أريد تكسي داخل المدينة', {});
  assert.ok(first.reply.includes('هل تقصد'));
  const confirmed = parseAssistantUtterance('نعم', first.session);
  assert.equal(confirmed.step, 'taxi_pickup');
});

test('تكرار آخر طلب يحتاج تأكيد', () => {
  const done = parseAssistantUtterance('أريد تسوق', {});
  assert.equal(done.action?.type, 'open_shopping');
  const repeat = parseAssistantUtterance('نفس الشي', done.session);
  assert.ok(repeat.reply.includes('تكرار'));
  const confirmed = parseAssistantUtterance('نعم', repeat.session);
  assert.equal(confirmed.action?.type, 'open_shopping');
});
