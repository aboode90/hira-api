/**
 * Admin operations console — orders, taxi intervene, live overview, search, tickets.
 */

const { v4: uuidv4 } = require('uuid');
const {
  nowIso,
  normalizeObject,
  getPhoneVariants,
  phonesOverlap,
  resolvePhoneKey,
  selectSingle,
  selectSingleByPhone,
  selectMany,
  assertSupabaseAdmin,
  saveRow,
} = require('./common');
const { assertAdminAccess } = require('./users');
const { mapOrderRow, readOrderMeta, resolveRegisteredDeliveryAssignee } = require('./orders');
const { isApprovedMerchantCourier } = require('./merchant_couriers');
const { resolveOrderCancelActor } = require('../lib/order_cancel_actor');
const {
  END_REASONS,
  recordDeliveryAcceptance,
  recordDeliveryAssignmentEnd,
} = require('../lib/delivery_assignment_history');

const ACTIVE_ORDER_STATUSES = [
  'pending',
  'accepted',
  'preparing',
  'delivering',
  'adjustment_pending',
  'cancel_requested',
  'confirmed',
  'ready',
  'waiting',
  'return_pending',
];

const ACTIVE_TAXI_STATUSES = [
  'pending',
  'accepted',
  'on_way',
  'arrived',
  'picked_up',
  'cancel_requested',
  'return_waiting',
  'return_on_way',
  'return_arrived',
];

function sinceDaysIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** بداية اليوم الحالي بتوقيت بغداد (UTC+3) كـ ISO — لترتيب «اليوم». */
function iraqStartOfTodayIso() {
  const now = new Date();
  const baghdadMs = now.getTime() + 3 * 60 * 60 * 1000;
  const startOfBaghdadDay = new Date(baghdadMs);
  startOfBaghdadDay.setUTCHours(0, 0, 0, 0, 0);
  return new Date(startOfBaghdadDay.getTime() - 3 * 60 * 60 * 1000).toISOString();
}

function iraqDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** بداية اليوم بتوقيت بغداد (UTC+3) بصيغة ISO. */
function iraqTodayStartIso() {
  const now = Date.now();
  const iraqOffsetMs = 3 * 60 * 60 * 1000;
  const iraqNow = new Date(now + iraqOffsetMs);
  const y = iraqNow.getUTCFullYear();
  const m = iraqNow.getUTCMonth();
  const d = iraqNow.getUTCDate();
  return new Date(Date.UTC(y, m, d) - iraqOffsetMs).toISOString();
}

function phoneDigitsKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function enrichAdminOrder(mapped, meta) {
  const p = meta?.payload || {};
  const cancel = resolveOrderCancelActor(p, meta?.statusKey || mapped?.statusKey);
  return {
    ...mapped,
    statusAr: cancel.displayStatusAr || mapped.statusAr,
    cancelledBy: cancel.cancelledBy,
    cancelledByAr: cancel.cancelledByAr,
    cancelReasonKey: cancel.cancelReasonKey,
    noteAr: String(p.noteAr || mapped.noteAr || '').trim(),
    noteEn: String(p.noteEn || mapped.noteEn || '').trim(),
    disputeOpen: p.disputeOpen === true,
    disputeNote: String(p.disputeNote || '').trim(),
    disputeAt: p.disputeAt || null,
    adminNote: String(p.adminNote || '').trim(),
    adminUpdatedAt: p.adminUpdatedAt || null,
    deliveryAssignmentHistory: Array.isArray(p.deliveryAssignmentHistory)
      ? p.deliveryAssignmentHistory
      : [],
  };
}

async function getAdminOrders(adminPhone, query = {}) {
  await assertAdminAccess(adminPhone);
  const sinceIso = sinceDaysIso(7);
  const status = String(query.status || '').trim();
  const deliveryStatus = String(query.deliveryStatus || '').trim();
  const phone = String(query.phone || '').trim();
  const orderNumber = String(query.orderNumber || '').trim();
  const merchantPhone = String(query.merchantPhone || '').trim();
  const limit = Math.min(Math.max(Number(query.limit) || 80, 1), 150);

  const recentFilters = [
    { method: 'gte', column: 'created_at', value: sinceIso },
  ];
  if (phone) {
    recentFilters.push({ method: 'in', column: 'phone', value: getPhoneVariants(phone) });
  }
  if (merchantPhone) {
    recentFilters.push({
      method: 'in',
      column: 'merchant_phone',
      value: getPhoneVariants(merchantPhone),
    });
  }
  if (status) {
    recentFilters.push({ method: 'eq', column: 'status_key', value: status });
  }
  if (deliveryStatus) {
    recentFilters.push({ method: 'eq', column: 'delivery_status_key', value: deliveryStatus });
  }

  const recent = await selectMany(
    'customer_orders',
    recentFilters,
    { column: 'created_at', ascending: false },
    limit
  );

  const activeFilters = [
    { method: 'in', column: 'status_key', value: ACTIVE_ORDER_STATUSES },
    { method: 'lt', column: 'created_at', value: sinceIso },
  ];
  if (phone) {
    activeFilters.push({ method: 'in', column: 'phone', value: getPhoneVariants(phone) });
  }
  if (merchantPhone) {
    activeFilters.push({
      method: 'in',
      column: 'merchant_phone',
      value: getPhoneVariants(merchantPhone),
    });
  }
  const activeOlder = await selectMany(
    'customer_orders',
    activeFilters,
    { column: 'created_at', ascending: false },
    40
  );

  const byId = new Map();
  for (const row of [...recent, ...activeOlder]) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    byId.set(id, row);
  }

  let items = Array.from(byId.values()).map((row) => {
    const meta = readOrderMeta(row);
    return enrichAdminOrder(mapOrderRow(row), meta);
  });

  if (orderNumber) {
    const needle = orderNumber.toLowerCase();
    items = items.filter(
      (o) =>
        String(o.orderNumber || '').toLowerCase().includes(needle) ||
        String(o.id || '').toLowerCase().includes(needle)
    );
  }

  items.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return items.slice(0, limit);
}

async function getAdminOrderById(adminPhone, orderId) {
  await assertAdminAccess(adminPhone);
  const id = String(orderId || '').trim();
  if (!id) throw new Error('Order id is required.');
  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) throw new Error('Order not found.');
  const meta = readOrderMeta(row);
  return enrichAdminOrder(mapOrderRow(row), meta);
}

async function patchAdminOrder(orderId, mutator) {
  const id = String(orderId || '').trim();
  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) throw new Error('Order not found.');
  const meta = readOrderMeta(row);
  const nextPayload = { ...meta.payload };
  const dbUpdate = {
    updated_at: nowIso(),
  };
  await mutator({ meta, nextPayload, dbUpdate, row });
  nextPayload.adminUpdatedAt = nowIso();
  dbUpdate.order_payload = nextPayload;
  if (nextPayload.statusKey) dbUpdate.status_key = nextPayload.statusKey;
  if (nextPayload.deliveryStatusKey !== undefined) {
    dbUpdate.delivery_status_key = nextPayload.deliveryStatusKey || null;
  }
  if (nextPayload.courierPhone !== undefined) {
    dbUpdate.courier_phone = nextPayload.courierPhone || null;
  }
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('customer_orders')
    .update(dbUpdate)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Failed to update order.');
  const updatedMeta = readOrderMeta(data);
  return enrichAdminOrder(mapOrderRow(data), updatedMeta);
}

async function recordOrderAudit(adminPhone, action, order, extra = {}) {
  try {
    const { recordAdminAudit } = require('../lib/admin_audit');
    await recordAdminAudit({
      actorPhone: adminPhone,
      action,
      entityType: 'order',
      entityId: order?.id || extra.orderId,
      summaryAr: extra.summaryAr || `تعديل الطلب ${order?.orderNumber || order?.id || ''}`,
      details: {
        statusKey: order?.statusKey,
        deliveryStatusKey: order?.deliveryStatusKey,
        ...extra.details,
      },
    });
  } catch (error) {
    console.warn('order audit skipped:', error?.message || error);
  }
}

