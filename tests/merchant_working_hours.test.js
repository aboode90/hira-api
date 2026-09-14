'use strict';
const test = require('node:test');
const assert = require('node:assert');

const hours = require('../services/merchant_working_hours');

function atHour(hour, minute = 0) {
  const d = hours.nowInBaghdad();
  d.setHours(hour, minute, 0, 0);
  return d;
}

test('بعد الساعة 1 صباحاً المنصة مغلقة للطلبات', () => {
  assert.equal(hours.isPlatformNightClosed(atHour(1, 0)), true);
  assert.equal(hours.isPlatformNightClosed(atHour(3, 30)), true);
  assert.equal(hours.isPlatformNightClosed(atHour(8, 59)), true);
});

test('قبل 1 صباحاً وبعد 9 صباحاً المنصة مفتوحة', () => {
  assert.equal(hours.isPlatformNightClosed(atHour(0, 59)), false);
  assert.equal(hours.isPlatformNightClosed(atHour(9, 0)), false);
  assert.equal(hours.isPlatformNightClosed(atHour(12, 0)), false);
  assert.equal(hours.isPlatformNightClosed(atHour(23, 30)), false);
});

test('رسالة الإغلاق تظهر للزبون بعد الساعة 1', () => {
  const result = hours.merchantAcceptsCustomerCalls({}, atHour(1, 15));
  assert.equal(result.allowed, false);
  assert.equal(result.messageAr, hours.PLATFORM_NIGHT_CLOSED_MESSAGE_AR);
});

test('الطلبات تُرفض إذا المتجر مغلق يدوياً', () => {
  const result = hours.merchantAcceptsCustomerOrders(
    { is_open: false, open_time: '09:00', close_time: '22:00' },
    atHour(12, 0),
  );
  assert.equal(result.allowed, false);
  assert.match(result.messageAr, /مغلق حالياً/);
});

test('الطلبات تُرفض خارج ساعات عمل التاجر', () => {
  const result = hours.merchantAcceptsCustomerOrders(
    { is_open: true, open_time: '09:00', close_time: '17:00' },
    atHour(20, 0),
  );
  assert.equal(result.allowed, false);
  assert.match(result.messageAr, /انتهى وقت الدوام/);
  assert.match(result.messageAr, /لا يمكن الطلب/);
});

test('الطلبات مسموحة ضمن ساعات عمل التاجر', () => {
  const result = hours.merchantAcceptsCustomerOrders(
    { is_open: true, open_time: '09:00', close_time: '22:00' },
    atHour(14, 30),
  );
  assert.equal(result.allowed, true);
});

test('الطلبات تُرفض خارج ورديات الطبيب', () => {
  const result = hours.merchantAcceptsCustomerOrders(
    {
      is_open: true,
      professional_info: {
        morning_open_time: '09:00',
        morning_close_time: '13:00',
        evening_open_time: '16:00',
        evening_close_time: '20:00',
      },
    },
    atHour(14, 0),
  );
  assert.equal(result.allowed, false);
  assert.match(result.messageAr, /انتهى وقت الدوام/);
});

test('الطلبات مسموحة ضمن وردية الطبيب', () => {
  const result = hours.merchantAcceptsCustomerOrders(
    {
      is_open: true,
      professional_info: {
        morning_open_time: '09:00',
        morning_close_time: '13:00',
        evening_open_time: '16:00',
        evening_close_time: '20:00',
      },
    },
    atHour(10, 30),
  );
  assert.equal(result.allowed, true);
});
