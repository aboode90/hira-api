'use strict';
const test = require('node:test');
const assert = require('node:assert');

const wait = require('../services/taxi_stop_wait_service');

test('رحلة قصيرة تبقي رسوم الانتظار القديمة', () => {
  assert.equal(wait.stopWaitFeeSync(15, 8), 500);
  assert.equal(wait.stopWaitFeeSync(60, 12), 4000);
  assert.equal(wait.stopWaitFeeSync(240, 19.9), 16000);
});

test('رحلة 20 كم فأكثر: أول 4 ساعات مجانية', () => {
  assert.equal(wait.stopWaitFeeSync(15, 20), 0);
  assert.equal(wait.stopWaitFeeSync(60, 20), 0);
  assert.equal(wait.stopWaitFeeSync(180, 35), 0);
  assert.equal(wait.stopWaitFeeSync(240, 35), 0);
});

test('رحلة 20 كم فأكثر: كل ساعة بعد 4 ساعات = 4000', () => {
  assert.equal(wait.stopWaitFeeSync(300, 20), 4000);
  assert.equal(wait.stopWaitFeeSync(360, 35), 8000);
  assert.equal(wait.stopWaitFeeSync(720, 50), 32000);
});
