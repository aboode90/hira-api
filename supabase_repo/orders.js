const { randomUUID } = require('crypto');
const {
  assertSupabaseAdmin,
  nowIso,
  normalizeObject,
  getPhoneVariants,
  phonesOverlap,
  selectSingleByPhone,
  resolvePhoneKey,
  selectSingle,
  selectMany,
  hasColumn,
  saveRow,
  updateRow,
} = require('./common');
const {
  ensureAppUser,
  getAppUser,
  getUserState,
  saveUserState,
} = require('./users');
const {
  getMerchantProfile,
  isMerchantFrozen,
  isMerchantApproved,
} = require('./merchants');
const {
  buildMerchantReviewUpsertPayload,
  getMerchantReviewOwnerFilter,
} = require('./merchant_offers');
const { readDeliveryFeeIqd } = require('../lib/delivery_eligibility');
const {
  getDriverProfile,
  getCourierProfile,
  saveCourierProfile,
  readCourierLiveLocations,
  getActiveCourierPhones,
  getActiveDriverPhones,
} = require('./operator_profiles');
const {
  matchingWaveIndex,
  matchingRadiusKm,
} = require('../lib/expanding_search_radius');
const { haversineDistance } = require('../services/taxi_trip_service');
const {
  isDriverDeliveryEligible,
  canActorTakeDeliveryOrder,
  resolveEffectiveCourierMode,
  normalizeCourierMode,
} = require('../lib/delivery_eligibility');
const {
  listApprovedCourierPhones,
  resolveMerchantCourierMode,
} = require('./merchant_couriers');
const {
  applyCustomerCancelReturnPolicy,
} = require('../lib/order_return_policy');
const {
  END_REASONS,
  recordDeliveryAcceptance,
  recordDeliveryAssignmentEnd,
} = require('../lib/delivery_assignment_history');
const {
  isPosEnabledProfile,
  buildPosTickets,
  allPosTicketsReady,
} = require('../lib/pos_departments');

async function resolveDeliveryActor(phone) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const appUser = await getAppUser(normalizedPhone);
  const role = String(appUser?.role ?? '').trim();

  if (role === 'delivery') {
    const profile = await getCourierProfile(normalizedPhone);
    const approved =
      profile?.isApproved === true ||
      profile?.is_approved === true ||
      String(profile?.approvalStatus ?? profile?.approval_status ?? '') === 'approved';
    const active =
      approved &&
      profile?.available !== false &&
      profile?.isSuspended !== true &&
      profile?.is_suspended !== true;
    return {
      phone: normalizedPhone,
      role,
      active,
      name: String(profile?.name ?? profile?.displayName ?? '').trim(),
    };
  }

  if (role === 'driver') {
    const profile = await getDriverProfile(normalizedPhone);
    const approved =
      profile?.isApproved === true ||
      profile?.is_approved === true ||
      String(profile?.approvalStatus ?? profile?.approval_status ?? '') === 'approved';
    const active =
      approved &&
      profile?.available !== false &&
      profile?.isSuspended !== true &&
      profile?.is_suspended !== true;
    return {
      phone: normalizedPhone,
      role,
      active,
      name: String(profile?.name ?? profile?.displayName ?? '').trim(),
    };
  }

  return { phone: normalizedPhone, role, active: false, name: '' };
}

/**
 * يحوّل أي رقم (حساب أو تواصل) إلى حساب مندوب/كابتن مسجّل.
 * التعيين من الإدارة يجب أن يستخدم رقم الحساب حتى يظهر الطلب في تطبيق المندوب.
 */
async function resolveRegisteredDeliveryAssignee(rawPhone) {
  const trimmed = String(rawPhone || '').trim();
  if (!trimmed) {
    throw new Error('اختر مندوباً من القائمة.');
  }

  const actor = await resolveDeliveryActor(trimmed);
  if (actor.role === 'delivery' || actor.role === 'driver') {
    return {
      ...actor,
      name:
        actor.name ||
        (actor.role === 'driver' ? 'كابتن طلب' : 'مندوب طلب'),
    };
  }

  const rows = await selectMany(
    'courier_profiles',
    [],
    { column: 'updated_at', ascending: false },
    2500
  );
  for (const row of rows || []) {
    const accountPhone = String(row.phone || '').trim();
    if (!accountPhone) continue;
    const payload = normalizeObject(row.profile_payload);
    const profilePhone = String(payload.phone || '').trim();
    if (
      phonesOverlap(trimmed, accountPhone) ||
      (profilePhone && phonesOverlap(trimmed, profilePhone))
    ) {
      const profile = await getCourierProfile(accountPhone);
      const resolved = await resolvePhoneKey(accountPhone);
      return {
        phone: resolved,
        role: 'delivery',
        active: true,
        name:
          String(profile?.name || payload.name || '').trim() || 'مندوب طلب',
      };
    }
  }

  throw new Error(
    'لا يوجد مندوب توصيل مسجّل بهذا الرقم. اختر من قائمة المندوبين في لوحة الإدارة.',
  );
}

function resolveOrderCourierMode(metaOrPayload) {
  return resolveEffectiveCourierMode(metaOrPayload);
}

async function stampOrderCourierMode(order, merchantPhone) {
  if (!order || typeof order !== 'object') return order;
  const existing = normalizeCourierMode(
    order.courierModeEffective ?? order.courierMode,
  );
  if (order.courierMode || order.courierModeEffective) {
    order.courierMode = existing || 'public';
    order.courierModeEffective = normalizeCourierMode(
      order.courierModeEffective ?? order.courierMode,
    );
    return order;
  }
  const mode = merchantPhone
    ? await resolveMerchantCourierMode(merchantPhone)
    : 'public';
  order.courierMode = mode;
  order.courierModeEffective = mode;
  return order;
}

async function listAllCustomerOrders() {
  return selectMany(
    'customer_orders',
    [],
    { column: 'updated_at', ascending: false },
    200
  );
}

async function listPendingOrders() {
  return selectMany(
    'customer_orders',
    [{ method: 'eq', column: 'status_key', value: 'pending' }],
    { column: 'updated_at', ascending: false }
  );
}

async function listOrdersWithDeliveryStatus(deliveryStatusKey) {
  return selectMany(
    'customer_orders',
    [
      { method: 'eq', column: 'status_key', value: 'delivering' },
      { method: 'eq', column: 'delivery_status_key', value: deliveryStatusKey },
    ],
    { column: 'updated_at', ascending: false }
  );
}

async function getCustomerOrders(phone) {
  const variants = getPhoneVariants(phone);
  if (variants.length === 0) return [];

  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = await selectMany(
    'customer_orders',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'gte', column: 'created_at', value: sinceIso },
    ],
    { column: 'created_at', ascending: false },
    50
  );

  // الطلبات النشطة الأقدم من 7 أيام تبقى ظاهرة في «النشاط الحالي».
  const activeStatuses = [
    'pending',
    'accepted',
    'preparing',
    'delivering',
    'adjustment_pending',
    'cancel_requested',
    'confirmed',
    'ready',
    'waiting',
  ];
  const activeOlder = await selectMany(
    'customer_orders',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'in', column: 'status_key', value: activeStatuses },
      { method: 'lt', column: 'created_at', value: sinceIso },
    ],
    { column: 'created_at', ascending: false },
    30
  );

  const byId = new Map();
  for (const row of [...recent, ...activeOlder]) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;
    byId.set(id, row);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const ta = Date.parse(a.created_at || 0) || 0;
    const tb = Date.parse(b.created_at || 0) || 0;
    return tb - ta;
  });
}