async function adminUpdateOrderStatus(adminPhone, orderId, body = {}) {
  await assertAdminAccess(adminPhone);
  const order = await patchAdminOrder(orderId, async ({ nextPayload }) => {
    const statusKey = String(body.statusKey || '').trim();
    const deliveryStatusKey = String(body.deliveryStatusKey || '').trim();
    const adminNote = String(body.adminNote || '').trim();
    if (statusKey) {
      nextPayload.statusKey = statusKey;
      nextPayload.statusAr =
        statusKey === 'cancelled'
          ? 'ملغي من الإدارة'
          : statusKey === 'completed'
            ? 'مكتمل'
            : statusKey === 'return_pending'
              ? 'بانتظار إرجاع الطلب للمتجر'
              : nextPayload.statusAr || statusKey;
    }
    // إكمال الأدمن يُكمل التوصيل حتماً — حتى لو لم ينقر المندوب على «تسليم».
    // بهذا تختفي الرحلة من «النشطة» لدى الزبون والمندوب فوراً.
    if (statusKey === 'completed') {
      nextPayload.deliveryStatusKey = 'delivered';
      nextPayload.deliveryStatusAr = 'تم التسليم';
      nextPayload.deliveryStatusEn = 'Delivered';
    } else if (body.deliveryStatusKey !== undefined) {
      nextPayload.deliveryStatusKey = deliveryStatusKey || null;
    }
    if (adminNote) nextPayload.adminNote = adminNote;
  });
  await recordOrderAudit(adminPhone, 'order.status', order, {
    summaryAr: `تعديل حالة الطلب إلى ${order.statusAr || order.statusKey}`,
    details: { statusKey: body.statusKey, deliveryStatusKey: body.deliveryStatusKey },
  });
  return order;
}

async function adminConfirmOrderReturn(adminPhone, orderId) {
  await assertAdminAccess(adminPhone);
  const order = await patchAdminOrder(orderId, async ({ meta, nextPayload }) => {
    if (String(meta.statusKey || '').trim() !== 'return_pending') {
      throw new Error('الطلب ليس في مسار الإرجاع للمتجر.');
    }
    nextPayload.statusKey = 'cancelled';
    nextPayload.statusAr = 'ملغي بعد إرجاع الطلب';
    nextPayload.statusEn = 'Cancelled after return';
    nextPayload.deliveryStatusKey = 'returned';
    nextPayload.deliveryStatusAr = 'استلم التاجر المنتج المُرجع';
    nextPayload.deliveryStatusEn = 'Merchant received returned goods';
    nextPayload.returnConfirmedAt = nowIso();
    nextPayload.returnConfirmedByAdmin = true;
  });
  await recordOrderAudit(adminPhone, 'order.return_confirm', order, {
    summaryAr: `تأكيد استلام الإرجاع للطلب ${order.orderNumber || order.id}`,
  });
  return order;
}

async function adminReassignCourier(adminPhone, orderId, body = {}) {
  await assertAdminAccess(adminPhone);
  const courierPhoneRaw = String(body.courierPhone || '').trim();
  const clear = body.clear === true || !courierPhoneRaw;
  const id = String(orderId || '').trim();
  if (!id) throw new Error('Order id is required.');

  const beforeRow = await selectSingle('customer_orders', 'id', id);
  if (!beforeRow) throw new Error('Order not found.');
  const previousMeta = readOrderMeta(beforeRow);

  let assignee = null;
  if (!clear) {
    assignee = await resolveRegisteredDeliveryAssignee(
      courierPhoneRaw || String(body.courierName || '').trim(),
    );
  }

  const beforePayload = normalizeObject(beforeRow.order_payload);
  const mode = String(
    beforePayload.courierModeEffective ||
      beforePayload.courierMode ||
      '',
  )
    .trim()
    .toLowerCase();
  if (!clear && mode === 'private' && body.forceOverride !== true) {
    const merchantPhone = String(
      beforeRow.merchant_phone || beforePayload.merchantPhone || '',
    ).trim();
    const linked = await isApprovedMerchantCourier(merchantPhone, assignee.phone);
    if (!linked) {
      throw new Error(
        'هذا الطلب بوضع مندوب خاص. عيّن مندوباً من أسطول المتجر أو أرسل forceOverride=true.',
      );
    }
  }

  const order = await patchAdminOrder(orderId, async ({ meta, nextPayload }) => {
    const previousPhone = String(
      nextPayload.courierPhone ||
        meta.courierPhone ||
        nextPayload.assignedCourierPhone ||
        '',
    ).trim();
    if (clear) {
      if (previousPhone) {
        Object.assign(
          nextPayload,
          recordDeliveryAssignmentEnd(nextPayload, {
            phone: previousPhone,
            reason: END_REASONS.ADMIN_CLEARED,
            at: nowIso(),
          }),
        );
      }
      nextPayload.courierPhone = null;
      nextPayload.assignedCourierPhone = null;
      nextPayload.assignedCourierName = '';
      nextPayload.deliveryAssigneeRole = '';
      nextPayload.courierAcceptedAt = null;
      nextPayload.deliveryStatusKey = 'waiting';
      nextPayload.deliveryStatusAr = 'بانتظار مندوب';
      nextPayload.deliveryStatusEn = 'Waiting for courier';
      if (nextPayload.statusKey !== 'cancelled' && nextPayload.statusKey !== 'completed') {
        nextPayload.statusKey = 'delivering';
      }
      return;
    }
    const courierPhone = assignee.phone;
    if (previousPhone && !phonesOverlap(previousPhone, courierPhone)) {
      Object.assign(
        nextPayload,
        recordDeliveryAssignmentEnd(nextPayload, {
          phone: previousPhone,
          reason: END_REASONS.ADMIN_REASSIGNED,
          at: nowIso(),
        }),
      );
    }
    const assignedAt = nowIso();
    nextPayload.courierPhone = courierPhone;
    nextPayload.assignedCourierPhone = courierPhone;
    nextPayload.assignedCourierName =
      String(body.courierName || '').trim() || assignee.name || courierPhone;
    nextPayload.deliveryAssigneeRole = assignee.role === 'driver' ? 'driver' : 'delivery';
    nextPayload.courierAcceptedAt = assignedAt;
    Object.assign(
      nextPayload,
      recordDeliveryAcceptance(nextPayload, {
        phone: courierPhone,
        name: nextPayload.assignedCourierName,
        role: nextPayload.deliveryAssigneeRole,
        source: 'admin',
        at: assignedAt,
      }),
    );
    nextPayload.deliveryStatusKey = 'accepted';
    nextPayload.deliveryStatusAr =
      assignee.role === 'driver' ? 'الكابتن في الطريق للمتجر' : 'المندوب في الطريق للمتجر';
    nextPayload.deliveryStatusEn = 'Assigned by admin';
    if (nextPayload.statusKey !== 'cancelled' && nextPayload.statusKey !== 'completed') {
      nextPayload.statusKey = 'delivering';
    }
  });

  try {
    const afterRow = await selectSingle('customer_orders', 'id', id);
    const { onOrderSaved } = require('../push_events');
    await onOrderSaved({
      previousMeta,
      nextMeta: readOrderMeta(afterRow),
      isNew: false,
    });
  } catch (pushError) {
    console.error('admin reassign courier push error:', pushError?.message || pushError);
  }

  await recordOrderAudit(adminPhone, 'order.reassign', order, {
    summaryAr: clear
      ? `إرجاع الطلب ${order.orderNumber || order.id} إلى قائمة المندوبين`
      : `تعيين ${assignee?.name || 'مندوب'} للطلب ${order.orderNumber || order.id}`,
    details: { courierPhone: assignee?.phone || courierPhoneRaw, clear },
  });
  return order;
}

async function adminCancelOrder(adminPhone, orderId, body = {}) {
  await assertAdminAccess(adminPhone);
  const reason = String(body.reason || '').trim() || 'ألغته الإدارة';
  const order = await patchAdminOrder(orderId, async ({ nextPayload }) => {
    nextPayload.statusKey = 'cancelled';
    nextPayload.statusAr = 'ملغي من الإدارة';
    nextPayload.statusEn = 'Cancelled by admin';
    nextPayload.cancelledBy = 'admin';
    nextPayload.noteAr = reason;
    nextPayload.adminNote = reason;
    nextPayload.cancellationReason = reason;
  });
  await recordOrderAudit(adminPhone, 'order.cancel', order, {
    summaryAr: `إلغاء الطلب ${order.orderNumber || order.id}`,
    details: { reason },
  });
  return order;
}

