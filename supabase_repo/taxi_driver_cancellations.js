'use strict';

/**
 * إلغاءات الكباتن بعد قبول الرحلة + مراجعة الإدارة + تجميد بعد 3 عقوبات/يوم.
 */

const { v4: uuidv4 } = require('uuid');
const {
  nowIso,
  normalizeObject,
  phonesOverlap,
  resolvePhoneKey,
  selectSingle,
  assertSupabaseAdmin,
  PLATFORM_ADMIN_PHONES,
} = require('./common');
const { getDriverProfile, saveDriverProfile } = require('./operator_profiles');

const DRIVER_CANCELABLE_STATUSES = new Set([
  'accepted',
  'on_way',
  'arrived',
]);

const PENALTY_LIMIT_PER_DAY = 3;
const FREEZE_HOURS = 2;

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
  // يوم بغداد = UTC+3 → يبدأ عند 21:00 UTC لليوم السابق.
  const start = new Date(`${dayKey}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function readFreezeUntil(profile = {}) {
  const raw =
    profile.taxiPenaltyFreezeUntil ||
    profile.taxi_penalty_freeze_until ||
    profile.freezeUntil ||
    null;
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function isDriverPenaltyFrozen(profile = {}) {
  const until = readFreezeUntil(profile);
  if (!until) return false;
  return until > Date.now();
}

function freezeRemainingMs(profile = {}) {
  const until = readFreezeUntil(profile);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

async function assertDriverNotPenaltyFrozen(driverPhone) {
  const profile = (await getDriverProfile(driverPhone)) || {};
  if (!isDriverPenaltyFrozen(profile)) return profile;
  const mins = Math.ceil(freezeRemainingMs(profile) / 60000);
  const err = new Error(
    `حسابك مجمّد مؤقتاً بسبب عقوبات الإلغاء. حاول بعد حوالي ${mins} دقيقة.`,
  );
  err.statusCode = 403;
  err.code = 'DRIVER_PENALTY_FROZEN';
  err.freezeUntil = profile.taxiPenaltyFreezeUntil || null;
  throw err;
}

async function countDriverCancelsToday(driverPhone) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  const { start, end } = iraqDayBoundsUtc();
  const supabase = assertSupabaseAdmin();
  const { count, error } = await supabase
    .from('taxi_driver_cancellations')
    .select('id', { count: 'exact', head: true })
    .eq('driver_phone', phoneKey)
    .gte('created_at', start)
    .lt('created_at', end);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message || '')) return 0;
    throw new Error(error.message);
  }
  return Number(count || 0);
}

async function applyDailyDriverCancelFreezeIfNeeded(driverPhone) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  const cancelsToday = await countDriverCancelsToday(phoneKey);
  if (cancelsToday < PENALTY_LIMIT_PER_DAY) {
    return { frozen: false, cancelsToday };
  }

  const freezeUntil = new Date(
    Date.now() + FREEZE_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const profile = (await getDriverProfile(phoneKey)) || {};
  await saveDriverProfile(phoneKey, {
    ...profile,
    available: false,
    taxiPenaltyFreezeUntil: freezeUntil,
    taxiPenaltyFreezeReason: '3_driver_cancels_same_day',
    taxiPenaltyFrozenAt: nowIso(),
  });

  try {
    const taxiRepo = require('../domains/taxi/repository/taxi');
    await taxiRepo.setDriverOnlineStatus(phoneKey, false);
  } catch (_) {}

  try {
    const { sendPushToPhone } = require('../push_events');
    await sendPushToPhone(
      phoneKey,
      {
        title: 'تم تجميد حساب الكابتن',
        body: `ألغيت ${PENALTY_LIMIT_PER_DAY} رحلات اليوم — حسابك مجمّد لمدة ${FREEZE_HOURS} ساعتين.`,
        data: {
          audience: 'driver',
          eventKey: 'taxi:penalty_frozen',
          freezeUntil,
        },
      },
      { showSystemBanner: true, immediate: true },
    );
  } catch (pushError) {
    console.error('driver daily cancel freeze push error:', pushError?.message || pushError);
  }

  return { frozen: true, cancelsToday, freezeUntil };
}

async function countRejectedPenaltiesToday(driverPhone) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  const { start, end } = iraqDayBoundsUtc();
  const supabase = assertSupabaseAdmin();
  const { count, error } = await supabase
    .from('taxi_driver_cancellations')
    .select('id', { count: 'exact', head: true })
    .eq('driver_phone', phoneKey)
    .eq('review_status', 'rejected')
    .eq('penalty_applied', true)
    .gte('reviewed_at', start)
    .lt('reviewed_at', end);
  if (error) {
    // الجدول غير موجود بعد — لا نكسر التدفق.
    if (/does not exist|schema cache/i.test(error.message || '')) return 0;
    throw new Error(error.message);
  }
  return Number(count || 0);
}

async function applyPenaltyFreezeIfNeeded(driverPhone) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  const rejectedToday = await countRejectedPenaltiesToday(phoneKey);
  if (rejectedToday < PENALTY_LIMIT_PER_DAY) {
    return { frozen: false, rejectedToday };
  }

  const freezeUntil = new Date(Date.now() + FREEZE_HOURS * 60 * 60 * 1000).toISOString();
  const profile = (await getDriverProfile(phoneKey)) || {};
  await saveDriverProfile(phoneKey, {
    ...profile,
    available: false,
    taxiPenaltyFreezeUntil: freezeUntil,
    taxiPenaltyFreezeReason: '3_driver_cancel_penalties_same_day',
    taxiPenaltyFrozenAt: nowIso(),
  });

  try {
    const taxiRepo = require('../domains/taxi/repository/taxi');
    await taxiRepo.setDriverOnlineStatus(phoneKey, false);
  } catch (_) {}

  try {
    const { sendPushToPhone } = require('../push_events');
    await sendPushToPhone(
      phoneKey,
      {
        title: 'تم تجميد حساب الكابتن',
        body: `حصلت على ${PENALTY_LIMIT_PER_DAY} عقوبات إلغاء اليوم — حسابك مجمّد لمدة ${FREEZE_HOURS} ساعات.`,
        data: {
          audience: 'driver',
          eventKey: 'taxi:penalty_frozen',
          freezeUntil,
        },
      },
      { showSystemBanner: true, immediate: true },
    );
  } catch (pushError) {
    console.error('driver freeze push error:', pushError?.message || pushError);
  }

  return { frozen: true, rejectedToday, freezeUntil };
}

async function clearExpiredPenaltyFreeze(driverPhone) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  const profile = (await getDriverProfile(phoneKey)) || {};
  const until = readFreezeUntil(profile);
  if (!until) return profile;
  if (until > Date.now()) return profile;
  if (!profile.taxiPenaltyFreezeUntil && !profile.taxi_penalty_freeze_until) {
    return profile;
  }
  const cleared = {
    ...profile,
    taxiPenaltyFreezeUntil: null,
    taxi_penalty_freeze_until: null,
    taxiPenaltyFreezeReason: null,
    taxiPenaltyClearedAt: nowIso(),
  };
  await saveDriverProfile(phoneKey, cleared);
  return cleared;
}

function formatCancellationRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    requestId: String(row.request_id || '').trim(),
    requestNumber: String(row.request_number || '').trim(),
    driverPhone: String(row.driver_phone || '').trim(),
    driverName: String(row.driver_name || '').trim(),
    customerPhone: String(row.customer_phone || '').trim(),
    reason: String(row.reason || '').trim(),
    taxiType: String(row.taxi_type || '').trim(),
    statusAtCancel: String(row.status_at_cancel || '').trim(),
    reviewStatus: String(row.review_status || 'pending').trim(),
    reviewedAt: row.reviewed_at || null,
    reviewedBy: String(row.reviewed_by || '').trim() || null,
    reviewNote: String(row.review_note || '').trim() || null,
    penaltyApplied: row.penalty_applied === true,
    platformFeeIqd: Number(row.platform_fee_iqd ?? 0) || 0,
    platformFeeStatus: String(row.platform_fee_status || 'none').trim(),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * إلغاء فوري من الكابتن بعد القبول — الزبون يعيد الطلب من جديد.
 */
async function driverCancelTaxiRequest(driverPhone, requestId, reason) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  await clearExpiredPenaltyFreeze(normalizedDriver);
  await assertDriverNotPenaltyFrozen(normalizedDriver);

  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const trimmedReason = String(reason || '').trim().slice(0, 500);
  if (trimmedReason.length < 3) {
    throw new Error('يرجى كتابة سبب الإلغاء (3 أحرف على الأقل).');
  }

  const taxiRepo = require('../domains/taxi/repository/taxi');
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = taxiRepo.readTaxiMeta(row);
  if (!phonesOverlap(normalizedDriver, meta.driverPhone)) {
    throw new Error('هذه الرحلة غير معيّنة لك.');
  }
  if (!DRIVER_CANCELABLE_STATUSES.has(meta.statusKey)) {
    throw new Error('لا يمكن إلغاء الرحلة في حالتها الحالية. يمكنك التحويل لكابتن آخر إن أمكن.');
  }

  const cancelledAt = nowIso();
  const nextPayload = {
    ...meta.payload,
    statusKey: 'cancelled',
    statusAr: 'ملغي من الكابتن',
    cancellationReason: trimmedReason,
    cancelledBy: 'driver',
    cancelledByAr: 'ألغاها الكابتن',
    cancelledAt,
    driverCancelReason: trimmedReason,
    driverCancelledAt: cancelledAt,
    updatedAt: cancelledAt,
  };

  const supabase = assertSupabaseAdmin();
  const { data: updated, error } = await supabase
    .from('taxi_requests')
    .update({
      status_key: 'cancelled',
      request_payload: nextPayload,
      cancellation_reason: trimmedReason,
      updated_at: cancelledAt,
    })
    .eq('id', id)
    .eq('driver_phone', row.driver_phone)
    .in('status_key', [...DRIVER_CANCELABLE_STATUSES])
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!updated) throw new Error('تعذّر إلغاء الرحلة. حدّث الحالة وحاول مجدداً.');

  const cancellationId = uuidv4();
  const cancellationRow = {
    id: cancellationId,
    request_id: id,
    request_number: String(meta.requestNumber || meta.payload.requestNumber || row.request_number || '').trim(),
    driver_phone: normalizedDriver,
    driver_name: String(meta.driverName || meta.payload.driverName || '').trim() || null,
    customer_phone: String(meta.customerPhone || row.phone || '').trim() || null,
    reason: trimmedReason,
    taxi_type: String(meta.taxiType || row.taxi_type || '').trim() || null,
    status_at_cancel: meta.statusKey,
    review_status: 'pending',
    created_at: cancelledAt,
    updated_at: cancelledAt,
  };

  let platformFeeIqd = 0;
  let platformFeeStatus = 'none';

  try {
    const { error: insertError } = await supabase
      .from('taxi_driver_cancellations')
      .insert(cancellationRow);
    if (insertError) throw insertError;
  } catch (insertError) {
    console.error(
      'taxi_driver_cancellations insert error:',
      insertError?.message || insertError,
    );
  }

  try {
    const { getServiceFees } = require('../services/app_config_service');
    const { refundServiceFee, findServiceDebit } = require('./provider_wallet');
    const fees = await getServiceFees();
    platformFeeIqd = Number(fees.taxiOrderIqd ?? 250) || 250;
    const debit = await findServiceDebit('driver', 'taxi_request', id);
    if (debit) {
      await refundServiceFee({
        phone: normalizedDriver,
        providerType: 'driver',
        amountIqd: platformFeeIqd,
        referenceType: 'taxi_request_refund',
        referenceId: id,
        noteAr: 'إرجاع رسوم خدمة — إلغاء رحلة بانتظار مراجعة الإدارة',
        originalReferenceType: 'taxi_request',
      });
      platformFeeStatus = 'pending_review';
      await supabase
        .from('taxi_driver_cancellations')
        .update({
          platform_fee_iqd: platformFeeIqd,
          platform_fee_status: platformFeeStatus,
          updated_at: nowIso(),
        })
        .eq('id', cancellationId);
      cancellationRow.platform_fee_iqd = platformFeeIqd;
      cancellationRow.platform_fee_status = platformFeeStatus;
    }
  } catch (walletError) {
    console.error(
      'driver cancel wallet refund error:',
      walletError?.message || walletError,
    );
  }

  try {
    await applyDailyDriverCancelFreezeIfNeeded(normalizedDriver);
  } catch (freezeError) {
    console.error(
      'driver daily cancel freeze error:',
      freezeError?.message || freezeError,
    );
  }

  const customerPhone = String(meta.customerPhone || row.phone || '').trim();

  try {
    const { socketBroadcast, customerRoom, tripRoom } = require('../lib/socket_broadcast');
    const cancelledOut = taxiRepo.formatTaxiRequestForClient(updated);
    void socketBroadcast({
      room: customerRoom(customerPhone),
      event: 'taxi:status',
      payload: cancelledOut,
    });
    void socketBroadcast({
      room: tripRoom(id),
      event: 'taxi:status',
      payload: cancelledOut,
    });
  } catch (socketError) {
    console.error('driver cancel socket error:', socketError?.message || socketError);
  }

  try {
    const { notifyTripCancelled } = require('../push/taxi_push_events');
    await notifyTripCancelled(
      customerPhone,
      null,
      `ألغى الكابتن الرحلة: ${trimmedReason}`,
      id,
    );
  } catch (pushError) {
    console.error('driver cancel customer push error:', pushError?.message || pushError);
  }

  try {
    const { sendPushToPhone } = require('../push_events');
    // إشعار داخلي تقريبي للأدمن عبر أرقام المنصة إن وُجدت — best effort.
    for (const adminPhone of PLATFORM_ADMIN_PHONES || []) {
      void sendPushToPhone(
        adminPhone,
        {
          title: 'إلغاء رحلة من كابتن',
          body: `${cancellationRow.driver_name || normalizedDriver}: ${trimmedReason}`,
          data: {
            audience: 'admin',
            eventKey: 'admin:taxi_driver_cancel',
            requestId: id,
            cancellationId,
          },
        },
        { showSystemBanner: true, immediate: true },
      ).catch(() => {});
    }
  } catch (_) {}

  return {
    trip: taxiRepo.formatTaxiRequestForClient(updated),
    cancellation: formatCancellationRow(cancellationRow),
  };
}

async function listDriverCancellationsForAdmin(filters = {}) {
  const supabase = assertSupabaseAdmin();
  const page = Math.max(1, Number(filters.page || 1));
  const limit = Math.min(100, Math.max(1, Number(filters.limit || 25)));
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const status = String(filters.status || '').trim();

  let query = supabase
    .from('taxi_driver_cancellations')
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

async function reviewDriverCancellation(adminPhone, cancellationId, decision, note = '') {
  const id = String(cancellationId || '').trim();
  if (!id) throw new Error('Cancellation id is required.');
  const reviewStatus = String(decision || '').trim() === 'rejected' ? 'rejected' : 'approved';
  const supabase = assertSupabaseAdmin();

  const { data: existing, error: loadError } = await supabase
    .from('taxi_driver_cancellations')
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
    .from('taxi_driver_cancellations')
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
    freezeResult = await applyPenaltyFreezeIfNeeded(updated.driver_phone);
    if (
      updated.platform_fee_status === 'pending_review' &&
      Number(updated.platform_fee_iqd || 0) > 0
    ) {
      try {
        const { chargeTaxiOrderFee } = require('./provider_wallet');
        await chargeTaxiOrderFee(updated.driver_phone, updated.request_id);
        await supabase
          .from('taxi_driver_cancellations')
          .update({
            platform_fee_status: 'recharged',
            updated_at: nowIso(),
          })
          .eq('id', id);
      } catch (rechargeError) {
        console.error(
          'driver cancel fee recharge error:',
          rechargeError?.message || rechargeError,
        );
      }
    }
  } else if (updated.platform_fee_status === 'pending_review') {
    await supabase
      .from('taxi_driver_cancellations')
      .update({
        platform_fee_status: 'waived',
        updated_at: nowIso(),
      })
      .eq('id', id);
  }

  try {
    const { sendPushToPhone } = require('../push_events');
    if (reviewStatus === 'approved') {
      await sendPushToPhone(
        updated.driver_phone,
        {
          title: 'موافقة على إلغاء الرحلة',
          body: 'وافقت الإدارة على إلغائك — بلا عقوبة.',
          data: {
            audience: 'driver',
            eventKey: 'taxi:cancel_review_approved',
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
        updated.driver_phone,
        {
          title: 'رفض إلغاء الرحلة',
          body,
          data: {
            audience: 'driver',
            eventKey: freezeResult?.frozen
              ? 'taxi:penalty_frozen'
              : 'taxi:cancel_review_rejected',
            cancellationId: id,
            freezeUntil: freezeResult?.freezeUntil || null,
          },
        },
        { showSystemBanner: true, immediate: true },
      );
    }
  } catch (pushError) {
    console.error('cancel review push error:', pushError?.message || pushError);
  }

  return {
    cancellation: formatCancellationRow(updated),
    freeze: freezeResult,
  };
}

async function getDriverPenaltyStatus(driverPhone) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  let profile = (await getDriverProfile(phoneKey)) || {};
  profile = (await clearExpiredPenaltyFreeze(phoneKey)) || profile;
  const frozen = isDriverPenaltyFrozen(profile);
  const rejectedToday = await countRejectedPenaltiesToday(phoneKey);
  const cancelsToday = await countDriverCancelsToday(phoneKey);
  return {
    frozen,
    freezeUntil: frozen ? profile.taxiPenaltyFreezeUntil || null : null,
    remainingMs: frozen ? freezeRemainingMs(profile) : 0,
    rejectedToday,
    cancelsToday,
    penaltyLimit: PENALTY_LIMIT_PER_DAY,
    freezeHours: FREEZE_HOURS,
  };
}

module.exports = {
  DRIVER_CANCELABLE_STATUSES,
  PENALTY_LIMIT_PER_DAY,
  FREEZE_HOURS,
  iraqDayKey,
  isDriverPenaltyFrozen,
  freezeRemainingMs,
  assertDriverNotPenaltyFrozen,
  clearExpiredPenaltyFreeze,
  driverCancelTaxiRequest,
  listDriverCancellationsForAdmin,
  reviewDriverCancellation,
  getDriverPenaltyStatus,
  formatCancellationRow,
};