async function saveCustomerOrder(phone, data = {}, options = {}) {
  const customerPhone = await resolvePhoneKey(phone);
  await ensureAppUser(customerPhone, data);
  const order = normalizeObject(data.order ?? data.order_payload);
  const orderId = String(order.id ?? data.id ?? '').trim();
  if (!orderId) {
    throw new Error('Order id is required.');
  }

  const existingRow = await selectSingle('customer_orders', 'id', orderId);
  const previousMeta = existingRow ? readOrderMeta(existingRow) : null;
  const rewritten = applyCustomerCancelReturnPolicy({
    order,
    previousMeta,
    data,
    nowIso,
  });
  Object.keys(order).forEach((key) => {
    delete order[key];
  });
  Object.assign(order, rewritten.order);
  if (rewritten.data) {
    if (Object.prototype.hasOwnProperty.call(rewritten.data, 'courier_phone')) {
      data.courier_phone = rewritten.data.courier_phone;
    }
    if (Object.prototype.hasOwnProperty.call(rewritten.data, 'courierPhone')) {
      data.courierPhone = rewritten.data.courierPhone;
    }
  }

  if (existingRow && !phonesOverlap(existingRow.phone, customerPhone)) {
    if (options.allowAdmin) {
      const { assertAdminAccess } = require('./users');
      await assertAdminAccess(customerPhone);
    } else {
      throw new Error('Unauthorized order update.');
    }
  }

  const rawMerchantPhone =
    String(
      data.merchant_phone ??
        data.merchantPhone ??
        order.merchantPhone ??
        ''
    ).trim();
  const merchantPhone = rawMerchantPhone
    ? await resolvePhoneKey(rawMerchantPhone)
    : null;

  if (merchantPhone) {
    const merchantProfile = await getMerchantProfile(merchantPhone);
    if (!merchantProfile) {
      throw new Error('Merchant not found.');
    }
    if (isMerchantFrozen(merchantProfile)) {
      throw new Error('MERCHANT_FROZEN');
    }
    if (!isMerchantApproved(merchantProfile)) {
      throw new Error('MERCHANT_NOT_APPROVED');
    }
    if (!existingRow) {
      const {
        merchantAcceptsCustomerOrders,
      } = require('../services/merchant_working_hours');
      const orderCheck = merchantAcceptsCustomerOrders(merchantProfile);
      if (!orderCheck.allowed) {
        throw new Error(orderCheck.messageAr || 'MERCHANT_CLOSED');
      }
      if (isPosEnabledProfile(merchantProfile)) {
        order.posEnabled = true;
        if (!order.posTickets || typeof order.posTickets !== 'object') {
          order.posTickets = buildPosTickets(order);
        }
      }
      const { chargeMerchantOrderFee } = require('./provider_wallet');
      await chargeMerchantOrderFee(merchantPhone, orderId);

      try {
        const { applyNewOrderCoupon } = require('../services/loyalty/loyalty_hooks');
        await applyNewOrderCoupon({
          customerPhone,
          merchantPhone,
          orderId,
          order,
        });
      } catch (couponError) {
        throw couponError;
      }
    }
  }

  const rawCourierPhone =
    String(
      data.courier_phone ??
        data.courierPhone ??
        order.courierPhone ??
        order.assignedCourierPhone ??
        ''
    ).trim();
  const courierPhone = rawCourierPhone
    ? await resolvePhoneKey(rawCourierPhone)
    : null;

  order.customerPhone = customerPhone;
  order.merchantPhone = merchantPhone;
  order.courierPhone = courierPhone;

  if (
    String(order.deliveryStatusKey || data.delivery_status_key || '')
      .trim()
      .toLowerCase() === 'waiting' &&
    !courierPhone
  ) {
    await stampOrderCourierMode(order, merchantPhone);
  }

  const payload = {
    id: orderId,
    phone: customerPhone,
    order_number: String(order.orderNumber ?? data.order_number ?? '').trim() || null,
    status_key: String(order.statusKey ?? data.status_key ?? '').trim() || null,
    delivery_status_key:
      String(order.deliveryStatusKey ?? data.delivery_status_key ?? '').trim() || null,
    order_payload: order,
    updated_at: nowIso(),
  };

  if (await hasColumn('customer_orders', 'merchant_phone')) {
    payload.merchant_phone = merchantPhone;
  }
  if (await hasColumn('customer_orders', 'courier_phone')) {
    payload.courier_phone = courierPhone;
  }

  const savedRow = await saveRow('customer_orders', payload, 'id');
  const nextMeta = readOrderMeta(savedRow);

  if (!options.skipPush) {
    try {
      const { onOrderSaved } = require('../push_events');
      await onOrderSaved({
        previousMeta,
        nextMeta,
        isNew: !existingRow,
      });
    } catch (error) {
      console.error('push onOrderSaved error:', error?.message || error);
    }
  }

  try {
    const { onMarketplaceOrderSaved } = require('../services/loyalty/loyalty_hooks');
    await onMarketplaceOrderSaved({
      previousMeta,
      nextMeta,
      customerPhone,
    });
  } catch (error) {
    console.error('loyalty onOrderSaved error:', error?.message || error);
  }

  // بث فوري عبر الـ Socket: طلب جديد للتاجر + تحديث الحالة للطرفين.
  try {
    const {
      socketBroadcast,
      merchantRoom,
      customerRoom,
      adminOpsRoom,
      couriersRoom,
      courierRoom,
    } = require('../lib/socket_broadcast');
    const orderOut = mapOrderRow(savedRow);
    void socketBroadcast({
      room: merchantRoom(merchantPhone),
      event: existingRow ? 'order:status' : 'order:new',
      payload: orderOut,
    });
    void socketBroadcast({
      room: customerRoom(customerPhone),
      event: 'order:status',
      payload: orderOut,
    });
    // المندوب المعيّن: تحديث فوري لطلبه المعيّن (إلغاء/تعديل من التاجر...).
    const courierKey = String(nextMeta.courierPhone || '').trim();
    if (courierKey) {
      void socketBroadcast({
        room: courierRoom(courierKey),
        event: 'order:status',
        payload: orderOut,
      });
    }
    const previousCourierKey = String(previousMeta?.courierPhone || '').trim();
    if (previousCourierKey && previousCourierKey !== courierKey) {
      void socketBroadcast({
        room: courierRoom(previousCourierKey),
        event: 'order:status',
        payload: orderOut,
      });
    }
    // مجمّع المندوبين: طلب جديد في المجمع أو تغيّر/حجز.
    if (String(nextMeta.statusKey || '').trim() === 'delivering') {
      const isPoolOrder =
        String(nextMeta.deliveryStatusKey || '').trim() === 'waiting' &&
        !courierKey;
      if (isPoolOrder) {
        const mode = resolveOrderCourierMode(nextMeta);
        if (mode === 'private') {
          let fleet = [];
          try {
            fleet = await listApprovedCourierPhones(
              String(nextMeta.merchantPhone || merchantPhone || '').trim(),
            );
          } catch (_) {
            fleet = [];
          }
          for (const phone of fleet) {
            void socketBroadcast({
              room: courierRoom(phone),
              event: 'delivery:pool_new',
              payload: orderOut,
            });
          }
        } else {
          void socketBroadcast({
            room: couriersRoom(),
            event: 'delivery:pool_new',
            payload: orderOut,
          });
        }
      } else {
        void socketBroadcast({
          room: couriersRoom(),
          event: 'delivery:pool_update',
          payload: orderOut,
        });
      }
    }
    if (!existingRow) {
      void socketBroadcast({
        room: adminOpsRoom(),
        event: 'live:ops',
        payload: { type: 'order', orderId, orderNumber: orderOut.orderNumber },
      });
    }
  } catch (error) {
    console.warn('order socket broadcast error:', error?.message || error);
  }

  // العدّاد الفعلي لقسم «الأكثر طلباً»: أبطِل كاش العدّادات عند إنشاء
  // طلب جديد أو تغيّر حالة الطلب (قبول/إتمام/إلغاء) حتى يُعاد الحساب قريباً.
  try {
    const nextStatus = String(
      savedRow?.status_key ?? savedRow?.status ?? orderOut?.statusKey ?? orderOut?.status ?? '',
    ).trim().toLowerCase();
    const countedStates = new Set(['', 'pending', 'accepted', 'completed', 'delivered', 'on_way', 'arrived', 'picked_up', 'in_progress', 'cancel_requested']);
    const isNew = !existingRow;
    if (isNew || nextStatus !== String(previousMeta?.statusKey || previousMeta?.status || '').trim().toLowerCase() && countedStates.has(nextStatus)) {
      const { invalidateProductOrderCountsCache } = require('./merchants');
      invalidateProductOrderCountsCache();
    }
  } catch (_) {
    // ignore
  }

  return savedRow;
}