async function adminDisputeOrder(adminPhone, orderId, body = {}) {
  await assertAdminAccess(adminPhone);
  const open = body.open !== false;
  const note = String(body.note || '').trim();
  const order = await patchAdminOrder(orderId, async ({ nextPayload }) => {
    nextPayload.disputeOpen = open;
    nextPayload.disputeNote = note || nextPayload.disputeNote || '';
    nextPayload.disputeAt = open ? nowIso() : nextPayload.disputeAt || nowIso();
    if (!open) nextPayload.disputeResolvedAt = nowIso();
  });
  await recordOrderAudit(adminPhone, open ? 'order.dispute_open' : 'order.dispute_close', order, {
    summaryAr: open
      ? `فتح نزاع على الطلب ${order.orderNumber || order.id}`
      : `إغلاق نزاع الطلب ${order.orderNumber || order.id}`,
    details: { note },
  });
  return order;
}

function formatTaxiRow(row) {
  const taxiRepo = require('../domains/taxi/repository/taxi');
  return taxiRepo.formatTaxiRequestForAdmin(row);
}

/**
 * يكمل اسم الزبون (من app_users) للرحلات التي لا تحمل اسماً في
 * request_payload — بحيث تظهر أسماء الزبائن في لوحة تشغيل التكسي.
 */
async function enrichTaxiTripsWithCustomerNames(trips) {
  const phonesToResolve = new Set();
  for (const trip of trips) {
    const phone = String(trip.customerPhone || '').trim();
    const name = String(trip.customerName || '').trim();
    if (phone && !name) phonesToResolve.add(phone);
  }
  if (phonesToResolve.size === 0) return trips;

  const supabase = assertSupabaseAdmin();
  const { data: users, error } = await supabase
    .from('app_users')
    .select('phone, full_name, name')
    .in('phone', Array.from(phonesToResolve));
  if (error) {
    console.error('enrich taxi customer names error:', error.message);
    return trips;
  }
  const byVariant = new Map();
  for (const user of users || []) {
    for (const variant of getPhoneVariants(String(user.phone || ''))) {
      if (!byVariant.has(variant)) byVariant.set(variant, user);
    }
  }
  for (const trip of trips) {
    const phone = String(trip.customerPhone || '').trim();
    if (String(trip.customerName || '').trim()) continue;
    const user = byVariant.get(phone);
    const fullName = String(
      user?.full_name || user?.name || ''
    ).trim();
    if (!fullName) continue;
    const parts = fullName.split(/\s+/).filter(Boolean);
    trip.customerName =
      parts.length <= 2 ? fullName : `${parts[0]} ${parts[1]}`;
  }
  return trips;
}

