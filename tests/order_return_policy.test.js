const {
  goodsInCourierHand,
  applyCustomerCancelReturnPolicy,
} = require('../lib/order_return_policy');

describe('customer cancel during store delivery', () => {
  test('picked up order becomes return_pending and keeps the courier', () => {
    const { order, data } = applyCustomerCancelReturnPolicy({
      order: {
        id: 'o1',
        statusKey: 'cancelled',
        courierPhone: '07700000000',
      },
      previousMeta: {
        statusKey: 'delivering',
        deliveryStatusKey: 'picked_up',
        courierPhone: '07700000000',
      },
      data: { courier_phone: '07700000000' },
      nowIso: () => '2026-08-18T00:00:00.000Z',
    });

    expect(order.statusKey).toBe('return_pending');
    expect(order.deliveryStatusKey).toBe('returning');
    expect(order.courierPhone).toBe('07700000000');
    expect(data.courier_phone).toBe('07700000000');
    expect(goodsInCourierHand('picked_up')).toBe(true);
  });

  test('accepted but not picked up cancels without a return trip', () => {
    const { order, data } = applyCustomerCancelReturnPolicy({
      order: { id: 'o2', statusKey: 'cancelled', courierPhone: '07711111111' },
      previousMeta: {
        statusKey: 'delivering',
        deliveryStatusKey: 'accepted',
        courierPhone: '07711111111',
      },
      data: { courier_phone: '07711111111' },
      nowIso: () => '2026-08-18T00:00:00.000Z',
    });

    expect(order.statusKey).toBe('cancelled');
    expect(order.courierPhone).toBeNull();
    expect(data.courier_phone).toBeNull();
  });

  test('merchant confirm from return_pending marks returned', () => {
    const { order } = applyCustomerCancelReturnPolicy({
      order: {
        id: 'o3',
        statusKey: 'cancelled',
        deliveryStatusKey: 'returned',
      },
      previousMeta: {
        statusKey: 'return_pending',
        deliveryStatusKey: 'returning',
        courierPhone: '07700000000',
      },
      nowIso: () => '2026-08-18T00:00:00.000Z',
    });

    expect(order.returnConfirmedByMerchant).toBe(true);
    expect(order.statusKey).toBe('cancelled');
  });
});