/**
 * تحويل صف الطلب الخام من قاعدة البيانات إلى كائن camelCase مُسطّح
 * لاستخدامه في نقاط API المخصصة للمستخدم (مثل /customer-orders بحيث
 * تكون الحقول camelCase على المستوى الأعلى بدلاً من داخل order_payload).
 */
function mapOrderRow(row) {
  const meta = readOrderMeta(row);
  const p = meta.payload || {};
  return {
    id: meta.id,
    phone: meta.customerPhone,
    orderNumber: p.orderNumber ?? row.order_number ?? '',
    dateAr: p.dateAr ?? '',
    dateEn: p.dateEn ?? '',
    customerNameAr: p.customerNameAr ?? '',
    customerNameEn: p.customerNameEn ?? '',
    customerPhone: meta.customerPhone,
    addressAr: p.addressAr ?? p.address ?? '',
    addressEn: p.addressEn ?? '',
    noteAr: p.noteAr ?? '',
    noteEn: p.noteEn ?? '',
    paymentMethodAr: p.paymentMethodAr ?? 'نقداً',
    paymentMethodEn: p.paymentMethodEn ?? 'Cash',
    statusKey: meta.statusKey || 'pending',
    statusAr: p.statusAr ?? '',
    statusEn: p.statusEn ?? '',
    price: Number(p.price ?? 0),
    itemsCount: p.itemsCount ?? (Array.isArray(p.items) ? p.items.length : 0),
    itemsNameAr: p.itemsNameAr ?? '',
    itemsNameEn: p.itemsNameEn ?? '',
    lineItems: Array.isArray(p.items) ? p.items : [],
    image: p.image ?? null,
    iconName: p.iconName ?? null,
    deliveryStatusKey: meta.deliveryStatusKey || '',
    deliveryStatusAr: p.deliveryStatusAr ?? '',
    deliveryStatusEn: p.deliveryStatusEn ?? '',
    assignedCourierName: p.assignedCourierName ?? '',
    deliveryAssigneeRole: p.deliveryAssigneeRole ?? '',
    courierAcceptedAt: p.courierAcceptedAt ?? null,
    isRestaurantOrder: p.isRestaurantOrder === true,
    paymentMethod: p.paymentMethod ?? null,
    merchantPhone: meta.merchantPhone || '',
    merchantStoreName: p.merchantStoreName ?? '',
    merchantLatitude: p.merchantLatitude ?? null,
    merchantLongitude: p.merchantLongitude ?? null,
    requiresDelivery: p.requiresDelivery !== false,
    codConfirmed: p.codConfirmed === true,
    deliveredAt: p.deliveredAt ?? null,
    estimatedArrivalMinutes: p.estimatedArrivalMinutes ?? null,
    estimatedArrivalAt: p.estimatedArrivalAt ?? null,
    courierPhone: meta.courierPhone || '',
    courierMode: p.courierMode ?? p.courier_mode ?? 'public',
    courierModeEffective:
      p.courierModeEffective ?? p.courier_mode_effective ?? p.courierMode ?? 'public',
    customerLatitude: p.customerLatitude ?? p.latitude ?? null,
    customerLongitude: p.customerLongitude ?? p.longitude ?? null,
    createdAt: row.created_at ?? p.createdAt ?? null,
    merchantReadAt: p.merchantReadAt ?? null,
    merchantDecisionAt: p.merchantDecisionAt ?? null,
    groupId: p.groupId ?? null,
    isPriceLocked: p.isPriceLocked === true,
    isRated: p.isRated === true,
    originalPrice: Number(p.originalPrice ?? 0),
    itemsSubtotalIqd: Number(p.itemsSubtotalIqd ?? p.price ?? 0),
    deliveryFeeIqd: readDeliveryFeeIqd(p),
    promoDiscountIqd: Number(p.promoDiscountIqd ?? 0),
  };
}

function readOrderMeta(row) {
  const payload = normalizeObject(row.order_payload);
  return {
    row,
    payload,
    id: String(row.id ?? payload.id ?? '').trim(),
    customerPhone: String(row.phone ?? payload.customerPhone ?? '').trim(),
    merchantPhone: String(row.merchant_phone ?? payload.merchantPhone ?? '').trim(),
    courierPhone: String(
      row.courier_phone ?? payload.courierPhone ?? payload.assignedCourierPhone ?? ''
    ).trim(),
    statusKey: String(row.status_key ?? payload.statusKey ?? '').trim(),
    deliveryStatusKey: String(
      row.delivery_status_key ?? payload.deliveryStatusKey ?? ''
    ).trim(),
  };
}

function isDeliveryPoolOrder(meta) {
  return (
    meta.statusKey === 'delivering' &&
    meta.deliveryStatusKey === 'waiting' &&
    !meta.courierPhone
  );
}

function deliveryPickupCoords(payload = {}) {
  const lat = Number(
    payload.merchantLatitude ??
      payload.merchant_latitude ??
      payload.pickupLat ??
      payload.pickup_lat ??
      0,
  );
  const lng = Number(
    payload.merchantLongitude ??
      payload.merchant_longitude ??
      payload.pickupLng ??
      payload.pickup_lng ??
      0,
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) < 0.0001 || Math.abs(lng) < 0.0001) return null;
  return { lat, lng };
}

function deliveryMatchingStartedAt(meta) {
  return (
    meta?.payload?.matchingSearchStartedAt ||
    meta?.payload?.deliveryWaitingAt ||
    meta?.row?.updated_at ||
    meta?.row?.created_at ||
    null
  );
}

function phoneLocKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function getDeliveryPoolOrders(courierPhone = '') {
  const actor = await resolveDeliveryActor(courierPhone);
  if (!actor.active) return [];

  const rows = await selectMany(
    'customer_orders',
    [],
    { column: 'updated_at', ascending: false }
  );
  let courierVariants = [];
  let courierLoc = null;
  if (courierPhone) {
    const normalized = await resolvePhoneKey(courierPhone);
    courierVariants = getPhoneVariants(normalized);
    try {
      const locs = await readCourierLiveLocations([normalized, courierPhone]);
      courierLoc =
        locs.get(phoneLocKey(normalized)) ||
        locs.get(phoneLocKey(courierPhone)) ||
        null;
    } catch (_) {}
  }
  const filtered = [];
  for (const row of rows || []) {
    const meta = readOrderMeta(row);
    if (!isDeliveryPoolOrder(meta)) continue;
    if (!(await canActorTakeDeliveryOrder(actor, meta))) continue;
    if (courierVariants.length) {
      const rejected = Array.isArray(meta.payload.rejectedByCouriers)
        ? meta.payload.rejectedByCouriers.map((item) => String(item).trim())
        : [];
      if (courierVariants.some((variant) => rejected.includes(variant))) {
        continue;
      }
    }
    const pickup = deliveryPickupCoords(meta.payload);
    if (pickup && courierPhone) {
      if (!courierLoc) continue;
      const startedAt = deliveryMatchingStartedAt(meta) || row.updated_at;
      const radiusKm = matchingRadiusKm(startedAt);
      const distance = haversineDistance(
        courierLoc.lat,
        courierLoc.lng,
        pickup.lat,
        pickup.lng,
      );
      if (distance > radiusKm + 0.05) continue;
    }
    filtered.push(row);
  }
  return filtered;
}

