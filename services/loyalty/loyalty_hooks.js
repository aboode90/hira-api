const loyalty = require('./loyalty_service');

async function onMarketplaceOrderSaved({ previousMeta, nextMeta, customerPhone }) {
  try {
    const prevStatus = String(previousMeta?.statusKey || '').trim();
    const nextStatus = String(nextMeta?.statusKey || '').trim();
    const orderId = String(nextMeta?.id || '').trim();
    const phone = String(customerPhone || nextMeta?.customerPhone || '').trim();
    if (!phone || !orderId) return;

    if (nextStatus === 'completed' && prevStatus !== 'completed') {
      loyalty.awardOrderCompletion(phone, 'marketplace', orderId);
    }
  } catch (error) {
    console.error('loyalty marketplace hook error:', error?.message || error);
  }
}

async function onTaxiTripCompleted({ customerPhone, requestId }) {
  try {
    const phone = String(customerPhone || '').trim();
    const id = String(requestId || '').trim();
    if (!phone || !id) return;
    loyalty.awardOrderCompletion(phone, 'taxi', id);
  } catch (error) {
    console.error('loyalty taxi hook error:', error?.message || error);
  }
}

async function applyNewOrderCoupon({
  customerPhone,
  merchantPhone,
  orderId,
  order,
}) {
  const couponId = String(order?.loyaltyCouponId || '').trim();
  const couponCode = String(order?.loyaltyCouponCode || '').trim();
  if (!couponId && !couponCode) return;

  const subtotal =
    Number(order?.itemsSubtotalIqd ?? order?.price ?? 0) +
    Number(order?.promoDiscountIqd ?? 0);
  let validation;
  if (couponCode) {
    validation = loyalty.validateCouponForCheckout(
      customerPhone,
      couponCode,
      subtotal,
      'marketplace',
    );
  } else {
    const localStore = require('./loyalty_local_store');
    const coupon = localStore.findCouponById(customerPhone, couponId);
    if (!coupon) {
      throw new Error('الكوبون غير صالح.');
    }
    validation = loyalty.validateCouponForCheckout(
      customerPhone,
      coupon.code,
      subtotal,
      'marketplace',
    );
  }
  if (!validation.valid) {
    throw new Error(validation.messageAr || 'الكوبون غير صالح.');
  }

  loyalty.redeemCoupon(customerPhone, validation.couponId, {
    orderId,
    discountIqd: validation.discountAmountIqd,
  });

  order.platformServiceFeeWaived = true;
  order.platformServiceFeeIqd = 0;
  order.promoDiscountIqd = validation.discountAmountIqd;

  const discount = validation.discountAmountIqd;
  if (merchantPhone && discount > 0) {
    const { chargeServiceFee } = require('../../supabase_repo/provider_wallet');
    await chargeServiceFee({
      phone: merchantPhone,
      providerType: 'merchant',
      amountIqd: discount,
      referenceType: 'customer_promo_discount',
      referenceId: orderId,
      noteAr: `خصم كوبون ولاء زبون (${discount} د.ع)`,
    });
  }
}

module.exports = {
  onMarketplaceOrderSaved,
  onTaxiTripCompleted,
  applyNewOrderCoupon,
};
