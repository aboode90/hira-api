/**
 * Resolve who cancelled an order from payload fields (new + legacy).
 * @returns {{ cancelledBy: string|null, cancelledByAr: string|null, displayStatusAr: string }}
 */
function resolveOrderCancelActor(payload = {}, statusKey = '') {
  const key = String(statusKey || payload.statusKey || '').trim().toLowerCase();
  const statusAr = String(payload.statusAr || '').trim();
  const statusEn = String(payload.statusEn || '').trim();
  const noteAr = String(payload.noteAr || '').trim();
  const noteEn = String(payload.noteEn || '').trim();
  const explicit = String(payload.cancelledBy || '').trim().toLowerCase();

  const isCancelled =
    key === 'cancelled' ||
    key === 'rejected' ||
    key === 'failed' ||
    statusEn.toLowerCase() === 'rejected' ||
    statusEn.toLowerCase() === 'cancelled';

  if (!isCancelled) {
    return {
      cancelledBy: null,
      cancelledByAr: null,
      displayStatusAr: statusAr || key || '',
    };
  }

  let cancelledBy = null;
  if (['customer', 'merchant', 'admin', 'system'].includes(explicit)) {
    cancelledBy = explicit;
  } else if (
    noteAr.startsWith('سبب الرفض:') ||
    noteEn.startsWith('Rejected reason:') ||
    statusAr.includes('رفض') ||
    statusEn.toLowerCase() === 'rejected'
  ) {
    cancelledBy = 'merchant';
  } else if (
    noteAr.includes('ألغى الزبون') ||
    noteEn.toLowerCase().includes('cancelled by customer') ||
    noteAr.includes('رفض الزبون الطلب المعدّل') ||
    noteEn.toLowerCase().includes('customer rejected adjusted')
  ) {
    cancelledBy = 'customer';
  } else if (
    statusAr.includes('الإدارة') ||
    noteAr.includes('الإدارة') ||
    noteEn.toLowerCase().includes('admin')
  ) {
    cancelledBy = 'admin';
  } else if (
    statusAr.includes('تلقائي') ||
    noteAr.includes('تلقائي') ||
    noteEn.toLowerCase().includes('auto') ||
    noteEn.toLowerCase().includes('timeout')
  ) {
    cancelledBy = 'system';
  }

  const labels = {
    customer: 'ملغي من الزبون',
    merchant: 'ملغي من التاجر',
    admin: 'ملغي من الإدارة',
    system: 'ملغي تلقائياً',
  };

  // مفتاح سببي موحّد يميّز بوضوح: انتهاء المهلة / زر الإلغاء / رفض التعديل / رفض التاجر.
  let cancelReasonKey = null;
  if (cancelledBy === 'system') {
    cancelReasonKey = 'system_timeout';
  } else if (cancelledBy === 'customer') {
    cancelReasonKey =
      noteAr.includes('رفض الزبون الطلب المعدّل') ||
      noteEn.toLowerCase().includes('customer rejected adjusted')
        ? 'customer_adjustment_reject'
        : 'customer_manual';
  } else if (cancelledBy === 'merchant') {
    cancelReasonKey = 'merchant_reject';
  } else if (cancelledBy === 'admin') {
    cancelReasonKey = 'admin';
  }

  const cancelledByAr = cancelledBy ? labels[cancelledBy] : 'ملغي (غير محدد)';
  const displayStatusAr = cancelledByAr;

  return { cancelledBy, cancelledByAr, displayStatusAr, cancelReasonKey };
}

module.exports = {
  resolveOrderCancelActor,
};