/**
 * إشعار مندوبي/كابتن التوصيل ضمن نطاق البحث المتوسّع.
 * @returns {Promise<boolean>} true إذا أُرسلت موجة جديدة
 */
async function notifyDeliveryPoolExpandingWave(meta, { force = false } = {}) {
  if (!meta || !isDeliveryPoolOrder(meta)) return false;

  let startedAt = deliveryMatchingStartedAt(meta);
  if (!startedAt) {
    startedAt = nowIso();
    try {
      await updateRow('customer_orders', 'id', meta.id, {
        order_payload: {
          ...meta.payload,
          matchingSearchStartedAt: startedAt,
          updatedAt: startedAt,
        },
        updated_at: startedAt,
      });
    } catch (error) {
      console.error('delivery matching start persist error:', error?.message || error);
    }
  }

  const wave = matchingWaveIndex(startedAt);
  if (!force && Number(meta.payload?.matchingWaveIndex) === wave) {
    return false;
  }

  const radiusKm = matchingRadiusKm(startedAt);
  const pickup = deliveryPickupCoords(meta.payload);
  const rejected = Array.isArray(meta.payload?.rejectedByCouriers)
    ? meta.payload.rejectedByCouriers.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const rejectedKeys = new Set(
    rejected.flatMap((phone) => getPhoneVariants(phone).map(phoneLocKey)).filter(Boolean),
  );

  let courierPhones = [];
  let driverPhones = [];
  const mode = resolveOrderCourierMode(meta);
  const merchantPhone = String(
    meta.merchantPhone || meta.payload?.merchantPhone || '',
  ).trim();

  if (mode === 'private') {
    try {
      courierPhones = await listApprovedCourierPhones(merchantPhone);
    } catch (_) {
      courierPhones = [];
    }
    // Private fleet only — no platform taxi drivers unless they are linked
    // (linked phones are already in courierPhones by phone).
    driverPhones = [];
  } else {
    try {
      courierPhones = await getActiveCourierPhones();
    } catch (_) {}
    try {
      driverPhones = await getActiveDriverPhones();
    } catch (_) {}
  }

  const allPhones = [...new Set([...courierPhones, ...driverPhones])].filter(
    (phone) => !rejectedKeys.has(phoneLocKey(phone)),
  );

  let targetCouriers = courierPhones.filter(
    (phone) => !rejectedKeys.has(phoneLocKey(phone)),
  );
  let targetDrivers = driverPhones.filter(
    (phone) => !rejectedKeys.has(phoneLocKey(phone)),
  );

  if (pickup && allPhones.length) {
    try {
      const locs = await readCourierLiveLocations(allPhones);
      const within = (phone) => {
        const loc = locs.get(phoneLocKey(phone));
        if (!loc) return false;
        const distance = haversineDistance(loc.lat, loc.lng, pickup.lat, pickup.lng);
        return distance <= radiusKm + 0.05;
      };
      targetCouriers = targetCouriers.filter(within);
      targetDrivers = targetDrivers.filter(within);
    } catch (error) {
      console.error('delivery expanding location filter error:', error?.message || error);
    }
  }

  const orderNumber = String(
    meta.payload?.orderNumber || meta.orderNumber || meta.id || '',
  ).trim();
  const storeName = String(
    meta.payload?.merchantStoreName ||
      meta.payload?.merchantName ||
      meta.payload?.storeName ||
      '',
  ).trim();
  const pickupAddress = String(meta.payload?.pickupAddress || '').trim();
  const merchantLabel = storeName ? `من ${storeName}` : 'من المتجر';
  const pickupSuffix = pickupAddress ? ` · ${pickupAddress}` : '';
  const storeSuffix = storeName ? ` (${storeName})` : '';
  const body = `طلب ${orderNumber} متاح للتوصيل — ${merchantLabel}${pickupSuffix}`;

  try {
    const { sendPushToPhone } = require('../push_events');
    await Promise.all([
      ...targetCouriers.map((phone) =>
        sendPushToPhone(
          phone,
          {
            title: `طلب توصيل جديد${storeSuffix}`,
            body,
            data: {
              audience: 'courier',
              orderId: meta.id,
              eventKey: `courier:${meta.id}:pool_new`,
              category: 'delivery',
              matchingRadiusKm: String(radiusKm),
            },
          },
          { showSystemBanner: true, immediate: true },
        ),
      ),
      ...targetDrivers.map((phone) =>
        sendPushToPhone(
          phone,
          {
            title: `توصيل متجر جديد${storeSuffix}`,
            body,
            data: {
              audience: 'driver',
              orderId: meta.id,
              eventKey: `driver:${meta.id}:pool_new`,
              category: 'delivery',
              matchingRadiusKm: String(radiusKm),
            },
          },
          { showSystemBanner: true, immediate: true },
        ),
      ),
    ]);
  } catch (error) {
    console.error('delivery expanding notify error:', error?.message || error);
  }

  try {
    const row = await selectSingle('customer_orders', 'id', meta.id);
    if (row && isDeliveryPoolOrder(readOrderMeta(row))) {
      const payload = normalizeObject(row.order_payload);
      await updateRow('customer_orders', 'id', meta.id, {
        order_payload: {
          ...payload,
          matchingSearchStartedAt: startedAt,
          matchingWaveIndex: wave,
          matchingRadiusKm: radiusKm,
          matchingWaveAt: nowIso(),
          updatedAt: nowIso(),
        },
        updated_at: nowIso(),
      });
    }
  } catch (error) {
    console.error('delivery matching wave persist error:', error?.message || error);
  }

  return true;
}

async function runDeliveryExpandingSearchWaves() {
  const rows = await selectMany(
    'customer_orders',
    [
      { method: 'eq', column: 'status_key', value: 'delivering' },
    ],
    { column: 'updated_at', ascending: true },
    80,
  );
  let count = 0;
  for (const row of rows || []) {
    const meta = readOrderMeta(row);
    if (!isDeliveryPoolOrder(meta)) continue;
    try {
      const sent = await notifyDeliveryPoolExpandingWave(meta);
      if (sent) count += 1;
    } catch (error) {
      console.error(
        'delivery expand wave error:',
        meta.id,
        error?.message || error,
      );
    }
  }
  return count;
}

async function getCourierAssignedOrders(courierPhone) {
  const resolved = await resolvePhoneKey(courierPhone);
  let profilePhone = '';
  try {
    const profile = await getCourierProfile(resolved);
    profilePhone = String(profile?.phone || '').trim();
  } catch (_) {}

  const variants = [
    ...new Set(
      [
        ...getPhoneVariants(courierPhone),
        ...getPhoneVariants(resolved),
        ...getPhoneVariants(profilePhone),
        String(courierPhone || '').trim(),
        resolved,
        profilePhone,
      ].filter(Boolean)
    ),
  ];
  if (variants.length === 0) return [];

  if (await hasColumn('customer_orders', 'courier_phone')) {
    const rows = await selectMany(
      'customer_orders',
      [{ method: 'in', column: 'courier_phone', value: variants }],
      { column: 'updated_at', ascending: false }
    );
    if (rows.length > 0) return rows;
  }

  const rows = await selectMany(
    'customer_orders',
    [],
    { column: 'updated_at', ascending: false },
    250
  );
  return rows.filter((row) => {
    const meta = readOrderMeta(row);
    return (
      phonesOverlap(resolved, meta.courierPhone) ||
      phonesOverlap(courierPhone, meta.courierPhone) ||
      (profilePhone && phonesOverlap(profilePhone, meta.courierPhone))
    );
  });
}

