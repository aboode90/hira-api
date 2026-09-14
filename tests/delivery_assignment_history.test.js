'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  END_REASONS,
  normalizeHistory,
  recordDeliveryAcceptance,
  recordDeliveryAssignmentEnd,
} = require('../lib/delivery_assignment_history');
const { applyCustomerCancelReturnPolicy } = require('../lib/order_return_policy');

test('records acceptance and end reason when assignee cancels', () => {
  let payload = recordDeliveryAcceptance({}, {
    phone: '+9647761913430',
    name: 'حيدر',
    role: 'driver',
    source: 'self',
    at: '2026-08-28T11:00:00.000Z',
  });

  assert.equal(normalizeHistory(payload).length, 1);
  assert.equal(payload.deliveryAssignmentHistory[0].endedAt, null);

  payload = recordDeliveryAssignmentEnd(payload, {
    phone: '+9647761913430',
    reason: END_REASONS.CANCELLED_BY_ASSIGNEE,
    at: '2026-08-28T11:30:00.000Z',
  });

  assert.equal(payload.deliveryAssignmentHistory[0].endedAt, '2026-08-28T11:30:00.000Z');
  assert.equal(
    payload.deliveryAssignmentHistory[0].endReason,
    END_REASONS.CANCELLED_BY_ASSIGNEE,
  );
});

test('customer cancel before pickup records history end', () => {
  const previousPayload = recordDeliveryAcceptance({}, {
    phone: '+9647711111111',
    name: 'مندوب',
    role: 'delivery',
    at: '2026-08-28T10:00:00.000Z',
  });

  const { order } = applyCustomerCancelReturnPolicy({
    order: {
      ...previousPayload,
      statusKey: 'cancelled',
      courierPhone: '+9647711111111',
    },
    previousMeta: {
      statusKey: 'delivering',
      deliveryStatusKey: 'accepted',
      courierPhone: '+9647711111111',
      payload: previousPayload,
    },
    data: { courier_phone: '+9647711111111' },
    nowIso: () => '2026-08-28T12:00:00.000Z',
  });

  assert.equal(order.courierPhone, null);
  assert.equal(order.deliveryAssignmentHistory.length, 1);
  assert.equal(order.deliveryAssignmentHistory[0].endedAt, '2026-08-28T12:00:00.000Z');
  assert.equal(order.deliveryAssignmentHistory[0].endReason, END_REASONS.CUSTOMER_CANCELLED);
});

test('customer cancel merges history from previous order payload', () => {
  const previousPayload = recordDeliveryAcceptance({}, {
    phone: '+9647722222222',
    name: 'كابتن',
    role: 'driver',
    at: '2026-08-28T09:00:00.000Z',
  });

  const { order } = applyCustomerCancelReturnPolicy({
    order: {
      statusKey: 'cancelled',
      courierPhone: '+9647722222222',
    },
    previousMeta: {
      statusKey: 'delivering',
      deliveryStatusKey: 'accepted',
      courierPhone: '+9647722222222',
      payload: previousPayload,
    },
    data: { courier_phone: '+9647722222222' },
    nowIso: () => '2026-08-28T12:30:00.000Z',
  });

  assert.equal(order.deliveryAssignmentHistory.length, 1);
  assert.equal(order.deliveryAssignmentHistory[0].name, 'كابتن');
  assert.equal(order.deliveryAssignmentHistory[0].endedAt, '2026-08-28T12:30:00.000Z');
});
