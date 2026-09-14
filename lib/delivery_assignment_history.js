'use strict';

const END_REASONS = {
  CANCELLED_BY_ASSIGNEE: 'cancelled_by_assignee',
  CUSTOMER_CANCELLED: 'customer_cancelled',
  ADMIN_CLEARED: 'admin_cleared',
  ADMIN_REASSIGNED: 'admin_reassigned',
  DELIVERED: 'delivered',
};

const END_REASON_AR = {
  [END_REASONS.CANCELLED_BY_ASSIGNEE]: 'ألغى القبول',
  [END_REASONS.CUSTOMER_CANCELLED]: 'إلغاء الزبون',
  [END_REASONS.ADMIN_CLEARED]: 'إزالة من الإدارة',
  [END_REASONS.ADMIN_REASSIGNED]: 'إعادة تعيين من الإدارة',
  [END_REASONS.DELIVERED]: 'تم التسليم',
};

function phoneDigitsKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function phonesMatch(a, b) {
  const da = phoneDigitsKey(a);
  const db = phoneDigitsKey(b);
  return Boolean(da && db && da === db);
}

function normalizeHistory(payload) {
  const raw = payload?.deliveryAssignmentHistory;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      phone: String(entry.phone || '').trim(),
      name: String(entry.name || '').trim(),
      role: String(entry.role || '').trim(),
      acceptedAt: entry.acceptedAt || null,
      acceptedBy: String(entry.acceptedBy || 'self').trim(),
      endedAt: entry.endedAt || null,
      endReason: entry.endReason || null,
    }));
}

function findOpenEntryIndex(history, phone) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry.endedAt) continue;
    if (!phone || phonesMatch(entry.phone, phone)) return i;
  }
  return -1;
}

function recordDeliveryAcceptance(payload, {
  phone,
  name = '',
  role = '',
  source = 'self',
  at,
} = {}) {
  const normalizedPhone = String(phone || '').trim();
  if (!normalizedPhone) return { ...(payload || {}) };

  const next = { ...(payload || {}) };
  const history = normalizeHistory(next);
  const stamp = String(at || new Date().toISOString()).trim();
  history.push({
    phone: normalizedPhone,
    name: String(name || '').trim(),
    role: String(role || '').trim(),
    acceptedAt: stamp,
    acceptedBy: String(source || 'self').trim(),
    endedAt: null,
    endReason: null,
  });
  next.deliveryAssignmentHistory = history;
  return next;
}

function recordDeliveryAssignmentEnd(payload, {
  phone,
  reason,
  at,
} = {}) {
  const normalizedPhone = String(phone || '').trim();
  const next = { ...(payload || {}) };
  const history = normalizeHistory(next);
  const index = findOpenEntryIndex(history, normalizedPhone);
  if (index < 0) return next;

  const stamp = String(at || new Date().toISOString()).trim();
  history[index] = {
    ...history[index],
    endedAt: stamp,
    endReason: String(reason || '').trim() || null,
  };
  next.deliveryAssignmentHistory = history;
  return next;
}

function endReasonLabelAr(reason) {
  return END_REASON_AR[String(reason || '').trim()] || String(reason || '').trim();
}

module.exports = {
  END_REASONS,
  END_REASON_AR,
  endReasonLabelAr,
  normalizeHistory,
  recordDeliveryAcceptance,
  recordDeliveryAssignmentEnd,
};