const ACTIVE_DELIVERY_STATUS_KEYS = new Set([
  'accepted',
  'picked_up',
  'on_way',
  'delivering',
  'returning',
  'return_arrived',
]);

/**
 * يمنع قبول طلب جديد إن كان للمندوب توصيل نشط غير مكتمل.
 * يُستثنى أعضاء نفس المجموعة (قبول مجموعة دفعة واحدة).
 */
async function assertCourierCanAcceptNewDelivery(
  courierPhone,
  { incomingGroupId = '' } = {}
) {
  const assigned = await getCourierAssignedOrders(courierPhone);
  const groupId = String(incomingGroupId || '').trim();
  for (const row of assigned) {
    const meta = readOrderMeta(row);
    const status = String(meta.deliveryStatusKey || '').trim().toLowerCase();
    if (!ACTIVE_DELIVERY_STATUS_KEYS.has(status)) continue;
    const existingGroupId = String(meta.payload?.groupId || '').trim();
    if (groupId && existingGroupId && existingGroupId === groupId) {
      continue;
    }
    throw new Error(
      'لديك طلب توصيل نشط. أكمله قبل قبول طلب جديد.'
    );
  }
}

async function acceptDeliveryOrder(courierPhone, orderId, data = {}) {
  const actor = await resolveDeliveryActor(courierPhone);
  const normalizedCourier = actor.phone;
  const id = String(orderId || '').trim();
  if (!id) {
    throw new Error('Order id is required.');
  }

  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) {
    throw new Error('Order not found.');
  }

  const meta = readOrderMeta(row);
  if (!isDeliveryPoolOrder(meta)) {
    throw new Error('Order is not available for delivery.');
  }
  if (!(await canActorTakeDeliveryOrder(actor, meta))) {
    throw new Error('You are not eligible to accept this delivery order.');
  }

  const rejected = Array.isArray(meta.payload.rejectedByCouriers)
    ? meta.payload.rejectedByCouriers.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const actorVariants = getPhoneVariants(normalizedCourier);
  if (actorVariants.some((variant) => rejected.includes(variant))) {
    throw new Error('Order is not available for delivery.');
  }

  const incomingGroupId = String(meta.payload?.groupId || '').trim();
  await assertCourierCanAcceptNewDelivery(normalizedCourier, {
    incomingGroupId,
  });

  const {
    assertAssigneeNotPenaltyFrozen,
  } = require('./delivery_assignee_cancellations');
  await assertAssigneeNotPenaltyFrozen(normalizedCourier, actor.role);

  const { chargeServiceFee, chargeCourierOrderFee } = require('./provider_wallet');
  const { getServiceFees } = require('../services/app_config_service');
  const fees = await getServiceFees();
  const deliveryFee = readDeliveryFeeIqd(meta.payload);
  const minDeliveryFee =
    Number(fees.courierMinDeliveryFeeForCommissionIqd ?? 2000) || 2000;

  if (deliveryFee >= minDeliveryFee) {
    if (actor.role === 'driver') {
      const amount = Number(fees.taxiOrderIqd ?? 250) || 250;
      await chargeServiceFee({
        phone: normalizedCourier,
        providerType: 'driver',
        amountIqd: amount,
        referenceType: 'delivery_order',
        referenceId: id,
        noteAr: `رسوم خدمة توصيل (${amount} د.ع)`,
      });
    } else {
      await chargeCourierOrderFee(normalizedCourier, id);
    }
  }

  const requestedName =
    String(data.courierName ?? data.courier_name ?? '').trim();
  const courierName =
    actor.name ||
    requestedName ||
    (actor.role === 'driver' ? 'كابتن طلب' : 'مندوب طلب');

  const acceptedAt = nowIso();
  const nextOrder = recordDeliveryAcceptance(
    {
      ...meta.payload,
      deliveryStatusKey: 'accepted',
      deliveryStatusAr:
        actor.role === 'driver'
          ? 'الكابتن في الطريق للمتجر'
          : 'المندوب في الطريق للمتجر',
      deliveryStatusEn:
        actor.role === 'driver'
          ? 'Captain heading to store'
          : 'Courier heading to store',
      assignedCourierName: courierName,
      courierPhone: normalizedCourier,
      courierAcceptedAt: acceptedAt,
      deliveryAssigneeRole: actor.role,
    },
    {
      phone: normalizedCourier,
      name: courierName,
      role: actor.role,
      source: 'self',
      at: acceptedAt,
    },
  );

  // The conditional update is the acceptance lock: only one courier/driver can
  // move a waiting, unassigned order to accepted.
  const supabase = assertSupabaseAdmin();
  const updatePayload = {
    status_key: meta.statusKey,
    delivery_status_key: 'accepted',
    order_payload: nextOrder,
    courier_phone: normalizedCourier,
    updated_at: nowIso(),
  };
  const { data: acceptedRows, error } = await supabase
    .from('customer_orders')
    .update(updatePayload)
    .eq('id', id)
    .eq('status_key', 'delivering')
    .eq('delivery_status_key', 'waiting')
    .or('courier_phone.is.null,courier_phone.eq.')
    .select();

  if (error) throw new Error(error.message);
  const acceptedRow = Array.isArray(acceptedRows) ? acceptedRows[0] : acceptedRows;
  if (!acceptedRow) {
    throw new Error('Order is not available for delivery.');
  }

  try {
    const { onOrderSaved } = require('../push_events');
    await onOrderSaved({
      previousMeta: meta,
      nextMeta: readOrderMeta(acceptedRow),
      isNew: false,
    });
  } catch (pushError) {
    console.error('push delivery acceptance error:', pushError?.message || pushError);
  }

  return acceptedRow;
}

async function updateCourierDeliveryStatus(courierPhone, orderId, updates = {}) {
  const normalizedCourier = await resolvePhoneKey(courierPhone);
  const id = String(orderId || '').trim();
  if (!id) {
    throw new Error('Order id is required.');
  }

  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) {
    throw new Error('Order not found.');
  }

  const meta = readOrderMeta(row);
  if (!phonesOverlap(normalizedCourier, meta.courierPhone)) {
    throw new Error('You are not assigned to this order.');
  }

  const deliveryStatusKey = String(
    updates.deliveryStatusKey ?? meta.deliveryStatusKey ?? ''
  ).trim();
  const orderStatus = String(meta.statusKey || '').trim().toLowerCase();
  if (orderStatus === 'return_pending') {
    const allowedReturnKeys = new Set(['returning', 'return_arrived']);
    if (!allowedReturnKeys.has(deliveryStatusKey.toLowerCase())) {
      throw new Error('يجب إرجاع الطلب للمتجر بعد إلغاء الزبون.');
    }
  }
  const isDriverDelivery =
    String(meta.payload.deliveryAssigneeRole ?? '').trim() === 'driver';
  const assigneeAr = isDriverDelivery ? 'الكابتن' : 'المندوب';

  const nextOrder = {
    ...meta.payload,
    deliveryStatusKey,
    deliveryStatusAr: String(updates.deliveryStatusAr ?? meta.payload.deliveryStatusAr ?? '').trim(),
    deliveryStatusEn: String(updates.deliveryStatusEn ?? meta.payload.deliveryStatusEn ?? '').trim(),
    assignedCourierName:
      String(updates.assignedCourierName ?? meta.payload.assignedCourierName ?? '').trim() ||
      meta.payload.assignedCourierName,
    courierPhone: normalizedCourier,
  };

  if (deliveryStatusKey === 'picked_up') {
    nextOrder.deliveryStatusAr = 'تم استلام الطلب من المتجر';
    nextOrder.deliveryStatusEn = 'Order picked up from store';
  }

  if (deliveryStatusKey === 'on_way') {
    nextOrder.deliveryStatusAr = `${assigneeAr} في الطريق للزبون`;
    nextOrder.deliveryStatusEn = isDriverDelivery
      ? 'Captain on the way'
      : 'Courier on the way';
    nextOrder.estimatedArrivalMinutes = 20;
    nextOrder.estimatedArrivalAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  }

  if (deliveryStatusKey === 'delivered' || deliveryStatusKey === 'completed') {
    const posOrder = meta.payload?.posEnabled === true;
    const deliveredAt = nowIso();
    nextOrder.deliveryStatusKey = 'delivered';
    nextOrder.deliveredAt = deliveredAt;
    Object.assign(
      nextOrder,
      recordDeliveryAssignmentEnd(nextOrder, {
        phone: normalizedCourier,
        reason: END_REASONS.DELIVERED,
        at: deliveredAt,
      }),
    );
    if (posOrder) {
      nextOrder.deliveryStatusAr = 'تم التسليم — بانتظار تسليم الصندوق';
      nextOrder.deliveryStatusEn = 'Delivered — awaiting cashier settlement';
      nextOrder.statusKey = 'delivered_awaiting_settlement';
      nextOrder.statusAr = 'بانتظار استلام المبلغ';
      nextOrder.statusEn = 'Awaiting cash settlement';
      nextOrder.codConfirmed = false;
    } else {
      nextOrder.deliveryStatusAr = 'تم التسليم — دفع نقداً';
      nextOrder.deliveryStatusEn = 'Delivered — cash collected';
      nextOrder.statusKey = 'completed';
      nextOrder.statusAr = 'مكتمل';
      nextOrder.statusEn = 'Completed';
      nextOrder.codConfirmed = true;
    }
  }

  return saveCustomerOrder(meta.customerPhone, {
    order: nextOrder,
    merchant_phone: meta.merchantPhone || null,
    courier_phone: normalizedCourier,
  });
}

