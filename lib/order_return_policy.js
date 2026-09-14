'use strict';

const {
  END_REASONS,
  recordDeliveryAssignmentEnd,
} = require('./delivery_assignment_history');

function deliveryStatusOf(value) {
  return String(value || '').trim().toLowerCase();
}

function goodsInCourierHand(deliveryStatus) {
  const status = deliveryStatusOf(deliveryStatus);
  return (
    status === 'picked_up' ||
    status === 'on_way' ||
    status === 'returning' ||
    status === 'return_arrived'
  );
}

function applyCustomerCancelReturnPolicy({
  order,
  previousMeta,
  data = {},
  nowIso,
} = {}) {
  const next = { ...(order || {}) };
  const nextData = { ...(data || {}) };
  const prevStatus = String(previousMeta?.statusKey || '').trim().toLowerCase();
  const nextStatus = String(next.statusKey || '').trim().toLowerCase();
  const stamp = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();

  if (prevStatus === 'return_pending' && nextStatus === 'cancelled') {
    const nextDelivery = deliveryStatusOf(next.deliveryStatusKey);
    if (nextDelivery === 'returned') {
      next.returnConfirmedAt = stamp;
      next.returnConfirmedByMerchant = true;
      next.statusAr = String(next.statusAr || '').trim() || 'ملغي بعد إرجاع الطلب';
      next.statusEn = String(next.statusEn || '').trim() || 'Cancelled after return';
    }
    return { order: next, data: nextData };
  }

  const wantsReturn =
    nextStatus === 'return_pending' ||
    (nextStatus === 'cancelled' && prevStatus === 'delivering');
  if (!wantsReturn) {
    return { order: next, data: nextData };
  }

  const previousDelivery = deliveryStatusOf(
    previousMeta?.deliveryStatusKey || next.deliveryStatusKey,
  );
  const courierPhone = String(
    previousMeta?.courierPhone ||
      next.courierPhone ||
      next.assignedCourierPhone ||
      nextData.courier_phone ||
      nextData.courierPhone ||
      '',
  ).trim();

  if (prevStatus === 'delivering' && goodsInCourierHand(previousDelivery) && courierPhone) {
    next.statusKey = 'return_pending';
    next.statusAr = 'بانتظار إرجاع الطلب للمتجر';
    next.statusEn = 'Awaiting return to store';
    next.deliveryStatusKey = 'returning';
    next.deliveryStatusAr = 'إرجاع للمتجر بسبب إلغاء الزبون';
    next.deliveryStatusEn = 'Returning to merchant after customer cancel';
    next.customerCancelledDuringDelivery = true;
    next.returnRequestedAt = stamp;
    next.courierPhone = courierPhone;
    nextData.courier_phone = courierPhone;
    nextData.courierPhone = courierPhone;
    return { order: next, data: nextData };
  }

  if (nextStatus === 'cancelled' && prevStatus === 'delivering') {
    const activeCourierPhone = String(
      previousMeta?.courierPhone ||
        next.courierPhone ||
        next.assignedCourierPhone ||
        nextData.courier_phone ||
        nextData.courierPhone ||
        '',
    ).trim();
    if (activeCourierPhone && !goodsInCourierHand(previousDelivery)) {
      const historyBase = {
        ...next,
        deliveryAssignmentHistory:
          next.deliveryAssignmentHistory ??
          previousMeta?.payload?.deliveryAssignmentHistory ??
          [],
      };
      Object.assign(
        next,
        recordDeliveryAssignmentEnd(historyBase, {
          phone: activeCourierPhone,
          reason: END_REASONS.CUSTOMER_CANCELLED,
          at: stamp,
        }),
      );
    }
    next.courierPhone = null;
    delete next.assignedCourierPhone;
    delete next.assignedCourierName;
    delete next.courierName;
    next.deliveryStatusKey = 'cancelled';
    next.deliveryStatusAr = 'أُلغي قبل استلام الطلب';
    next.deliveryStatusEn = 'Cancelled before pickup';
    nextData.courier_phone = null;
    nextData.courierPhone = null;
  }

  return { order: next, data: nextData };
}

module.exports = {
  goodsInCourierHand,
  applyCustomerCancelReturnPolicy,
};