async function getAdminTaxiTripById(adminPhone, requestId) {
  await assertAdminAccess(adminPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Trip not found.');
  const taxiRepo = require('../domains/taxi/repository/taxi');
  const trip = formatTaxiRow(row);
  await taxiRepo.attachTaxiPushAudits(trip);
  return trip;
}

async function adminCancelTaxiTrip(adminPhone, requestId, body = {}) {
  await assertAdminAccess(adminPhone);
  const id = String(requestId || '').trim();
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Trip not found.');
  const payload = normalizeObject(row.request_payload);
  const reason = String(body.reason || '').trim() || 'ألغته الإدارة';
  const nextPayload = {
    ...payload,
    statusKey: 'cancelled',
    statusAr: 'ملغي من الإدارة',
    cancellationReason: reason,
    adminCancelledAt: nowIso(),
    adminCancelReason: reason,
    cancelledBy: 'admin',
    cancelledByAr: 'ألغتها الإدارة',
  };
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('taxi_requests')
    .update({
      status_key: 'cancelled',
      request_payload: nextPayload,
      cancellation_reason: reason,
      updated_at: nowIso(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Failed to cancel trip.');

  // إشعار فوري للزبون والكابتن بإلغاء الإدارة للرحلة (حتى لو كانت مقبولة/نشطة).
  try {
    const customerPhone = String(row.phone ?? payload.customerPhone ?? '').trim();
    const driverPhone = String(row.driver_phone ?? payload.driverPhone ?? '').trim();
    const { notifyTripCancelled } = require('../push/taxi_push_events');
    await notifyTripCancelled(customerPhone, driverPhone, `ألغته الإدارة: ${reason}`, id);
  } catch (pushError) {
    console.error('taxi admin cancel push error:', pushError?.message || pushError);
  }

  return formatTaxiRow(data);
}

async function adminCompleteTaxiTrip(adminPhone, requestId) {
  await assertAdminAccess(adminPhone);
  const id = String(requestId || '').trim();
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Trip not found.');
  const payload = normalizeObject(row.request_payload);
  const completedAt = nowIso();
  const nextPayload = {
    ...payload,
    statusKey: 'completed',
    statusAr: 'اكتملت الرحلة',
    completedAt,
    cashCollected: true,
    adminCompletedAt: completedAt,
  };
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('taxi_requests')
    .update({
      status_key: 'completed',
      request_payload: nextPayload,
      completed_at: completedAt,
      cash_collected: true,
      updated_at: completedAt,
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Failed to complete trip.');
  return formatTaxiRow(data);
}

/**
 * إنشاء طلب تكسي نيابة عن زبون.
 * - tripMode=open → رحلة مفتوحة (عداد) تبدأ عند «صعد زبون»
 * - غير ذلك → رحلة عادية بانطلاق ووصول
 */
async function adminCreateTaxiTrip(adminPhone, body = {}) {
  await assertAdminAccess(adminPhone);
  const customerPhone = String(body.customerPhone || body.phone || '').trim();
  if (!customerPhone) {
    throw new Error('رقم الزبون مطلوب.');
  }

  const pickupLat = Number(body.pickupLat);
  const pickupLng = Number(body.pickupLng);
  const dropoffLat = Number(body.dropoffLat);
  const dropoffLng = Number(body.dropoffLng);
  const tripMode = String(body.tripMode || '').trim() === 'open' ? 'open' : '';
  const coordsOk = (lat, lng) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) > 0.0001 &&
    Math.abs(lng) > 0.0001;

  if (!coordsOk(pickupLat, pickupLng)) {
    throw new Error('حدد نقطة الانطلاق على الخريطة.');
  }

  const pickupAddress =
    String(body.pickupAddress || '').trim() ||
    `انطلاق (${pickupLat.toFixed(5)}, ${pickupLng.toFixed(5)})`;

  const { createTaxiRequest } = require('../domains/taxi/repository/taxi');

  if (tripMode === 'open') {
    const trip = await createTaxiRequest(customerPhone, {
      pickupAddress,
      dropoffAddress: 'رحلة مفتوحة',
      pickupLat,
      pickupLng,
      dropoffLat: 0,
      dropoffLng: 0,
      distanceKm: 0,
      taxiType: 'economic',
      tripMode: 'open',
      serviceKind: 'open_trip',
      customerName: body.customerName || body.fullName,
      createdViaAdmin: true,
      adminCreatedBy: String(adminPhone || '').trim(),
    });
    return trip;
  }

  if (!coordsOk(dropoffLat, dropoffLng)) {
    throw new Error('حدد نقطة الوصول على الخريطة.');
  }

  const dropoffAddress =
    String(body.dropoffAddress || '').trim() ||
    `وصول (${dropoffLat.toFixed(5)}, ${dropoffLng.toFixed(5)})`;

  const trip = await createTaxiRequest(customerPhone, {
    pickupAddress,
    dropoffAddress,
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
    distanceKm: Number(body.distanceKm) || 0,
    confirmedFare: body.confirmedFare,
    taxiType: body.taxiType || 'economic',
    tripType: body.tripType || 'one_way',
    waitingMinutes: body.waitingMinutes,
    waypoints: body.waypoints,
    customerName: body.customerName || body.fullName,
    createdViaAdmin: true,
    adminCreatedBy: String(adminPhone || '').trim(),
  });

  return trip;
}

async function adminAssignTaxiCaptain(adminPhone, requestId, body = {}) {
  await assertAdminAccess(adminPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');
  const driverPhone = String(body.driverPhone || '').trim();
  if (!driverPhone) throw new Error('اختر كابتاً من القائمة.');

  const beforeRow = await selectSingle('taxi_requests', 'id', id);
  if (!beforeRow) throw new Error('Trip not found.');
  const beforePayload = normalizeObject(beforeRow.request_payload);
  const previousDriverPhone = String(
    beforeRow.driver_phone || beforePayload.driverPhone || '',
  ).trim();

  const taxiRepo = require('../domains/taxi/repository/taxi');
  const trip = await taxiRepo.adminAssignTaxiRequest(id, driverPhone, { adminPhone });

  try {
    const { recordAdminAudit } = require('../lib/admin_audit');
    await recordAdminAudit({
      actorPhone: adminPhone,
      action: 'taxi.assign_captain',
      entityType: 'taxi_request',
      entityId: id,
      summaryAr: `تعيين كابتن ${trip.driverName || driverPhone} للرحلة ${trip.requestNumber || id}`,
      details: {
        driverPhone: trip.driverPhone || driverPhone,
        previousDriverPhone: previousDriverPhone || null,
      },
    });
  } catch (_) {}

  return trip;
}

async function adminRematchTaxiTrip(adminPhone, requestId, body = {}) {
  await assertAdminAccess(adminPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const beforeRow = await selectSingle('taxi_requests', 'id', id);
  if (!beforeRow) throw new Error('Trip not found.');
  const beforePayload = normalizeObject(beforeRow.request_payload);
  const previousDriverPhone = String(
    beforeRow.driver_phone || beforePayload.driverPhone || '',
  ).trim();

  const taxiRepo = require('../domains/taxi/repository/taxi');
  const trip = await taxiRepo.adminRematchTaxiRequest(id, {
    adminPhone,
    reason: body.reason,
  });

  try {
    const { recordAdminAudit } = require('../lib/admin_audit');
    await recordAdminAudit({
      actorPhone: adminPhone,
      action: 'taxi.rematch',
      entityType: 'taxi_request',
      entityId: id,
      summaryAr: `إعادة إرسال الرحلة ${trip.requestNumber || id} للكباتن`,
      details: {
        previousDriverPhone: previousDriverPhone || null,
        reason: String(body.reason || '').trim() || null,
      },
    });
  } catch (_) {}

  return trip;
}

async function adminResolveTaxiComplaint(adminPhone, requestId, body = {}) {
  await assertAdminAccess(adminPhone);
  const id = String(requestId || '').trim();
  const note = String(body.note || '').trim();
  const supabase = assertSupabaseAdmin();

  // الجدول الجديد أولاً (taxi_complaints) — بالمعرّف أو بالرحلة.
  let complaint = null;
  try {
    const { data, error } = await supabase
      .from('taxi_complaints')
      .update({
        status: 'resolved',
        resolved_at: nowIso(),
        resolution_note: note,
        resolved_by: String(adminPhone || '').trim(),
      })
      .or(`id.eq.${id},request_id.eq.${id}`)
      .select()
      .maybeSingle();
    if (!error && data) complaint = data;
  } catch (_) {
    complaint = null;
  }

  // مسح علم مراجعة الشكوى من payload الرحلة (توافق مع القديم).
  if (complaint && complaint.request_id) {
    const tripRow = await selectSingle('taxi_requests', 'id', complaint.request_id);
    if (tripRow) {
      const tripPayload = normalizeObject(tripRow.request_payload);
      await supabase
        .from('taxi_requests')
        .update({
          request_payload: {
            ...tripPayload,
            adminReviewRequired: false,
            adminComplaintNote: note,
            adminResolvedAt: nowIso(),
          },
          updated_at: nowIso(),
        })
        .eq('id', complaint.request_id);
    }
  }

  if (complaint) {
    const row = await selectSingle('taxi_requests', 'id', complaint.request_id);
    if (row) {
      try {
        const { sendPushToPhone } = require('../push_events');
        const targets = [complaint.customer_phone, complaint.driver_phone].filter(Boolean);
        for (const phone of targets) {
          await sendPushToPhone(
            phone,
            {
              title: 'تمت معالجة شكواك',
              body: 'قامت الإدارة بمعالجة شكواك — شكراً لتعاونك',
              data: {
                eventKey: 'taxi:complaint_resolved',
                orderId: complaint.request_id,
                requestId: complaint.request_id,
                category: 'taxi',
              },
            },
            { showSystemBanner: true, immediate: true }
          );
        }
      } catch (pushError) {
        console.error('taxi complaint resolved push error:', pushError?.message || pushError);
      }
      return formatTaxiRow(row);
    }
    return { success: true, complaint };
  }

  // التوافق مع القديم: لا يوجد صف في الجدول الجديد — نحدّث taxi_requests مباشرة.
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Trip not found.');
  const payload = normalizeObject(row.request_payload);
  const nextPayload = {
    ...payload,
    adminReviewRequired: false,
    adminComplaintNote: note,
    adminResolvedAt: nowIso(),
  };
  const { data, error } = await supabase
    .from('taxi_requests')
    .update({
      request_payload: nextPayload,
      updated_at: nowIso(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Failed to resolve complaint.');

  try {
    const { sendPushToPhone } = require('../push_events');
    const customerPhone = String(row.phone ?? payload.customerPhone ?? '').trim();
    const driverPhone = String(row.driver_phone ?? payload.driverPhone ?? '').trim();
    const targets = [customerPhone, driverPhone].filter(Boolean);
    for (const phone of targets) {
      await sendPushToPhone(
        phone,
        {
          title: 'تمت معالجة شكواك',
          body: 'قامت الإدارة بمعالجة شكواك — شكراً لتعاونك',
          data: {
            eventKey: 'taxi:complaint_resolved',
            orderId: id,
            requestId: id,
            category: 'taxi',
          },
        },
        { showSystemBanner: true, immediate: true }
      );
    }
  } catch (pushError) {
    console.error('taxi complaint resolved push error:', pushError?.message || pushError);
  }

  return formatTaxiRow(data);
}

async function getAdminTaxiTripsFiltered(adminPhone, query = {}) {
  await assertAdminAccess(adminPhone);
  const status = String(query.status || '').trim();
  const phone = String(query.phone || '').trim();
  const requestId = String(query.requestId || '').trim();
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 50);
  const page = Math.max(Number(query.page) || 1, 1);
  const sinceIso = sinceDaysIso(7);

  const baseFilters = [{ method: 'gte', column: 'created_at', value: sinceIso }];
  if (phone) baseFilters.push({ method: 'in', column: 'phone', value: getPhoneVariants(phone) });
  if (requestId) baseFilters.push({ method: 'eq', column: 'id', value: requestId });

  // قائمة العرض — مع فلتر الحالة إن وُجد
  const listFilters = [...baseFilters];
  if (status === 'active') {
    listFilters.push({ method: 'in', column: 'status_key', value: ACTIVE_TAXI_STATUSES });
  } else if (status) {
    listFilters.push({ method: 'eq', column: 'status_key', value: status });
  }

  const rows = await selectMany(
    'taxi_requests',
    listFilters,
    { column: 'created_at', ascending: false },
    2000
  );

  // دمج الرحلات النشطة الأقدم من 7 أيام فقط لعرض التشغيل المباشر،
  // وليس عند تصفية المكتملة/الملغاة حتى لا تختلط القوائم.
  const shouldMergeOlderActive =
    !status ||
    status === 'active' ||
    ACTIVE_TAXI_STATUSES.includes(status);

  let activeOlder = [];
  if (shouldMergeOlderActive) {
    const olderFilters = [
      {
        method: 'in',
        column: 'status_key',
        value:
          status && status !== 'active' ? [status] : ACTIVE_TAXI_STATUSES,
      },
      { method: 'lt', column: 'created_at', value: sinceIso },
    ];
    if (phone) {
      olderFilters.push({ method: 'in', column: 'phone', value: getPhoneVariants(phone) });
    }
    if (requestId) {
      olderFilters.push({ method: 'eq', column: 'id', value: requestId });
    }
    activeOlder = await selectMany(
      'taxi_requests',
      olderFilters,
      { column: 'created_at', ascending: false },
      40
    );
  }

  const byId = new Map();
  for (const row of [...rows, ...activeOlder]) {
    byId.set(String(row.id), row);
  }
  const all = Array.from(byId.values())
    .map(formatTaxiRow)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  await enrichTaxiTripsWithCustomerNames(all);

  const total = all.length;
  const offset = (page - 1) * limit;
  const items = all.slice(offset, offset + limit);
  const taxiRepo = require('../domains/taxi/repository/taxi');
  await taxiRepo.attachTaxiPushAudits(items);

  // إحصاءات البطاقات من نافذة 7 أيام (+ النشطة الأقدم) بغض النظر عن فلتر الحالة،
  // حتى تبقى الأرقام صحيحة عند عرض المكتملة/الملغاة فقط.
  let statsRows = all;
  if (status) {
    const statsRecent = await selectMany(
      'taxi_requests',
      baseFilters,
      { column: 'created_at', ascending: false },
      2000
    );
    const statsOlder = await selectMany(
      'taxi_requests',
      [
        { method: 'in', column: 'status_key', value: ACTIVE_TAXI_STATUSES },
        { method: 'lt', column: 'created_at', value: sinceIso },
        ...(phone
          ? [{ method: 'in', column: 'phone', value: getPhoneVariants(phone) }]
          : []),
        ...(requestId
          ? [{ method: 'eq', column: 'id', value: requestId }]
          : []),
      ],
      { column: 'created_at', ascending: false },
      40
    );
    const statsMap = new Map();
    for (const row of [...statsRecent, ...statsOlder]) {
      statsMap.set(String(row.id), row);
    }
    statsRows = Array.from(statsMap.values()).map(formatTaxiRow);
  }

  const completedTrips = statsRows.filter((t) => t.statusKey === 'completed');
  const completedFareTotal = completedTrips.reduce(
    (sum, t) => sum + (Number(t.fare) || 0),
    0,
  );

  // رحلات اليوم — عدد مستقل عن فلاتر البحث (بتوقيت بغداد).
  let tripsToday = statsRows.filter(
    (t) => iraqDayKey(t.createdAt) === iraqDayKey(new Date().toISOString()),
  ).length;
  try {
    const supabase = assertSupabaseAdmin();
    const { count, error } = await supabase
      .from('taxi_requests')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', iraqTodayStartIso());
    if (!error) tripsToday = Number(count || 0);
  } catch (_) {}

  const stats = {
    total: statsRows.length,
    tripsToday,
    pending: statsRows.filter((t) => t.statusKey === 'pending').length,
    active: statsRows.filter(
      (t) =>
        ACTIVE_TAXI_STATUSES.includes(t.statusKey) &&
        t.statusKey !== 'pending',
    ).length,
    completed: completedTrips.length,
    cancelled: statsRows.filter((t) => t.statusKey === 'cancelled').length,
    completedFareTotal,
  };

  return { items, total, page, limit, stats };
}

/**
 * تقييمات رحلات التكسي (تقييم الزبون للكابتن بعد اكتمال الرحلة).
 * @param {string} adminPhone
 * @param {{
 *   days?: number,
 *   page?: number,
 *   limit?: number,
 *   minRating?: number,
 *   maxRating?: number,
 *   phone?: string,
 *   needsReview?: boolean|string,
 * }} [query]
 */
async function getAdminTaxiRatings(adminPhone, query = {}) {
  await assertAdminAccess(adminPhone);
  const days = Math.min(Math.max(Number(query.days) || 90, 1), 365);
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  const minRatingRaw = query.minRating;
  const maxRatingRaw = query.maxRating;
  const minRating =
    minRatingRaw === undefined || minRatingRaw === null || minRatingRaw === ''
      ? null
      : Number(minRatingRaw);
  const maxRating =
    maxRatingRaw === undefined || maxRatingRaw === null || maxRatingRaw === ''
      ? null
      : Number(maxRatingRaw);
  const phone = String(query.phone || '').trim();
  const needsReview =
    query.needsReview === true ||
    query.needsReview === '1' ||
    query.needsReview === 'true';
  const sinceIso = sinceDaysIso(days);
  const supabase = assertSupabaseAdmin();

  let dbQuery = supabase
    .from('taxi_requests')
    .select('*')
    .eq('status_key', 'completed')
    .gt('driver_rating', 0)
    .gte('updated_at', sinceIso)
    .order('updated_at', { ascending: false })
    .limit(3000);

  if (Number.isFinite(minRating)) {
    dbQuery = dbQuery.gte('driver_rating', minRating);
  }
  if (Number.isFinite(maxRating)) {
    dbQuery = dbQuery.lte('driver_rating', maxRating);
  }

  const { data, error } = await dbQuery;
  if (error) throw new Error(error.message);

  const phoneVariants = phone ? new Set(getPhoneVariants(phone)) : null;

  let items = (data || [])
    .map(formatTaxiRow)
    .filter(Boolean)
    .filter((trip) => {
      const rating = Number(trip.driverRating || 0);
      if (!(rating > 0)) return false;
      if (needsReview && !trip.adminReviewRequired) return false;
      if (phoneVariants) {
        const customer = String(trip.customerPhone || '').trim();
        const driver = String(trip.driverPhone || '').trim();
        const matchCustomer = getPhoneVariants(customer).some((v) =>
          phoneVariants.has(v),
        );
        const matchDriver = getPhoneVariants(driver).some((v) =>
          phoneVariants.has(v),
        );
        if (!matchCustomer && !matchDriver) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aAt = Date.parse(a.ratedAt || a.updatedAt || a.completedAt || a.createdAt || 0);
      const bAt = Date.parse(b.ratedAt || b.updatedAt || b.completedAt || b.createdAt || 0);
      return bAt - aAt;
    });

  const total = items.length;
  const ratingSum = items.reduce((sum, t) => sum + (Number(t.driverRating) || 0), 0);
  const lowCount = items.filter((t) => Number(t.driverRating) <= 2).length;
  const withComment = items.filter(
    (t) => String(t.ratingComment || '').trim().length > 0,
  ).length;
  const needsReviewCount = items.filter((t) => t.adminReviewRequired).length;

  const stats = {
    total,
    averageRating: total > 0 ? Math.round((ratingSum / total) * 10) / 10 : 0,
    lowCount,
    withComment,
    needsReviewCount,
    days,
  };

  const offset = (page - 1) * limit;
  items = items.slice(offset, offset + limit);

  return { items, total, page, limit, stats };
}

/**
 * ترتيب كباتن التكسي حسب الأداء (مكتملة / ملغاة / مجموع أجور المكتملة).
 * @param {string} adminPhone
 * @param {{ days?: number, limit?: number }} [query]
 */
async function getAdminTaxiCaptainLeaderboard(adminPhone, query = {}) {
  await assertAdminAccess(adminPhone);
  const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100);
  const period = String(query.period || '').trim().toLowerCase();
  let sinceIso;
  if (period === 'today') {
    sinceIso = iraqStartOfTodayIso();
  } else {
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 90);
    sinceIso = sinceDaysIso(days);
  }
  const supabase = assertSupabaseAdmin();

  const { data, error } = await supabase
    .from('taxi_requests')
    .select('driver_phone, driver_name, status_key, fare, created_at, request_payload')
    .gte('created_at', sinceIso)
    .not('driver_phone', 'is', null)
    .neq('driver_phone', '')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error) throw new Error(error.message);

  /** @type {Map<string, {
   *   driverPhone: string,
   *   driverName: string,
   *   completedCount: number,
   *   cancelledCount: number,
   *   totalTrips: number,
   *   totalFares: number,
   * }>} */
  const byDriver = new Map();

  for (const row of data || []) {
    const phone = String(row.driver_phone || '').trim();
    const key = phoneDigitsKey(phone);
    if (!key) continue;

    const payload =
      row.request_payload && typeof row.request_payload === 'object'
        ? row.request_payload
        : {};
    const name = String(row.driver_name || payload.driverName || '').trim();
    const status = String(row.status_key || payload.statusKey || '').trim();
    const fare = Number(row.fare ?? payload.fare ?? 0) || 0;

    let entry = byDriver.get(key);
    if (!entry) {
      entry = {
        driverPhone: phone,
        driverName: name,
        completedCount: 0,
        cancelledCount: 0,
        totalTrips: 0,
        totalFares: 0,
      };
      byDriver.set(key, entry);
    } else if (!entry.driverName && name) {
      entry.driverName = name;
    }

    entry.totalTrips += 1;
    if (status === 'completed' || status === 'done') {
      entry.completedCount += 1;
      entry.totalFares += fare;
    } else if (status === 'cancelled') {
      entry.cancelledCount += 1;
    }
  }

  const items = Array.from(byDriver.values())
    .sort((a, b) => {
      if (b.completedCount !== a.completedCount) {
        return b.completedCount - a.completedCount;
      }
      if (b.totalFares !== a.totalFares) return b.totalFares - a.totalFares;
      return b.totalTrips - a.totalTrips;
    })
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
      driverName: item.driverName || 'كابتن',
    }));

  return {
    days: period === 'today' ? 1 : Math.min(Math.max(Number(query.days) || 30, 1), 90),
    period: period || 'days',
    generatedAt: nowIso(),
    items,
  };
}

async function getAdminLiveOverview(adminPhone) {
  await assertAdminAccess(adminPhone);
  const supabase = assertSupabaseAdmin();
  const { getDeviceTokensForPhone } = require('./push_notifications');
  const { readCourierLiveLocations } = require('./operator_profiles');

  async function pushMetaForPhones(phones) {
    const unique = [...new Set((phones || []).map((p) => String(p || '').trim()).filter(Boolean))];
    const byPhone = new Map();
    await Promise.all(
      unique.map(async (phone) => {
        try {
          const tokens = await getDeviceTokensForPhone(phone);
          const tokenCount = (tokens || []).filter((t) => String(t.token || '').trim()).length;
          byPhone.set(phone, {
            hasPushToken: tokenCount > 0,
            tokenCount,
          });
        } catch (_) {
          byPhone.set(phone, { hasPushToken: false, tokenCount: 0 });
        }
      }),
    );
    return byPhone;
  }

  let drivers = [];
  try {
    // نفس شروط استهداف طلبات التكسي تقريباً: متصل + متاح + معتمد
    const { data, error } = await supabase
      .from('driver_locations')
      .select(
        'phone, driver_name, taxi_type, plate_number, lat, lng, is_online, available, is_approved, updated_at, location_updated_at',
      )
      .eq('is_online', true)
      .eq('available', true)
      .eq('is_approved', true)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (!error && Array.isArray(data)) {
      const pushByPhone = await pushMetaForPhones(data.map((row) => row.phone));
      drivers = data.map((row) => {
        const phone = String(row.phone || '').trim();
        const push = pushByPhone.get(phone) || { hasPushToken: false, tokenCount: 0 };
        return {
          phone,
          name: String(row.driver_name || '').trim(),
          lat: Number(row.lat || 0),
          lng: Number(row.lng || 0),
          taxiType: String(row.taxi_type || '').trim(),
          plateNumber: String(row.plate_number || '').trim(),
          updatedAt: row.location_updated_at || row.updated_at || null,
          hasPushToken: push.hasPushToken,
          tokenCount: push.tokenCount,
          canReceiveRequests: push.hasPushToken,
          mapsUrl:
            Number(row.lat) && Number(row.lng)
              ? `https://www.google.com/maps?q=${row.lat},${row.lng}`
              : null,
        };
      });
    }
  } catch (_) {}

  const taxiByType = {};
  for (const d of drivers) {
    const key = d.taxiType || 'unknown';
    taxiByType[key] = (taxiByType[key] || 0) + 1;
  }

  let couriers = [];
  try {
    const { data: courierRows, error: courierError } = await supabase
      .from('courier_profiles')
      .select('phone, display_name, available, is_approved, is_suspended, updated_at, profile_payload')
      .eq('is_approved', true)
      .eq('available', true)
      .eq('is_suspended', false)
      .order('updated_at', { ascending: false })
      .limit(300);
    if (!courierError && Array.isArray(courierRows) && courierRows.length) {
      const phones = [
        ...new Set(
          courierRows.map((row) => String(row.phone || '').trim()).filter(Boolean),
        ),
      ];
      const { data: userRows } = await supabase
        .from('app_users')
        .select('phone, role')
        .in('phone', phones)
        .eq('role', 'delivery');
      const deliveryPhones = new Set(
        (userRows || []).map((row) => String(row.phone || '').trim()).filter(Boolean),
      );
      const activeRows = courierRows.filter((row) =>
        deliveryPhones.has(String(row.phone || '').trim()),
      );
      const liveByKey = await readCourierLiveLocations(
        activeRows.map((row) => String(row.phone || '').trim()),
      );
      const pushByPhone = await pushMetaForPhones(
        activeRows.map((row) => String(row.phone || '').trim()),
      );

      couriers = activeRows.map((row) => {
        const phone = String(row.phone || '').trim();
        const digits = phone.replace(/\D/g, '').slice(-10);
        const live = liveByKey.get(digits) || null;
        const push = pushByPhone.get(phone) || { hasPushToken: false, tokenCount: 0 };
        const liveNow = Boolean(
          live &&
            Number.isFinite(Number(live.lat)) &&
            Number.isFinite(Number(live.lng)) &&
            Math.abs(Number(live.lat)) > 0.0001,
        );
        const payload =
          row.profile_payload && typeof row.profile_payload === 'object'
            ? row.profile_payload
            : {};
        return {
          phone,
          name: String(row.display_name || payload.name || '').trim(),
          updatedAt: row.updated_at || null,
          liveNow,
          liveUpdatedAt: live?.updatedAt || null,
          lat: liveNow ? Number(live.lat) : null,
          lng: liveNow ? Number(live.lng) : null,
          hasPushToken: push.hasPushToken,
          tokenCount: push.tokenCount,
          canReceiveOrders: push.hasPushToken,
          mapsUrl:
            liveNow && live
              ? `https://www.google.com/maps?q=${live.lat},${live.lng}`
              : null,
        };
      });
    }
  } catch (_) {}

  const taxiActive = await selectMany(
    'taxi_requests',
    [{ method: 'in', column: 'status_key', value: ACTIVE_TAXI_STATUSES }],
    { column: 'updated_at', ascending: false },
    60
  );

  const deliveryActive = await selectMany(
    'customer_orders',
    [{ method: 'in', column: 'status_key', value: ['delivering', 'preparing', 'accepted', 'pending'] }],
    { column: 'updated_at', ascending: false },
    60
  );

  let openComplaints = 0;
  let openTickets = 0;
  let latestComplaintAt = null;
  let latestTicketAt = null;
  try {
    const cCount = await supabase
      .from('taxi_complaints')
      .select('updated_at', { count: 'exact', head: true })
      .eq('status', 'open');
    if (!cCount.error) openComplaints = Number(cCount.count || 0);
    const cLatest = await supabase
      .from('taxi_complaints')
      .select('updated_at')
      .eq('status', 'open')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (!cLatest.error && cLatest.data?.length) {
      latestComplaintAt = cLatest.data[0].updated_at;
    }
  } catch (_) {}
  try {
    const tCount = await supabase
      .from('support_tickets')
      .select('updated_at', { count: 'exact', head: true })
      .eq('status', 'open');
    if (!tCount.error) openTickets = Number(tCount.count || 0);
    const tLatest = await supabase
      .from('support_tickets')
      .select('updated_at')
      .eq('status', 'open')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (!tLatest.error && tLatest.data?.length) {
      latestTicketAt = tLatest.data[0].updated_at;
    }
  } catch (_) {}

  const taxiReadyWithPush = drivers.filter((d) => d.hasPushToken).length;
  const couriersLiveNow = couriers.filter((c) => c.liveNow).length;
  const couriersReadyWithPush = couriers.filter((c) => c.hasPushToken).length;

  return {
    driversOnline: drivers.length,
    taxiCaptainsReady: drivers.length,
    taxiCaptainsReadyWithPush: taxiReadyWithPush,
    taxiCaptainsByType: taxiByType,
    couriersAvailable: couriers.length,
    couriersLiveNow,
    couriersReadyWithPush,
    activeTaxiTrips: taxiActive.length,
    activeOrders: deliveryActive.length,
    openComplaints,
    openTickets,
    latestComplaintAt,
    latestTicketAt,
    drivers,
    couriers,
    taxiTrips: taxiActive.map(formatTaxiRow),
    orders: deliveryActive.map((row) => {
      const meta = readOrderMeta(row);
      return enrichAdminOrder(mapOrderRow(row), meta);
    }),
    refreshedAt: nowIso(),
  };
}

async function adminUnifiedSearch(adminPhone, q) {
  await assertAdminAccess(adminPhone);
  const query = String(q || '').trim();
  if (query.length < 3) {
    throw new Error('أدخل 3 أحرف على الأقل للبحث.');
  }

  const accounts = [];
  const orders = [];
  const trips = [];
  const looksPhone = /[0-9+]{6,}/.test(query);

  if (looksPhone) {
    const variants = getPhoneVariants(query);
    try {
      const { getUserState } = require('./users');
      const phoneKey = await resolvePhoneKey(query);
      const state = await getUserState(phoneKey);
      if (state || phoneKey) {
        accounts.push({
          phone: phoneKey,
          name: String(state?.customerName || state?.name || '').trim(),
          role: String(state?.userRole || state?.role || '').trim(),
          href: `/admin/accounts?q=${encodeURIComponent(phoneKey)}`,
        });
      }
      const orderRows = await selectMany(
        'customer_orders',
        [{ method: 'in', column: 'phone', value: variants }],
        { column: 'created_at', ascending: false },
        10
      );
      for (const row of orderRows) {
        const meta = readOrderMeta(row);
        orders.push({
          ...enrichAdminOrder(mapOrderRow(row), meta),
          href: `/admin/orders?id=${encodeURIComponent(meta.id)}`,
        });
      }
      const tripRows = await selectMany(
        'taxi_requests',
        [{ method: 'in', column: 'phone', value: variants }],
        { column: 'created_at', ascending: false },
        10
      );
      for (const row of tripRows) {
        const trip = formatTaxiRow(row);
        trips.push({
          ...trip,
          href: `/admin/taxi?id=${encodeURIComponent(trip.id)}`,
        });
      }
    } catch (_) {}
  }

  try {
    const orderById = await selectSingle('customer_orders', 'id', query);
    if (orderById) {
      const meta = readOrderMeta(orderById);
      orders.push({
        ...enrichAdminOrder(mapOrderRow(orderById), meta),
        href: `/admin/orders?id=${encodeURIComponent(meta.id)}`,
      });
    }
  } catch (_) {}

  try {
    const tripById = await selectSingle('taxi_requests', 'id', query);
    if (tripById) {
      const trip = formatTaxiRow(tripById);
      trips.push({
        ...trip,
        href: `/admin/taxi?id=${encodeURIComponent(trip.id)}`,
      });
    }
  } catch (_) {}

  if (!looksPhone) {
    try {
      const recent = await selectMany(
        'customer_orders',
        [{ method: 'gte', column: 'created_at', value: sinceDaysIso(7) }],
        { column: 'created_at', ascending: false },
        80
      );
      const needle = query.toLowerCase();
      for (const row of recent) {
        const meta = readOrderMeta(row);
        const mapped = enrichAdminOrder(mapOrderRow(row), meta);
        if (
          String(mapped.orderNumber || '').toLowerCase().includes(needle) ||
          String(mapped.id || '').toLowerCase().includes(needle)
        ) {
          orders.push({
            ...mapped,
            href: `/admin/orders?id=${encodeURIComponent(mapped.id)}`,
          });
        }
      }
    } catch (_) {}
  }

  const dedupe = (list, keyFn) => {
    const seen = new Set();
    return list.filter((item) => {
      const k = keyFn(item);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    query,
    accounts: dedupe(accounts, (a) => a.phone).slice(0, 10),
    orders: dedupe(orders, (o) => o.id).slice(0, 15),
    trips: dedupe(trips, (t) => t.id).slice(0, 15),
  };
}

function mapTicketRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    userPhone: String(row.user_phone || '').trim(),
    subject: String(row.subject || '').trim(),
    status: String(row.status || 'open').trim(),
    priority: String(row.priority || 'normal').trim(),
    category: String(row.category || 'general').trim(),
    relatedOrderId: row.related_order_id || null,
    relatedTaxiRequestId: row.related_taxi_request_id || null,
    assigneePhone: row.assignee_phone || null,
    notes: String(row.notes || '').trim(),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function listSupportTickets(adminPhone, query = {}) {
  await assertAdminAccess(adminPhone);
  const status = String(query.status || '').trim();
  const filters = [];
  if (status) filters.push({ method: 'eq', column: 'status', value: status });
  const rows = await selectMany(
    'support_tickets',
    filters,
    { column: 'updated_at', ascending: false },
    Math.min(Math.max(Number(query.limit) || 50, 1), 100)
  );
  return rows.map(mapTicketRow);
}

async function getSupportContextForAdmin(adminPhone, userPhone) {
  await assertAdminAccess(adminPhone);
  const phoneKey = await resolvePhoneKey(String(userPhone || '').trim());
  if (!phoneKey) throw new Error('رقم الزبون مطلوب.');

  const variants = getPhoneVariants(phoneKey);
  const { getUserState, getAppUser } = require('./users');

  let name = '';
  let role = '';
  let storeName = null;

  try {
    const appUser = await getAppUser(phoneKey);
    if (appUser) {
      name = String(appUser.full_name || '').trim();
      role = String(appUser.role || '').trim();
    }
  } catch (_) {}

  try {
    const state = await getUserState(phoneKey);
    if (state) {
      name = name || String(state.customerName || state.name || '').trim();
      role = role || String(state.userRole || state.role || '').trim();
      const merchantStore = state.merchantStore || state.merchant_store || {};
      storeName =
        String(merchantStore.storeName || merchantStore.store_name || '').trim() || storeName;
    }
  } catch (_) {}

  try {
    const merchant = await selectSingleByPhone('merchant_profiles', phoneKey);
    if (merchant?.store_name) {
      storeName = String(merchant.store_name).trim();
      if (!name) name = storeName;
    }
  } catch (_) {}

  const orderRows = await selectMany(
    'customer_orders',
    [{ method: 'in', column: 'phone', value: variants }],
    { column: 'created_at', ascending: false },
    5
  );
  const orders = orderRows.map((row) => {
    const meta = readOrderMeta(row);
    const mapped = enrichAdminOrder(mapOrderRow(row), meta);
    return {
      id: mapped.id,
      orderNumber: mapped.orderNumber,
      statusAr: mapped.statusAr,
      total: mapped.total,
      createdAt: mapped.createdAt,
      href: `/admin/orders?id=${encodeURIComponent(mapped.id)}`,
    };
  });

  const tripRows = await selectMany(
    'taxi_requests',
    [{ method: 'in', column: 'phone', value: variants }],
    { column: 'created_at', ascending: false },
    5
  );
  const trips = tripRows.map((row) => {
    const trip = formatTaxiRow(row);
    return {
      id: trip.id,
      statusAr: trip.statusAr,
      fare: trip.fare,
      createdAt: trip.createdAt,
      href: `/admin/taxi?id=${encodeURIComponent(trip.id)}`,
    };
  });

  const ticketRows = await selectMany(
    'support_tickets',
    [{ method: 'in', column: 'user_phone', value: variants }],
    { column: 'updated_at', ascending: false },
    8
  );
  const tickets = ticketRows.map(mapTicketRow).filter(Boolean);

  let messageCount = 0;
  let firstMessageAt = null;
  let lastMessageAt = null;
  try {
    const supabase = assertSupabaseAdmin();
    const { count } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_type', 'support')
      .in('thread_id', variants);
    messageCount = count || 0;

    const { data: edgeRows } = await supabase
      .from('chat_messages')
      .select('created_at')
      .eq('thread_type', 'support')
      .in('thread_id', variants)
      .order('created_at', { ascending: true })
      .limit(1);
    firstMessageAt = edgeRows?.[0]?.created_at || null;

    const { data: latestRows } = await supabase
      .from('chat_messages')
      .select('created_at')
      .eq('thread_type', 'support')
      .in('thread_id', variants)
      .order('created_at', { ascending: false })
      .limit(1);
    lastMessageAt = latestRows?.[0]?.created_at || null;
  } catch (_) {}

  const roleLabels = {
    customer: 'زبون',
    merchant: 'تاجر',
    driver: 'سائق',
    courier: 'مندوب',
    professional: 'مهني',
    admin: 'أدمن',
  };

  return {
    phone: phoneKey,
    name: name || null,
    role: role || 'customer',
    roleLabel: roleLabels[String(role || 'customer').trim()] || role || 'زبون',
    storeName,
    orders,
    trips,
    tickets,
    conversation: {
      messageCount,
      firstMessageAt,
      lastMessageAt,
    },
    links: {
      account: `/admin/accounts?q=${encodeURIComponent(phoneKey)}`,
      tickets: `/admin/tickets`,
    },
    refreshedAt: nowIso(),
  };
}

async function notifySupportTicketStatus(userPhone, ticketId, subject, status) {
  const phone = String(userPhone || '').trim();
  const id = String(ticketId || '').trim();
  if (!phone || !id) return;
  try {
    const { sendPushToPhone } = require('../push_events');
    const statusLabel =
      String(status || '').trim() === 'resolved' ? 'تمت معالجتها' : 'تم تحديثها';
    await sendPushToPhone(
      phone,
      {
        title: 'تحديث على تذكرتك',
        body: `تذكرتك «${String(subject || 'تذكرة دعم').trim()}» ${statusLabel} — تحقق من التطبيق`,
        data: {
          orderId: '',
          eventKey: `support:${id}:status`,
          category: 'account',
        },
      },
      { showSystemBanner: true, immediate: true }
    );
  } catch (pushError) {
    console.error('support ticket push error:', pushError?.message || pushError);
  }
}

async function createSupportTicket(adminPhone, body = {}) {
  await assertAdminAccess(adminPhone);
  const userPhone = await resolvePhoneKey(String(body.userPhone || '').trim());
  if (!userPhone) throw new Error('رقم الزبون مطلوب.');
  const id = uuidv4();
  const now = nowIso();
  const row = {
    id,
    user_phone: userPhone,
    subject: String(body.subject || 'تذكرة دعم').trim() || 'تذكرة دعم',
    status: String(body.status || 'open').trim() || 'open',
    priority: String(body.priority || 'normal').trim() || 'normal',
    category: String(body.category || 'general').trim() || 'general',
    related_order_id: String(body.relatedOrderId || '').trim() || null,
    related_taxi_request_id: String(body.relatedTaxiRequestId || '').trim() || null,
    assignee_phone: String(body.assigneePhone || adminPhone).trim() || adminPhone,
    notes: String(body.notes || '').trim(),
    created_at: now,
    updated_at: now,
  };
  const saved = await saveRow('support_tickets', row, 'id');
  await notifySupportTicketStatus(userPhone, id, row.subject, row.status);
  try {
    const { socketBroadcast, adminOpsRoom } = require('../lib/socket_broadcast');
    void socketBroadcast({
      room: adminOpsRoom(),
      event: 'live:ops',
      payload: { type: 'support_ticket', id },
    });
  } catch (e) {
    console.warn('support ticket live broadcast error:', e?.message || e);
  }
  return mapTicketRow(saved);
}

async function updateSupportTicket(adminPhone, ticketId, body = {}) {
  await assertAdminAccess(adminPhone);
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('Ticket id is required.');
  const existing = await selectSingle('support_tickets', 'id', id);
  if (!existing) throw new Error('Ticket not found.');
  const patch = {
    ...existing,
    id,
    updated_at: nowIso(),
  };
  if (body.status !== undefined) patch.status = String(body.status || '').trim() || existing.status;
  if (body.priority !== undefined) patch.priority = String(body.priority || '').trim();
  if (body.category !== undefined) patch.category = String(body.category || '').trim();
  if (body.subject !== undefined) patch.subject = String(body.subject || '').trim();
  if (body.notes !== undefined) patch.notes = String(body.notes || '').trim();
  if (body.assigneePhone !== undefined) {
    patch.assignee_phone = String(body.assigneePhone || '').trim() || null;
  }
  if (body.relatedOrderId !== undefined) {
    patch.related_order_id = String(body.relatedOrderId || '').trim() || null;
  }
  if (body.relatedTaxiRequestId !== undefined) {
    patch.related_taxi_request_id = String(body.relatedTaxiRequestId || '').trim() || null;
  }
  const saved = await saveRow('support_tickets', patch, 'id');
  const targetUser = String(body.userPhone || existing.user_phone || '').trim();
  await notifySupportTicketStatus(targetUser, id, saved.subject || existing.subject, saved.status || existing.status);
  return mapTicketRow(saved);
}

async function listMerchantReviewsForAdmin(
  adminPhone,
  { q = '', page = 1, limit = 25, merchantPhone = '' } = {}
) {
  await assertAdminAccess(adminPhone);
  const query = String(q || '').trim();
  const merchantFilter = String(merchantPhone || '').trim();
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  const supabase = assertSupabaseAdmin();
  let supabaseQuery = supabase
    .from('merchant_reviews')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (merchantFilter) {
    supabaseQuery = supabaseQuery.eq('merchant_phone', merchantFilter);
  }
  if (query) {
    supabaseQuery = supabaseQuery.or(
      `comment.ilike.%${query}%,merchant_phone.ilike.%${query}%,customer_phone.ilike.%${query}%,order_id.ilike.%${query}%`
    );
  }
  const { data, count, error } = await supabaseQuery.range(offset, offset + limitNum - 1);
  if (error) throw new Error(error.message);

  const merchantPhones = [
    ...new Set((data || []).map((r) => String(r.merchant_phone || '').trim()).filter(Boolean)),
  ];
  const customerPhones = [
    ...new Set((data || []).map((r) => String(r.customer_phone || '').trim()).filter(Boolean)),
  ];
  const merchantsByName = new Map();
  const customersByName = new Map();
  if (merchantPhones.length) {
    const rows = await supabase
      .from('merchant_profiles')
      .select('phone, store_name')
      .in('phone', merchantPhones);
    for (const row of rows.data || []) {
      merchantsByName.set(String(row.phone || '').trim(), row.store_name || '');
    }
  }
  if (customerPhones.length) {
    const rows = await supabase
      .from('app_users')
      .select('phone, full_name')
      .in('phone', customerPhones);
    for (const row of rows.data || []) {
      customersByName.set(String(row.phone || '').trim(), row.full_name || '');
    }
  }

  const items = (data || []).map((row) => ({
    id: String(row.id || '').trim(),
    merchantPhone: String(row.merchant_phone || '').trim(),
    merchantStoreName: String(merchantsByName.get(String(row.merchant_phone || '').trim()) || '').trim(),
    customerPhone: String(row.customer_phone || '').trim(),
    customerName: String(customersByName.get(String(row.customer_phone || '').trim()) || '').trim(),
    orderId: String(row.order_id || '').trim(),
    stars: Number(row.stars || 0),
    comment: String(row.comment || '').trim(),
    reply: String(row.reply || '').trim(),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));

  return { items, page: pageNum, limit: limitNum, total: Number(count || 0), q: query };
}

async function deleteMerchantReviewForAdmin(adminPhone, reviewId) {
  await assertAdminAccess(adminPhone);
  const id = String(reviewId || '').trim();
  if (!id) throw new Error('Review id is required.');
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('merchant_reviews')
    .delete()
    .or(`id.eq.${id},order_id.eq.${id}`)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Review not found.');
  return { success: true, id: String(data.id || id).trim() };
}

module.exports = {
  getAdminOrders,
  getAdminOrderById,
  adminUpdateOrderStatus,
  adminConfirmOrderReturn,
  adminReassignCourier,
  adminCancelOrder,
  adminDisputeOrder,
  getAdminTaxiTripById,
  adminCancelTaxiTrip,
  adminCompleteTaxiTrip,
  adminCreateTaxiTrip,
  adminAssignTaxiCaptain,
  adminRematchTaxiTrip,
  adminResolveTaxiComplaint,
  getAdminTaxiTripsFiltered,
    enrichTaxiTripsWithCustomerNames,
  getAdminTaxiRatings,
  getAdminTaxiCaptainLeaderboard,
  getAdminLiveOverview,
  adminUnifiedSearch,
  listSupportTickets,
  getSupportContextForAdmin,
  createSupportTicket,
  updateSupportTicket,
  listMerchantReviewsForAdmin,
  deleteMerchantReviewForAdmin,
};
