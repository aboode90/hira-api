'use strict';

/**
 * إلغاءات مندوب/كابتن التوصيل بعد قبول الطلب + مراجعة الإدارة + تجميد بعد 3 عقوبات/يوم.
 */

const { v4: uuidv4 } = require('uuid');
const {
  nowIso,
  phonesOverlap,
  resolvePhoneKey,
  selectSingle,
  assertSupabaseAdmin,
  PLATFORM_ADMIN_PHONES,
} = require('./common');
const {
  getDriverProfile,
  saveDriverProfile,
  getCourierProfile,
  saveCourierProfile,
} = require('./operator_profiles');
const {
  readOrderMeta,
  cancelAssignedDeliveryOrderCore,
} = require('./orders');

const ASSIGNEE_CANCELABLE_DELIVERY_STATUSES = new Set([
  'accepted',
  'picked_up',
  'on_way',
]);

const PENALTY_LIMIT_PER_DAY = 3;
const FREEZE_HOURS = 3;

function iraqDayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function iraqDayBoundsUtc(dayKey = iraqDayKey()) {
  const start = new Date(`${dayKey}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function readDeliveryPenaltyFreezeUntil(profile = {}) {
  const raw =
    profile.deliveryPenaltyFreezeUntil ||
    profile.delivery_penalty_freeze_until ||
    null;
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function isAssigneePenaltyFrozen(profile = {}) {
  const until = readDeliveryPenaltyFreezeUntil(profile);
  if (!until) return false;
  return until > Date.now();
}

function freezeRemainingMs(profile = {}) {
  const until = readDeliveryPenaltyFreezeUntil(profile);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

async function loadAssigneeProfile(assigneePhone, role = '') {
  const phoneKey = await resolvePhoneKey(assigneePhone);
  const normalizedRole = String(role || '').trim();
  if (normalizedRole === 'driver') {
    return { phoneKey, role: 'driver', profile: (await getDriverProfile(phoneKey)) || {} };
  }
  if (normalizedRole === 'delivery') {
    return { phoneKey, role: 'delivery', profile: (await getCourierProfile(phoneKey)) || {} };
  }
  const driverProfile = await getDriverProfile(phoneKey);
  if (driverProfile) {
    return { phoneKey, role: 'driver', profile: driverProfile };
  }
  return { phoneKey, role: 'delivery', profile: (await getCourierProfile(phoneKey)) || {} };
}

async function saveAssigneeProfile(phoneKey, role, profile) {
  if (role === 'driver') {
    await saveDriverProfile(phoneKey, profile);
    return;
  }
  await saveCourierProfile(phoneKey, profile);
}

async function clearExpiredDeliveryPenaltyFreeze(assigneePhone, role = '') {
  const { phoneKey, role: resolvedRole, profile } = await loadAssigneeProfile(
    assigneePhone,
    role,
  );
  const until = readDeliveryPenaltyFreezeUntil(profile);
  if (!until) return profile;
  if (until > Date.now()) return profile;
  if (!profile.deliveryPenaltyFreezeUntil && !profile.delivery_penalty_freeze_until) {
    return profile;
  }
  const cleared = {
    ...profile,
    deliveryPenaltyFreezeUntil: null,
    delivery_penalty_freeze_until: null,
    deliveryPenaltyFreezeReason: null,
    deliveryPenaltyClearedAt: nowIso(),
  };
  await saveAssigneeProfile(phoneKey, resolvedRole, cleared);
  return cleared;
}

async function assertAssigneeNotPenaltyFrozen(assigneePhone, role = '') {
  const { phoneKey, role: resolvedRole, profile } = await loadAssigneeProfile(
    assigneePhone,
    role,
  );
  await clearExpiredDeliveryPenaltyFreeze(phoneKey, resolvedRole);
  const fresh = (await loadAssigneeProfile(phoneKey, resolvedRole)).profile;
  if (!isAssigneePenaltyFrozen(fresh)) return fresh;
  const mins = Math.ceil(freezeRemainingMs(fresh) / 60000);
  const err = new Error(
    `حسابك مجمّد مؤقتاً بسبب عقوبات إلغاء التوصيل. حاول بعد حوالي ${mins} دقيقة.`,
  );
  err.statusCode = 403;
  err.code = 'DELIVERY_PENALTY_FROZEN';
  err.freezeUntil = fresh.deliveryPenaltyFreezeUntil || null;
  throw err;
}

async function countRejectedDeliveryPenaltiesToday(assigneePhone) {
  const phoneKey = await resolvePhoneKey(assigneePhone);
  const { start, end } = iraqDayBoundsUtc();
  const supabase = assertSupabaseAdmin();
  const { count, error } = await supabase
    .from('delivery_assignee_cancellations')
    .select('id', { count: 'exact', head: true })
    .eq('assignee_phone', phoneKey)
    .eq('review_status', 'rejected')
    .eq('penalty_applied', true)
    .gte('reviewed_at', start)
    .lt('reviewed_at', end);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message || '')) return 0;
    throw new Error(error.message);
  }
  return Number(count || 0);
}

async function applyDeliveryPenaltyFreezeIfNeeded(assigneePhone, role = '') {
  const { phoneKey, role: resolvedRole, profile } = await loadAssigneeProfile(
    assigneePhone,
    role,
  );
  const rejectedToday = await countRejectedDeliveryPenaltiesToday(phoneKey);
  if (rejectedToday < PENALTY_LIMIT_PER_DAY) {
    return { frozen: false, rejectedToday };
  }

  const freezeUntil = new Date(Date.now() + FREEZE_HOURS * 60 * 60 * 1000).toISOString();
  await saveAssigneeProfile(phoneKey, resolvedRole, {
    ...profile,
    available: false,
    deliveryPenaltyFreezeUntil: freezeUntil,
    deliveryPenaltyFreezeReason: '3_delivery_cancel_penalties_same_day',
    deliveryPenaltyFrozenAt: nowIso(),
  });

  if (resolvedRole === 'driver') {
    try {
      const taxiRepo = require('../domains/taxi/repository/taxi');
      await taxiRepo.setDriverOnlineStatus(phoneKey, false);
    } catch (_) {}
  }

  try {
    const { sendPushToPhone } = require('../push_events');
    await sendPushToPhone(
      phoneKey,
      {
        title: 'تم تجميد حساب التوصيل',
        body: `حصلت على ${PENALTY_LIMIT_PER_DAY} عقوبات إلغاء توصيل اليوم — حسابك مجمّد لمدة ${FREEZE_HOURS} ساعات.`,
        data: {
          audience: resolvedRole === 'driver' ? 'driver' : 'courier',
          eventKey: 'delivery:penalty_frozen',
          freezeUntil,
        },
      },
      { showSystemBanner: true, immediate: true },
    );
  } catch (pushError) {
    console.error('delivery penalty freeze push error:', pushError?.message || pushError);
  }

  return { frozen: true, rejectedToday, freezeUntil };
}

function formatCancellationRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    orderId: String(row.order_id || '').trim(),
    orderNumber: String(row.order_number || '').trim(),
    assigneePhone: String(row.assignee_phone || '').trim(),
    assigneeName: String(row.assignee_name || '').trim(),
    assigneeRole: String(row.assignee_role || 'delivery').trim(),
    customerPhone: String(row.customer_phone || '').trim(),
    merchantPhone: String(row.merchant_phone || '').trim(),
    merchantStoreName: String(row.merchant_store_name || '').trim(),
    reason: String(row.reason || '').trim(),
    statusAtCancel: String(row.status_at_cancel || '').trim(),
    reviewStatus: String(row.review_status || 'pending').trim(),
    reviewedAt: row.reviewed_at || null,
    reviewedBy: String(row.reviewed_by || '').trim() || null,
    reviewNote: String(row.review_note || '').trim() || null,
    penaltyApplied: row.penalty_applied === true,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function assigneeCancelDeliveryOrder(assigneePhone, orderId, reason) {
  const normalizedAssignee = await resolvePhoneKey(assigneePhone);
  await clearExpiredDeliveryPenaltyFreeze(normalizedAssignee);
  await assertAssigneeNotPenaltyFrozen(normalizedAssignee);

  const id = String(orderId || '').trim();
  if (!id) throw new Error('Order id is required.');

  const trimmedReason = String(reason || '').trim().slice(0, 500);
  if (trimmedReason.length < 3) {
    throw new Error('يرجى كتابة سبب الإلغاء (3 أحرف على الأقل).');
  }

  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) throw new Error('Order not found.');

  const meta = readOrderMeta(row);
  if (!phonesOverlap(normalizedAssignee, meta.courierPhone)) {
    throw new Error('You are not assigned to this order.');
  }
  if (String(meta.statusKey || '').trim() === 'return_pending') {
    throw new Error('يجب إرجاع الطلب للمتجر بعد إلغاء الزبون.');
  }
  if (meta.statusKey !== 'delivering') {
    throw new Error('Cannot cancel this delivery.');
  }
  const deliveryStatus = String(meta.deliveryStatusKey || '').trim().toLowerCase();
  if (!ASSIGNEE_CANCELABLE_DELIVERY_STATUSES.has(deliveryStatus)) {
    throw new Error('Cannot cancel this delivery.');
  }

  const assigneeRole = String(meta.payload?.deliveryAssigneeRole || 'delivery').trim();
  const assigneeName = String(
    meta.payload?.assignedCourierName || meta.payload?.courierName || '',
  ).trim();
  const cancelledAt = nowIso();

  const updatedRow = await cancelAssignedDeliveryOrderCore(normalizedAssignee, id, {
    assigneeCancelReason: trimmedReason,
    assigneeCancelledAt: cancelledAt,
  });

  const cancellationId = uuidv4();
  const cancellationRow = {
    id: cancellationId,
    order_id: id,
    order_number: String(meta.payload?.orderNumber || row.order_number || '').trim(),
    assignee_phone: normalizedAssignee,
    assignee_name: assigneeName || null,
    assignee_role: assigneeRole === 'driver' ? 'driver' : 'delivery',
    customer_phone: String(meta.customerPhone || row.phone || '').trim() || null,
    merchant_phone: String(meta.merchantPhone || '').trim() || null,
    merchant_store_name: String(meta.payload?.merchantStoreName || '').trim() || null,
    reason: trimmedReason,
    status_at_cancel: deliveryStatus,
    review_status: 'pending',
    created_at: cancelledAt,
    updated_at: cancelledAt,
  };

  try {
    const supabase = assertSupabaseAdmin();
    const { error: insertError } = await supabase
      .from('delivery_assignee_cancellations')
      .insert(cancellationRow);
    if (insertError) throw insertError;
  } catch (insertError) {
    console.error(
      'delivery_assignee_cancellations insert error:',
      insertError?.message || insertError,
    );
  }

  try {
    const { sendPushToPhone } = require('../push_events');
    for (const adminPhone of PLATFORM_ADMIN_PHONES || []) {
      void sendPushToPhone(
        adminPhone,
        {
          title: 'إلغاء توصيل من مندوب/كابتن',
          body: `${assigneeName || normalizedAssignee}: ${trimmedReason}`,
          data: {
            audience: 'admin',
            eventKey: 'admin:delivery_assignee_cancel',
            orderId: id,
            cancellationId,
          },
        },
        { showSystemBanner: true, immediate: true },
      ).catch(() => {});
    }
  } catch (_) {}

  return {
    order: updatedRow,
    cancellation: formatCancellationRow(cancellationRow),
  };
}

async function listAssigneeCancellationsForAdmin(filters = {}) {
  const supabase = assertSupabaseAdmin();
  const page = Math.max(1, Number(filters.page || 1));
  const limit = Math.min(100, Math.max(1, Number(filters.limit || 25)));
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const status = String(filters.status || '').trim();

  let query = supabase
    .from('delivery_assignee_cancellations')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status === 'pending' || status === 'approved' || status === 'rejected') {
    query = query.eq('review_status', status);
  }

  const { data, error, count } = await query;
  if (error) {
    if (/does not exist|schema cache/i.test(error.message || '')) {
      return { items: [], page, limit, total: 0 };
    }
    throw new Error(error.message);
  }

  return {
    items: (data || []).map(formatCancellationRow),
    page,
    limit,
    total: Number(count || 0),
  };
}

async function reviewAssigneeCancellation(adminPhone, cancellationId, decision, note = '') {
  const id = String(cancellationId || '').trim();
  if (!id) throw new Error('Cancellation id is required.');
  const reviewStatus = String(decision || '').trim() === 'rejected' ? 'rejected' : 'approved';
  const supabase = assertSupabaseAdmin();

  const { data: existing, error: loadError } = await supabase
    .from('delivery_assignee_cancellations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (loadError) throw new Error(loadError.message);
  if (!existing) throw new Error('طلب الإلغاء غير موجود.');
  if (existing.review_status !== 'pending') {
    throw new Error('تمت مراجعة هذا الطلب مسبقاً.');
  }

  const reviewedAt = nowIso();
  const penaltyApplied = reviewStatus === 'rejected';
  const { data: updated, error } = await supabase
    .from('delivery_assignee_cancellations')
    .update({
      review_status: reviewStatus,
      reviewed_at: reviewedAt,
      reviewed_by: String(adminPhone || '').trim() || null,
      review_note: String(note || '').trim().slice(0, 500) || null,
      penalty_applied: penaltyApplied,
      updated_at: reviewedAt,
    })
    .eq('id', id)
    .eq('review_status', 'pending')
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!updated) throw new Error('تعذّر تحديث طلب الإلغاء.');

  let freezeResult = null;
  if (penaltyApplied) {
    freezeResult = await applyDeliveryPenaltyFreezeIfNeeded(
      updated.assignee_phone,
      updated.assignee_role,
    );
  }

  try {
    const { sendPushToPhone } = require('../push_events');
    const audience =
      String(updated.assignee_role || '').trim() === 'driver' ? 'driver' : 'courier';
    if (reviewStatus === 'approved') {
      await sendPushToPhone(
        updated.assignee_phone,
        {
          title: 'موافقة على إلغاء التوصيل',
          body: 'وافقت الإدارة على إلغائك — بلا عقوبة.',
          data: {
            audience,
            eventKey: 'delivery:cancel_review_approved',
            cancellationId: id,
          },
        },
        { showSystemBanner: true, immediate: true },
      );
    } else {
      const body = freezeResult?.frozen
        ? `رُفض الإلغاء واحتُسبت عقوبة. تم تجميد حسابك ${FREEZE_HOURS} ساعات.`
        : 'رُفض الإلغاء واحتُسبت عقوبة على حسابك.';
      await sendPushToPhone(
        updated.assignee_phone,
        {
          title: 'رفض إلغاء التوصيل',
          body,
          data: {
            audience,
            eventKey: freezeResult?.frozen
              ? 'delivery:penalty_frozen'
              : 'delivery:cancel_review_rejected',
            cancellationId: id,
            freezeUntil: freezeResult?.freezeUntil || null,
          },
        },
        { showSystemBanner: true, immediate: true },
      );
    }
  } catch (pushError) {
    console.error('delivery cancel review push error:', pushError?.message || pushError);
  }

  return {
    cancellation: formatCancellationRow(updated),
    freeze: freezeResult,
  };
}

async function getAssigneeDeliveryPenaltyStatus(assigneePhone, role = '') {
  const { phoneKey, role: resolvedRole, profile } = await loadAssigneeProfile(
    assigneePhone,
    role,
  );
  const cleared = (await clearExpiredDeliveryPenaltyFreeze(phoneKey, resolvedRole)) || profile;
  const frozen = isAssigneePenaltyFrozen(cleared);
  const rejectedToday = await countRejectedDeliveryPenaltiesToday(phoneKey);
  return {
    frozen,
    freezeUntil: frozen ? cleared.deliveryPenaltyFreezeUntil || null : null,
    remainingMs: frozen ? freezeRemainingMs(cleared) : 0,
    rejectedToday,
    penaltyLimit: PENALTY_LIMIT_PER_DAY,
    freezeHours: FREEZE_HOURS,
  };
}

module.exports = {
  ASSIGNEE_CANCELABLE_DELIVERY_STATUSES,
  PENALTY_LIMIT_PER_DAY,
  FREEZE_HOURS,
  assertAssigneeNotPenaltyFrozen,
  clearExpiredDeliveryPenaltyFreeze,
  assigneeCancelDeliveryOrder,
  listAssigneeCancellationsForAdmin,
  reviewAssigneeCancellation,
  getAssigneeDeliveryPenaltyStatus,
  formatCancellationRow,
};
