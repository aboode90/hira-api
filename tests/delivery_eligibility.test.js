const {
  readDeliveryFeeIqd,
  isDriverDeliveryEligible,
} = require('../lib/delivery_eligibility');

describe('store delivery eligibility for taxi drivers', () => {
  test('all in-app delivery orders are eligible regardless of fee', () => {
    expect(isDriverDeliveryEligible({ payload: { deliveryFeeIqd: 0 } })).toBe(
      true,
    );
    expect(isDriverDeliveryEligible({ payload: { deliveryFeeIqd: 500 } })).toBe(
      true,
    );
    expect(isDriverDeliveryEligible({ payload: { deliveryFeeIqd: 2000 } })).toBe(
      true,
    );
  });

  test('reads legacy Arabic and English delivery fee notes', () => {
    expect(readDeliveryFeeIqd({ noteAr: 'رسوم التوصيل: 2500' })).toBe(2500);
    expect(readDeliveryFeeIqd({ noteEn: 'Delivery fee: 1800' })).toBe(1800);
  });
});