/**
 * مسح كل حقول تعيين المندوب من البايلود عند إعادة الطلب إلى المجمع.
 * بدون هذا يبقى payload.courierPhone القديم، فيقرأه readOrderMeta فيختفي
 * الطلب من المجمع أو يعلق مع مندوب قديم.
 */
function clearDeliveryAssignment(payload) {
  const p = { ...(payload || {}) };
  delete p.courierPhone;
  delete p.assignedCourierPhone;
  delete p.assignedCourierName;
  delete p.courierName;
  delete p.courierAcceptedAt;
  delete p.deliveryAssigneeRole;
  delete p.estimatedArrivalMinutes;
  delete p.estimatedArrivalAt;
  p.deliveryStatusKey = 'waiting';
  p.deliveryStatusAr = 'بانتظار مندوب';
  p.deliveryStatusEn = 'Waiting for courier';
  return p;
}

async function rejectDeliveryOrder(courierPhone, orderId) {
  const actor = await resolveDeliveryActor(courierPhone);
  const normalizedCourier = actor.phone;
  const id = String(orderId || '').trim();
  if (!id) {
    throw new Error('Order id is required.');
  }

  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) {
    throw new Error('Order not found.');
  }

  const meta = readOrderMeta(row);
  if (!isDeliveryPoolOrder(meta)) {
    throw new Error('Order is not available for delivery.');
  }
  if (!(await canActorTakeDeliveryOrder(actor, meta))) {
    throw new Error('You are not eligible to reject this delivery order.');
  }

  const rejected = Array.isArray(meta.payload.rejectedByCouriers)
    ? meta.payload.rejectedByCouriers.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const variants = getPhoneVariants(normalizedCourier);
  const alreadyRejected = variants.some((variant) => rejected.includes(variant));
  if (!alreadyRejected) {
    rejected.push(normalizedCourier);
  }

  const nextOrder = {
    ...clearDeliveryAssignment(meta.payload),
    rejectedByCouriers: rejected,
  };

  // Conditional reject: never overwrite an order that was already claimed.
  const supabase = assertSupabaseAdmin();
  const { data: rejectedRows, error } = await supabase
    .from('customer_orders')
    .update({
      status_key: meta.statusKey,
      delivery_status_key: 'waiting',
      order_payload: nextOrder,
      courier_phone: null,
      updated_at: nowIso(),
    })
    .eq('id', id)
    .eq('status_key', 'delivering')
    .eq('delivery_status_key', 'waiting')
    .or('courier_phone.is.null,courier_phone.eq.')
    .select();

  if (error) throw new Error(error.message);
  const rejectedRow = Array.isArray(rejectedRows) ? rejectedRows[0] : rejectedRows;
  if (!rejectedRow) {
    throw new Error('Order is not available for delivery.');
  }
  try {
    void notifyDeliveryPoolExpandingWave(readOrderMeta(rejectedRow), {
      force: true,
    }).catch((e) =>
      console.error('delivery reject rematch error:', e?.message || e),
    );
  } catch (_) {}
  return rejectedRow;
}

async function cancelAssignedDeliveryOrderCore(courierPhone, orderId, extra = {}) {
  const actor = await resolveDeliveryActor(courierPhone);
  const normalizedCourier = actor.phone;
  const id = String(orderId || '').trim();
  if (!id) {
    throw new Error('Order id is required.');
  }

  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) {
    throw new Error('Order not found.');
  }

  const meta = readOrderMeta(row);
  if (String(meta.statusKey || '').trim() === 'return_pending') {
    throw new Error('يجب إرجاع الطلب للمتجر بعد إلغاء الزبون.');
  }
  if (meta.statusKey !== 'delivering') {
    throw new Error('Cannot cancel this delivery.');
  }
  if (!phonesOverlap(normalizedCourier, meta.courierPhone)) {
    throw new Error('You are not assigned to this order.');
  }

  const status = String(meta.deliveryStatusKey || '').trim().toLowerCase();
  if (!ACTIVE_DELIVERY_STATUS_KEYS.has(status)) {
    throw new Error('Cannot cancel this delivery.');
  }

  const rejected = Array.isArray(meta.payload.rejectedByCouriers)
    ? meta.payload.rejectedByCouriers.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const variants = getPhoneVariants(normalizedCourier);
  const alreadyRejected = variants.some((variant) => rejected.includes(variant));
  if (!alreadyRejected) {
    rejected.push(normalizedCourier);
  }

  const cancelledAt = String(extra.assigneeCancelledAt || nowIso()).trim();
  const cancelReason = String(extra.assigneeCancelReason || '').trim();
  const endedPayload = recordDeliveryAssignmentEnd(meta.payload, {
    phone: normalizedCourier,
    reason: END_REASONS.CANCELLED_BY_ASSIGNEE,
    at: cancelledAt,
  });
  const nextOrder = {
    ...clearDeliveryAssignment(endedPayload),
    rejectedByCouriers: rejected,
    statusKey: meta.statusKey,
    statusAr: String(meta.payload.statusAr || '').trim(),
    statusEn: String(meta.payload.statusEn || '').trim(),
  };
  if (cancelReason) {
    nextOrder.assigneeCancelReason = cancelReason;
    nextOrder.assigneeCancelledAt = cancelledAt;
    nextOrder.assigneeCancelledBy = normalizedCourier;
    nextOrder.assigneeCancelledByRole = actor.role;
  }

  return saveCustomerOrder(meta.customerPhone, {
    order: nextOrder,
    merchant_phone: meta.merchantPhone || null,
    courier_phone: null,
  });
}

async function getMerchantIncomingOrders(merchantPhone) {
  const variants = getPhoneVariants(merchantPhone);
  if (await hasColumn('customer_orders', 'merchant_phone')) {
    return selectMany(
      'customer_orders',
      [{ method: 'in', column: 'merchant_phone', value: variants }],
      { column: 'created_at', ascending: false }
    );
  }

  const rows = await selectMany(
    'customer_orders',
    [],
    { column: 'created_at', ascending: false }
  );
  return rows.filter((row) => {
    const payload = normalizeObject(row.order_payload);
    const linkedMerchant = String(
      row.merchant_phone ?? payload.merchantPhone ?? ''
    ).trim();
    return phonesOverlap(merchantPhone, linkedMerchant);
  });
}

async function updateIncomingOrderStatus(merchantPhone, orderId, updates = {}) {
  const normalizedMerchant = await resolvePhoneKey(merchantPhone);
  const id = String(orderId || '').trim();
  if (!id) {
    throw new Error('Order id is required.');
  }

  const row = await selectSingle('customer_orders', 'id', id);
  if (!row) {
    throw new Error('Order not found.');
  }

  const payload = normalizeObject(row.order_payload);
  const linkedMerchant = String(
    row.merchant_phone ?? payload.merchantPhone ?? ''
  ).trim();
  if (!phonesOverlap(normalizedMerchant, linkedMerchant)) {
    throw new Error('You are not allowed to update this order.');
  }

  const nextOrder = {
    ...payload,
    statusKey: String(updates.statusKey ?? payload.statusKey ?? 'pending').trim(),
    statusAr: String(updates.statusAr ?? payload.statusAr ?? '').trim(),
    statusEn: String(updates.statusEn ?? payload.statusEn ?? '').trim(),
  };
  if (updates.posTickets !== undefined) {
    nextOrder.posTickets = updates.posTickets;
  }
  if (updates.codConfirmed !== undefined) {
    nextOrder.codConfirmed = Boolean(updates.codConfirmed);
  }
  if (updates.noteAr !== undefined) {
    nextOrder.noteAr = String(updates.noteAr ?? '').trim();
  }
  if (updates.noteEn !== undefined) {
    nextOrder.noteEn = String(updates.noteEn ?? '').trim();
  }

  if (updates.deliveryStatusKey !== undefined) {
    nextOrder.deliveryStatusKey = updates.deliveryStatusKey;
  }
  if (updates.deliveryStatusAr !== undefined) {
    nextOrder.deliveryStatusAr = updates.deliveryStatusAr;
  }
  if (updates.deliveryStatusEn !== undefined) {
    nextOrder.deliveryStatusEn = updates.deliveryStatusEn;
  }

  if (updates.lineItems !== undefined) {
    nextOrder.lineItems = Array.isArray(updates.lineItems) ? updates.lineItems : [];
  }
  if (updates.price !== undefined) {
    nextOrder.price = Number.parseInt(String(updates.price), 10) || 0;
  }
  if (updates.itemsCount !== undefined) {
    nextOrder.itemsCount = Number.parseInt(String(updates.itemsCount), 10) || 0;
  }
  if (updates.itemsNameAr !== undefined) {
    nextOrder.itemsNameAr = String(updates.itemsNameAr ?? '').trim();
  }
  if (updates.itemsNameEn !== undefined) {
    nextOrder.itemsNameEn = String(updates.itemsNameEn ?? '').trim();
  }
  if (updates.originalPrice !== undefined) {
    nextOrder.originalPrice = Number.parseInt(String(updates.originalPrice), 10) || 0;
  }
  if (updates.itemsSubtotalIqd !== undefined) {
    nextOrder.itemsSubtotalIqd =
      Number.parseInt(String(updates.itemsSubtotalIqd), 10) || 0;
  }
  // أجرة التوصيل تبقى كما حددها النظام عند إنشاء الطلب (حسب المسافة).
  // التاجر لا يستطيع تغييرها — أي قيمة يرسلها تُتجاهل ويبقى السعر الأصلي.
  // (كان يمكن تجاوزها عبر updates.deliveryFeeIqd — أُزيل عمداً.)
  if (updates.promoDiscountIqd !== undefined) {
    nextOrder.promoDiscountIqd =
      Number.parseInt(String(updates.promoDiscountIqd), 10) || 0;
  }
  if (updates.merchantDecisionAt !== undefined) {
    nextOrder.merchantDecisionAt = String(updates.merchantDecisionAt ?? '').trim() || null;
  }
  if (updates.isPriceLocked !== undefined) {
    nextOrder.isPriceLocked = Boolean(updates.isPriceLocked);
  }

  const previousStatus = String(payload.statusKey || '').trim().toLowerCase();
  if (
    nextOrder.posEnabled === true &&
    previousStatus === 'pending' &&
    nextOrder.statusKey === 'delivering'
  ) {
    nextOrder.statusKey = 'accepted';
    nextOrder.statusAr = 'قيد التجهيز';
    nextOrder.statusEn = 'Preparing';
  }
  if (
    nextOrder.statusKey === 'delivering' &&
    previousStatus !== 'return_pending'
  ) {
    nextOrder.deliveryStatusKey = 'waiting';
    nextOrder.deliveryStatusAr = 'بانتظار مندوب التوصيل';
    nextOrder.deliveryStatusEn = 'Waiting for courier';
    // العودة إلى المجمع تعني أن الطلب لم يعد معيّناً لأي مندوب —
    // امسح تعيين المندوب من البايلود حتى يظهر الطلب مجدداً.
    delete nextOrder.courierPhone;
    delete nextOrder.assignedCourierPhone;
    delete nextOrder.assignedCourierName;
    delete nextOrder.courierName;
    delete nextOrder.estimatedArrivalMinutes;
    delete nextOrder.estimatedArrivalAt;
    await stampOrderCourierMode(nextOrder, normalizedMerchant);
  }

  if (
    previousStatus === 'return_pending' &&
    String(nextOrder.statusKey || '').trim().toLowerCase() === 'cancelled'
  ) {
    nextOrder.deliveryStatusKey = 'returned';
    nextOrder.deliveryStatusAr =
      String(updates.deliveryStatusAr ?? '').trim() ||
      'استلم التاجر المنتج المُرجع';
    nextOrder.deliveryStatusEn =
      String(updates.deliveryStatusEn ?? '').trim() ||
      'Merchant received returned goods';
    nextOrder.returnConfirmedAt = nowIso();
    nextOrder.returnConfirmedByMerchant = true;
  }

  const nextStatus = String(nextOrder.statusKey || '').trim().toLowerCase();
  if (
    ['cancelled', 'rejected'].includes(nextStatus) &&
    String(nextOrder.deliveryStatusKey || '').trim() === 'waiting'
  ) {
    nextOrder.deliveryStatusKey = null;
    nextOrder.deliveryStatusAr = null;
    nextOrder.deliveryStatusEn = null;
  }
  const shouldDecrementStock =
    previousStatus === 'pending' &&
    (nextStatus === 'accepted' ||
      nextStatus === 'delivering' ||
      nextStatus === 'completed') &&
    nextOrder.stockDecremented !== true;

  if (shouldDecrementStock) {
    try {
      const { decrementStockForAcceptedOrder } = require('./merchants');
      const stockResult = await decrementStockForAcceptedOrder(nextOrder);
      if (!stockResult?.skipped) {
        nextOrder.stockDecremented = true;
      }
    } catch (stockError) {
      console.error(
        'decrementStockForAcceptedOrder error:',
        stockError?.message || stockError,
      );
    }
  }

  return saveCustomerOrder(row.phone, {
    order: nextOrder,
    merchant_phone: linkedMerchant,
  });
}

async function saveMerchantReview({
  merchantPhone,
  customerPhone,
  customerName,
  orderId,
  stars,
  comment,
}) {
  const supabase = assertSupabaseAdmin();

  try {
    const { payload, merchantPhone: mPhone } = await buildMerchantReviewUpsertPayload({
      merchantPhone,
      customerPhone,
      customerName,
      orderId,
      stars,
      comment,
    });

    const { data: review, error } = await supabase
      .from('merchant_reviews')
      .upsert(payload, { onConflict: 'order_id' })
      .select()
      .maybeSingle();

    if (error) throw error;

    const ownerFilter = await getMerchantReviewOwnerFilter(mPhone);
    if (ownerFilter) {
      const { data: allReviews, error: fetchError } = await supabase
        .from('merchant_reviews')
        .select('stars')
        .eq(ownerFilter.column, ownerFilter.value);

      if (!fetchError && allReviews.length > 0) {
        const totalStars = allReviews.reduce((sum, r) => sum + (Number(r.stars) || 0), 0);
        const avgRating = (totalStars / allReviews.length).toFixed(1);

        await supabase
          .from('merchant_profiles')
          .update({ rating: parseFloat(avgRating) })
          .eq('phone', mPhone);
      }
    }

    if (review) {
      try {
        await require('../push_events').notifyMerchantNewReview(mPhone, orderId, stars);
      } catch (pushError) {
        console.error('notifyMerchantNewReview error:', pushError?.message || pushError);
      }
    }

    return review;
  } catch (error) {
    console.error('saveMerchantReview error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * تقييم المندوب بعد التوصيل — يحدّث إحصاءات courier_profiles
 * (rating / ratingCount داخل profile_payload) بنفس نمط تقييم الكابتن.
 */
async function rateCourier(customerPhone, courierPhone, stars, comment) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const targetPhone = await resolvePhoneKey(courierPhone);
  const rating = Number(stars);
  if (!targetPhone) throw new Error('Courier phone is required.');
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error('Rating must be between 1 and 5.');
  }

  const courierProfile = await getCourierProfile(targetPhone);
  if (!courierProfile) throw new Error('Courier not found.');

  const prevRating = Number(courierProfile.rating ?? 0);
  const prevCount = Number(courierProfile.ratingCount ?? 0);
  const count = prevCount + 1;
  const avg =
    prevCount > 0
      ? Math.round(((prevRating * prevCount + rating) / count) * 10) / 10
      : rating;

  const trimmedComment = String(comment || '').trim().slice(0, 500);
  const updated = await saveCourierProfile(targetPhone, {
    rating: avg,
    ratingCount: count,
    lastRatingComment: trimmedComment || undefined,
  });

  return {
    success: true,
    courierPhone: targetPhone,
    rating: Number(updated.rating ?? avg),
    ratingCount: Number(updated.ratingCount ?? count),
  };
}

function parcelPackageLabelAr(packageType) {
  switch (String(packageType || '').trim()) {
    case 'parcel':
      return 'طرد';
    case 'items':
      return 'أغراض';
    default:
      return 'ظرف';
  }
}

async function createParcelOrder(customerPhone, data = {}) {
  const phone = await resolvePhoneKey(customerPhone);
  await ensureAppUser(phone, data);

  const pickup = String(
    data.pickup ?? data.pickupAddress ?? data.pickup_address ?? '',
  ).trim();
  const dropoff = String(
    data.dropoff ?? data.dropoffAddress ?? data.dropoff_address ?? '',
  ).trim();
  if (!pickup) throw new Error('عنوان الاستلام مطلوب.');
  if (!dropoff) throw new Error('عنوان التسليم مطلوب.');

  let deliveryFeeIqd = Number.parseInt(
    data.deliveryFeeIqd ?? data.delivery_fee_iqd ?? 0,
    10,
  );
  let distanceKm = Number(data.distanceKm ?? data.distance_km ?? 0) || 0;
  if (!deliveryFeeIqd || deliveryFeeIqd < 0) {
    try {
      const { quoteCourierDeliveryByAddresses } = require('../lib/courier_delivery_quote');
      const quote = await quoteCourierDeliveryByAddresses(pickup, dropoff);
      deliveryFeeIqd = quote.feeIqd;
      distanceKm = quote.distanceKm;
    } catch (error) {
      console.warn('parcel fee quote error:', error?.message || error);
      const { getDeliveryConfig } = require('../services/app_config_service');
      const cfg = await getDeliveryConfig();
      deliveryFeeIqd = Number(cfg.minFee) || 1000;
    }
  }

  const orderId = String(data.id ?? randomUUID()).trim();
  const packageType = String(data.packageType ?? data.package_type ?? 'mail').trim();
  const details = String(data.details ?? data.note ?? '').trim();
  const receiverPhone = String(
    data.receiverPhone ?? data.receiver_phone ?? '',
  ).trim();
  const customerName = String(
    data.customerName ?? data.customer_name ?? 'زبون طلب',
  ).trim();
  const createdAt = nowIso();
  const orderNumber =
    String(data.orderNumber ?? data.order_number ?? '').trim() ||
    `#${String(Date.now() % 1000000).padStart(6, '0')}`;

  const order = {
    id: orderId,
    orderNumber,
    orderType: 'parcel',
    statusKey: 'delivering',
    statusAr: 'بانتظار مندوب',
    statusEn: 'Waiting for courier',
    deliveryStatusKey: 'waiting',
    deliveryStatusAr: 'بانتظار قبول المندوب',
    deliveryStatusEn: 'Waiting for courier acceptance',
    requiresDelivery: true,
    customerPhone: phone,
    customerNameAr: customerName,
    customerNameEn: customerName,
    addressAr: dropoff,
    addressEn: dropoff,
    pickupAddressAr: pickup,
    pickupAddressEn: pickup,
    dropoffAddressAr: dropoff,
    dropoffAddressEn: dropoff,
    packageType,
    noteAr: details,
    noteEn: details,
    receiverPhone,
    paymentMethodAr: 'نقداً عند الاستلام',
    paymentMethodEn: 'Cash on delivery',
    price: deliveryFeeIqd,
    deliveryFeeIqd,
    distanceKm: distanceKm > 0 ? distanceKm : undefined,
    itemsCount: 1,
    itemsNameAr: `شحنة ${parcelPackageLabelAr(packageType)}`,
    itemsNameEn: `Parcel ${packageType}`,
    lineItems: [],
    createdAt,
    isRestaurantOrder: false,
    codConfirmed: false,
  };

  const payload = {
    id: orderId,
    phone,
    order_number: orderNumber,
    status_key: 'delivering',
    delivery_status_key: 'waiting',
    order_payload: order,
    updated_at: createdAt,
  };

  const savedRow = await saveRow('customer_orders', payload, 'id');
  const orderOut = mapOrderRow(savedRow);

  try {
    const {
      socketBroadcast,
      customerRoom,
      couriersRoom,
      adminOpsRoom,
    } = require('../lib/socket_broadcast');
    void socketBroadcast({
      room: customerRoom(phone),
      event: 'order:status',
      payload: orderOut,
    });
    void socketBroadcast({
      room: couriersRoom(),
      event: 'delivery:pool_new',
      payload: orderOut,
    });
    void socketBroadcast({
      room: adminOpsRoom(),
      event: 'live:ops',
      payload: { type: 'parcel_order', orderId, orderNumber },
    });
  } catch (error) {
    console.warn('parcel order socket broadcast error:', error?.message || error);
  }

  return orderOut;
}

module.exports = {
  listAllCustomerOrders,
  listPendingOrders,
  listOrdersWithDeliveryStatus,
  getCustomerOrders,
  saveCustomerOrder,
  createParcelOrder,
  readOrderMeta,
  mapOrderRow,
  isDeliveryPoolOrder,
  getDeliveryPoolOrders,
  notifyDeliveryPoolExpandingWave,
  runDeliveryExpandingSearchWaves,
  getCourierAssignedOrders,
  acceptDeliveryOrder,
  updateCourierDeliveryStatus,
  rejectDeliveryOrder,
  cancelAssignedDeliveryOrderCore,
  getMerchantIncomingOrders,
  updateIncomingOrderStatus,
  saveMerchantReview,
  rateCourier,
  resolveRegisteredDeliveryAssignee,
};
