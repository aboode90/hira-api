const {
  nowIso,
  normalizeObject,
  getPhoneVariants,
  phonesOverlap,
  resolvePhoneKey,
  normalizeArray,
  selectMany,
  selectManyColumns,
  selectSingleByPhone,
  selectSingle,
  saveRow,
  updateRow,
  assertSupabaseAdmin,
  hasColumn,
  PLATFORM_ADMIN_PHONES,
  PLATFORM_SETTINGS_PHONE,
} = require('./common');
const {
  ensureAppUser,
  getAppUser,
  getUserState,
  saveUserState,
  saveAppUser,
  assertAdminAccess,
  getConfiguredAdminPhones,
  getAppUserId,
} = require('./users');
const {
  bumpSessionEpoch,
  invalidateSessionGate,
} = require('../lib/session_gate');
const {
  getMerchantProfile,
  profileServiceIds,
  isMerchantFrozen,
  isProfessionalMerchantProfile,
  merchantProfileDisplayName,
  isMerchantApproved,
  merchantApprovalStatus,
  isProductApproved,
  productApprovalStatus,
  merchantRejectionMessage,
  MERCHANT_REJECTION_REASONS,
  mapMerchantApprovalFields,
  updateMerchantApprovalRecord,
  evaluateBazaarCustomerVisibility,
  ensureMerchantProfileRecord,
  syncMissingMerchantProfilesFromAppState,
  syncProfileSubCategoriesFromAppState,
  saveMerchantProfile,
  resolveMerchantContactVisibility,
  merchantProfileSections,
} = require('./merchants');
const {
  saveCustomerProfile,
} = require('./customer_data');
const {
  readCourierProfileFromState,
  isCourierProfileComplete,
  isCourierApproved,
  COURIER_REJECTION_REASONS,
  courierApprovalStatus,
  courierRejectionMessage,
  mapCourierForAdmin,
  readDriverProfileFromState,
  isDriverProfileComplete,
  isDriverApproved,
  driverApprovalStatus,
  driverRejectionMessage,
  mapDriverForAdmin,
} = require('./couriers_drivers');
const {
  readOrderMeta,
  getMerchantIncomingOrders,
} = require('./orders');
const { resolveOrderCancelActor } = require('../lib/order_cancel_actor');
const {
  normalizeProductImagePayload,
  serializeProductRowForClient,
} = require('../services/image_refs');
const {
  getMerchantProducts,
  deleteMerchantProfile,
  saveMerchantProduct,
} = require('./merchants');
const { saveMerchantServiceProfile } = require('./merchant_service_profiles');
const {
  deleteCustomerProfile,
  deleteAppUser,
  deleteUserState,
} = require('./users');
const {
  getDriverProfile,
  saveDriverProfile,
  getCourierProfile,
  saveCourierProfile,
  readCourierLiveLocations,
  deleteCourierProfile,
  deleteDriverProfile,
  rowToDriverProfileMap,
  rowToCourierProfileMap,
} = require('./operator_profiles');
const {
  DEFAULT_PROFESSIONAL_CATEGORIES,
  mergeProfessionalCategories,
  normalizeAdminCategoriesPayload,
  buildCategoryMaps,
  labelForCategoryId,
} = require('../lib/professional_categories');

function applyLiveLocations(items, liveByKey) {
  return (items || []).map((item) => {
    const key = String(item.phone || '').replace(/\D/g, '').slice(-10);
    const live = liveByKey.get(key);
    const lat = Number(live?.lat ?? item.lastLat ?? 0);
    const lng = Number(live?.lng ?? item.lastLng ?? 0);
    const has =
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) > 0.0001 &&
      Math.abs(lng) > 0.0001;
    return {
      ...item,
      lastLat: has ? lat : null,
      lastLng: has ? lng : null,
      locationUpdatedAt: live?.updatedAt || item.locationUpdatedAt || null,
      mapsUrl: has ? `https://www.google.com/maps?q=${lat},${lng}` : null,
    };
  });
}

function iraqDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function emptyDayBuckets(days) {
  const out = [];
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = iraqDayKey(new Date(now - i * DAY_MS).toISOString());
    if (!key) continue;
    out.push({ day: key, count: 0, completed: 0, cancelled: 0 });
  }
  return out;
}

function fillDayBuckets(buckets, rows) {
  const map = new Map(buckets.map((item) => [item.day, item]));
  for (const row of rows || []) {
    const bucket = map.get(iraqDayKey(row.created_at));
    if (!bucket) continue;
    bucket.count += 1;
    const status = String(row.status_key || '').trim();
    if (status === 'completed' || status === 'done' || status === 'delivered') {
      bucket.completed += 1;
    }
    if (status === 'cancelled' || status === 'rejected' || status === 'failed') {
      bucket.cancelled += 1;
    }
  }
  return buckets;
}

async function buildEmptyAdminReports(extra = {}) {
  return {
    totalOrders: 0,
    completedOrders: 0,
    pendingOrders: 0,
    deliveringOrders: 0,
    cancelledOrders: 0,
    returningOrders: 0,
    ordersByStatus: {},
    totalSales: 0,
    salesWindowDays: 30,
    codCollected: 0,
    avgOrderValue: 0,
    recentRevenue: 0,
    revenueGrowth: 0,
    totalMerchants: 0,
    totalStoreMerchants: 0,
    totalProfessionals: 0,
    totalCustomers: 0,
    openMerchants: 0,
    frozenMerchants: 0,
    pendingMerchantsCount: 0,
    rejectedMerchantsCount: 0,
    bazaarMerchants: 0,
    topMerchants: [],
    totalProducts: 0,
    totalUsers: 0,
    activeUsersCount: 0,
    totalCouriers: 0,
    totalDrivers: 0,
    totalAdminAccounts: 0,
    merchantOrdersToday: 0,
    merchantOrdersLast7Days: 0,
    merchantOrdersLast30Days: 0,
    taxiTripsToday: 0,
    taxiTripsLast7Days: 0,
    taxiTripsLast30Days: 0,
    taxiTripsTotal: 0,
    dailyOrders: emptyDayBuckets(14),
    dailyTaxi: emptyDayBuckets(14),
    recentOrders: [],
    degraded: true,
    ...extra,
  };
}

/** تقرير خفيف للوحة الإدارة تحت ضغط DB — عدّادات head فقط بدون صفوف ثقيلة. */
async function getAdminReportsLite(phone) {
  await assertAdminAccess(phone);
  const { isDbCircuitOpen, beginAdminPriority } = require('../lib/db_circuit');
  const {
    getCached,
    getLastGood,
    rememberAdmin,
    setCachedWithLastGood,
    DEFAULT_TTLS,
  } = require('../lib/response_cache');
  beginAdminPriority();

  const cacheKey = 'admin:reports:lite';
  const serveLastGood = async (reason) => {
    const lastGood = await getLastGood(cacheKey);
    if (lastGood?.value) {
      return {
        ...lastGood.value,
        cacheHit: true,
        stale: true,
        degraded: false,
        reason,
      };
    }
    return null;
  };

  if (isDbCircuitOpen()) {
    const cached = await getCached(cacheKey);
    if (cached?.value && cached.value.degraded !== true) {
      return { ...cached.value, cacheHit: true, reason: 'cache_under_pressure' };
    }
    const stale = await serveLastGood('stale_under_pressure');
    if (stale) return stale;
    // محاولة قصيرة واحدةحدة لملء الكاش حتى لو الدائرة مفتوحة — بدون إغراق.
    try {
      const probe = await loadAdminReportsLiteCounts({ timeoutMs: 1200 });
      const hasSignal =
        Number(probe.totalOrders || 0) +
          Number(probe.totalProducts || 0) +
          Number(probe.totalDrivers || 0) >
        0;
      if (hasSignal) {
        await setCachedWithLastGood(cacheKey, probe, DEFAULT_TTLS.adminReportsLite);
        try {
          const { recordDbSuccess } = require('../lib/db_circuit');
          recordDbSuccess();
        } catch (_) {}
        return { ...probe, reason: 'probe_under_pressure' };
      }
    } catch (_) {}
    return buildEmptyAdminReports({ reason: 'db_circuit_open' });
  }

  const cachedFresh = await getCached(cacheKey);
  if (cachedFresh?.value && cachedFresh.value.degraded !== true) {
    return { ...cachedFresh.value, cacheHit: true };
  }

  try {
    const result = await rememberAdmin(cacheKey, DEFAULT_TTLS.adminReportsLite, () =>
      loadAdminReportsLiteCounts({ timeoutMs: 2500 }),
    );
    return result.value;
  } catch (error) {
    console.warn('admin reports lite failed:', error?.message || error);
    const stale = await serveLastGood('stale_after_error');
    if (stale) return stale;
    return buildEmptyAdminReports({ reason: 'lite_error' });
  }
}

async function loadAdminReportsLiteCounts({ timeoutMs = 2500 } = {}) {
  const supabase = assertSupabaseAdmin();
  const softCount = async (label, build) => {
    try {
      const query = build(supabase);
      const { count, error } = await Promise.race([
        query,
        new Promise((resolve) =>
          setTimeout(() => resolve({ count: 0, error: { message: 'lite_timeout' } }), timeoutMs),
        ),
      ]);
      if (error) {
        console.warn(`admin reports lite ${label}:`, error.message || error);
        return 0;
      }
      return Number(count) || 0;
    } catch (error) {
      console.warn(`admin reports lite ${label}:`, error?.message || error);
      return 0;
    }
  };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const [
    totalOrders,
    pendingOrders,
    completedOrders,
    totalProducts,
    totalDrivers,
    totalCouriers,
    merchantOrdersToday,
    taxiTripsToday,
    taxiTripsTotal,
  ] = await Promise.all([
    softCount('orders', (sb) =>
      sb.from('customer_orders').select('*', { count: 'exact', head: true }),
    ),
    softCount('pending', (sb) =>
      sb
        .from('customer_orders')
        .select('*', { count: 'exact', head: true })
        .in('status_key', ['pending', 'accepted', 'preparing', 'confirmed', 'ready']),
    ),
    softCount('completed', (sb) =>
      sb
        .from('customer_orders')
        .select('*', { count: 'exact', head: true })
        .eq('status_key', 'completed'),
    ),
    softCount('products', (sb) =>
      sb.from('merchant_products').select('*', { count: 'exact', head: true }),
    ),
    softCount('drivers', (sb) =>
      sb.from('driver_profiles').select('*', { count: 'exact', head: true }),
    ),
    softCount('couriers', (sb) =>
      sb.from('courier_profiles').select('*', { count: 'exact', head: true }),
    ),
    softCount('ordersToday', (sb) =>
      sb
        .from('customer_orders')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', todayIso),
    ),
    softCount('taxiToday', (sb) =>
      sb
        .from('taxi_requests')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', todayIso),
    ),
    softCount('taxiTotal', (sb) =>
      sb.from('taxi_requests').select('*', { count: 'exact', head: true }),
    ),
  ]);

  return buildEmptyAdminReports({
    degraded: false,
    totalOrders,
    pendingOrders,
    completedOrders,
    totalProducts,
    totalDrivers,
    totalCouriers,
    merchantOrdersToday,
    taxiTripsToday,
    taxiTripsTotal,
    reason: 'lite',
  });
}

async function getAdminReports(phone) {
  const { isDbCircuitOpen, beginAdminPriority } = require('../lib/db_circuit');
  const { getCached, getLastGood, rememberAdmin, DEFAULT_TTLS } = require('../lib/response_cache');
  beginAdminPriority();

  if (isDbCircuitOpen()) {
    const cached = await getCached('admin:reports:full');
    if (cached?.value) {
      return { ...cached.value, cacheHit: true, reason: 'cache_under_pressure' };
    }
    const lastGood = await getLastGood('admin:reports:lite');
    if (lastGood?.value) {
      return { ...lastGood.value, cacheHit: true, stale: true, reason: 'stale_under_pressure' };
    }
    return getAdminReportsLite(phone);
  }

  try {
    const wrapped = await rememberAdmin('admin:reports:full', DEFAULT_TTLS.adminReportsFull, async () =>
      Promise.race([
        getAdminReportsFull(phone),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('admin_reports_timeout')), 8000),
        ),
      ]),
    );
    return wrapped.value;
  } catch (error) {
    console.warn('admin reports fallback to lite:', error?.message || error);
    return getAdminReportsLite(phone);
  }
}

async function getAdminReportsFull(phone) {
  await assertAdminAccess(phone);
  // لا ننتظر مزامنة ثقيلة هنا — كانت تُعطّل لوحة الإحصائيات.
  void syncMissingMerchantProfilesFromAppState().catch(() => {});

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const weekAgoIso = new Date(now - 7 * DAY_MS).toISOString();
  const monthAgoIso = new Date(now - 30 * DAY_MS).toISOString();
  const fourteenAgoIso = new Date(now - 14 * DAY_MS).toISOString();

  const supabase = assertSupabaseAdmin();

  const soft = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      console.warn(`admin reports ${label}:`, error?.message || error);
      return fallback;
    }
  };

  const countExact = async (table, apply) =>
    soft(`count:${table}`, async () => {
      let query = supabase.from(table).select('*', { count: 'exact', head: true });
      if (typeof apply === 'function') query = apply(query);
      const { count, error } = await query;
      if (error) {
        console.warn(`admin reports count ${table}:`, error.message || error);
        return 0;
      }
      return Number(count) || 0;
    }, 0);

  const countOrdersSince = (sinceIso) =>
    countExact('customer_orders', (q) => q.gte('created_at', sinceIso));
  const countTaxiSince = (sinceIso) =>
    countExact('taxi_requests', (q) => q.gte('created_at', sinceIso));

  const countAppUsers = async (builder) =>
    soft('count:app_users', async () => {
      let query = supabase.from('app_users').select('*', { count: 'exact', head: true });
      if (typeof builder === 'function') query = builder(query);
      const { count, error } = await query;
      if (error) {
        console.warn('admin reports users count:', error.message || error);
        return 0;
      }
      return Number(count) || 0;
    }, 0);

  const [
    orders,
    merchants,
    totalProducts,
    totalUsers,
    totalCustomers,
    driverCount,
    courierCount,
    merchantOrdersToday,
    merchantOrdersLast7Days,
    merchantOrdersLast30Days,
    totalOrders,
    completedOrders,
    pendingOrders,
    deliveringOrders,
    cancelledOrders,
    returningOrders,
    taxiTripsToday,
    taxiTripsLast7Days,
    taxiTripsLast30Days,
    taxiTripsTotal,
    dailyOrderRows,
    dailyTaxiRows,
    completedMonthRows,
  ] = await Promise.all([
    soft('orders', () => selectMany('customer_orders', [], { column: 'updated_at', ascending: false }, 50), []),
    soft('merchants', () => selectMany('merchant_profiles', [], { column: 'store_name', ascending: true }, 500), []),
    soft('products', async () => {
      const r = await supabase.from('merchant_products').select('*', { count: 'exact', head: true });
      return r.count || 0;
    }, 0),
    countAppUsers(),
    countAppUsers((q) => q.or('role.eq.customer,account_type.eq.customer')),
    soft('drivers', async () => {
      const r = await supabase.from('driver_profiles').select('*', { count: 'exact', head: true });
      return r.count || 0;
    }, 0),
    soft('couriers', async () => {
      const r = await supabase.from('courier_profiles').select('*', { count: 'exact', head: true });
      return r.count || 0;
    }, 0),
    countOrdersSince(todayIso),
    countOrdersSince(weekAgoIso),
    countOrdersSince(monthAgoIso),
    countExact('customer_orders'),
    countExact('customer_orders', (q) => q.eq('status_key', 'completed')),
    countExact('customer_orders', (q) =>
      q.in('status_key', ['pending', 'accepted', 'preparing', 'confirmed', 'ready']),
    ),
    countExact('customer_orders', (q) => q.eq('status_key', 'delivering')),
    countExact('customer_orders', (q) =>
      q.in('status_key', ['cancelled', 'rejected', 'failed']),
    ),
    countExact('customer_orders', (q) => q.eq('status_key', 'return_pending')),
    countTaxiSince(todayIso),
    countTaxiSince(weekAgoIso),
    countTaxiSince(monthAgoIso),
    countExact('taxi_requests'),
    soft('dailyOrders', async () => {
      const r = await supabase
        .from('customer_orders')
        .select('created_at, status_key')
        .gte('created_at', fourteenAgoIso)
        .limit(2000);
      return r.error ? [] : r.data || [];
    }, []),
    soft('dailyTaxi', async () => {
      const r = await supabase
        .from('taxi_requests')
        .select('created_at, status_key')
        .gte('created_at', fourteenAgoIso)
        .limit(2000);
      return r.error ? [] : r.data || [];
    }, []),
    soft('completedMonth', async () => {
      const r = await supabase
        .from('customer_orders')
        .select('merchant_phone, order_payload, status_key')
        .eq('status_key', 'completed')
        .gte('created_at', monthAgoIso)
        .limit(1500);
      return r.error ? [] : r.data || [];
    }, []),
  ]);

  let totalSales = 0;
  let codCollected = 0;
  const merchantRevenue = {};
  for (const row of completedMonthRows) {
    const payload =
      row.order_payload && typeof row.order_payload === 'object' ? row.order_payload : {};
    const price = Number(payload.price) || 0;
    totalSales += price;
    if (payload.codConfirmed) codCollected += price;
    const merchantPhone = String(row.merchant_phone || payload.merchantPhone || '').trim();
    if (!merchantPhone) continue;
    if (!merchantRevenue[merchantPhone]) {
      merchantRevenue[merchantPhone] = { revenue: 0, orderCount: 0 };
    }
    merchantRevenue[merchantPhone].revenue += price;
    merchantRevenue[merchantPhone].orderCount += 1;
  }

  const ordersByStatus = {};
  for (const row of dailyOrderRows) {
    const status = String(row.status_key || 'unknown').trim() || 'unknown';
    ordersByStatus[status] = (ordersByStatus[status] || 0) + 1;
  }
  const avgOrderValue =
    completedMonthRows.length > 0 ? Math.round(totalSales / completedMonthRows.length) : 0;
  const recentRevenue = totalSales;
  const revenueGrowth = 0;

  const pendingMerchants = merchants.filter((m) => {
    const st = String(m.approval_status || '').trim();
    return st === 'pending' || (!st && !isMerchantApproved(m));
  }).length;
  const frozenMerchants = merchants.filter((m) => isMerchantFrozen(m)).length;
  const rejectedMerchantsCount = merchants.filter((m) => (String(m.approval_status || '').trim()) === 'rejected').length;
  const bazaarMerchants = merchants.filter((m) => m.is_bazaar_member === true).length;

  const professionalMerchants = merchants.filter((m) => isProfessionalMerchantProfile(m));
  const totalProfessionals = professionalMerchants.length;
  // تجار المتاجر (ليسوا مهنيين)
  const totalStoreMerchants = Math.max(0, merchants.length - totalProfessionals);

  const topMerchants = Object.entries(merchantRevenue)
    .map(([phoneKey, stats]) => {
      const profile = merchants.find((m) => {
        try {
          return getPhoneVariants(m.phone).includes(phoneKey) || m.phone === phoneKey;
        } catch (_) {
          return m.phone === phoneKey;
        }
      });
      return {
        phone: phoneKey,
        storeName:
          (profile && (merchantProfileDisplayName(profile) || profile.store_name)) || phoneKey,
        revenue: stats.revenue,
        orderCount: stats.orderCount,
      };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const recentOrders = orders.slice(0, 12).map((row) => {
    const meta = readOrderMeta(row);
    const createdAt =
      meta.payload.createdAt ||
      row.created_at ||
      row.updated_at ||
      null;
    const cancel = resolveOrderCancelActor(meta.payload, meta.statusKey);
    return {
      id: meta.id, orderNumber: meta.payload.orderNumber, statusKey: meta.statusKey,
      statusAr: cancel.displayStatusAr || meta.payload.statusAr,
      cancelledBy: cancel.cancelledBy,
      cancelledByAr: cancel.cancelledByAr,
      cancelReasonKey: cancel.cancelReasonKey,
      noteAr: meta.payload.noteAr || '',
      price: meta.payload.price,
      merchantStoreName: meta.payload.merchantStoreName, customerNameAr: meta.payload.customerNameAr,
      customerPhone: meta.customerPhone || meta.payload.customerPhone || '',
      deliveryStatusKey: meta.deliveryStatusKey,
      createdAt,
      updatedAt: row.updated_at || createdAt,
    };
  });

  return {
    totalOrders,
    completedOrders,
    pendingOrders,
    deliveringOrders,
    cancelledOrders,
    returningOrders,
    ordersByStatus,
    totalSales,
    salesWindowDays: 30,
    codCollected,
    avgOrderValue,
    recentRevenue,
    revenueGrowth,
    totalMerchants: totalStoreMerchants,
    totalStoreMerchants,
    totalProfessionals,
    totalCustomers,
    openMerchants: merchants.filter((r) => r.is_open !== false && !isMerchantFrozen(r) && !isProfessionalMerchantProfile(r)).length,
    frozenMerchants, pendingMerchantsCount: pendingMerchants, rejectedMerchantsCount,
    bazaarMerchants, topMerchants,
    totalProducts, totalUsers, activeUsersCount: 0,
    totalCouriers: courierCount, totalDrivers: driverCount, totalAdminAccounts: 0,
    merchantOrdersToday,
    merchantOrdersLast7Days,
    merchantOrdersLast30Days,
    taxiTripsToday,
    taxiTripsLast7Days,
    taxiTripsLast30Days,
    taxiTripsTotal,
    dailyOrders: fillDayBuckets(emptyDayBuckets(14), dailyOrderRows),
    dailyTaxi: fillDayBuckets(emptyDayBuckets(14), dailyTaxiRows),
    recentOrders,
  };
}

function resolveMerchantServiceSubCategory(profile) {
  const direct = String(profile?.service_sub_category || '').trim();
  if (direct) return direct;
  const store = normalizeObject(profile?.store_data);
  return String(
    store.serviceSubCategory ||
      store.service_sub_category ||
      store.subCategoryId ||
      store.sub_category_id ||
      '',
  ).trim();
}

function resolveMerchantSpecialty(profile, state) {
  const info = normalizeObject(profile?.professional_info ?? profile?.professionalInfo);
  const fromInfo = String(info.specialty ?? '').trim();
  if (fromInfo) return fromInfo;

  const normalizedState = normalizeObject(state);
  const merchantStore = normalizeObject(normalizedState.merchantStore);
  const fromStore = String(merchantStore.specialty ?? '').trim();
  if (fromStore) return fromStore;

  const professionalInfo = normalizeObject(
    merchantStore.professionalInfo ?? merchantStore.professional_info,
  );
  return String(professionalInfo.specialty ?? '').trim();
}

function enrichMerchantSummaryFromState(summary, state) {
  const normalizedState = normalizeObject(state);
  const merchantStore = normalizeObject(normalizedState.merchantStore);
  const next = { ...summary };

  if (!String(next.primaryServiceId ?? '').trim()) {
    next.primaryServiceId = String(
      merchantStore.primary_service_id ??
        merchantStore.primaryServiceId ??
        merchantStore.active_service_id ??
        merchantStore.activeServiceId ??
        merchantStore.category ??
        '',
    ).trim();
  }

      if (!String(next.serviceSubCategory ?? '').trim()) {
        next.serviceSubCategory = String(
          merchantStore.serviceSubCategory ??
            merchantStore.service_sub_category ??
            merchantStore.subCategoryId ??
            merchantStore.sub_category_id ??
            '',
        ).trim();
      }

      if (
        !String(next.serviceSubCategory ?? '').trim() &&
        String(next.primaryServiceId ?? '').trim() === 'beauty' &&
        merchantStore.adminPreRegistered === true
      ) {
        const sub = String(
          merchantStore.subCategoryId ?? merchantStore.sub_category_id ?? '',
        ).trim();
        if (sub) next.serviceSubCategory = sub;
      }

  if (!Array.isArray(next.serviceIds) || next.serviceIds.length === 0) {
    const ids = normalizeArray(merchantStore.serviceIds ?? merchantStore.service_ids);
    if (ids.length > 0) next.serviceIds = ids;
  }

  if (!String(next.specialty ?? '').trim()) {
    next.specialty = resolveMerchantSpecialty(summary, normalizedState);
  }

  return next;
}

async function getAllMerchants(adminPhone) {
  await assertAdminAccess(adminPhone);
  await syncMissingMerchantProfilesFromAppState();

  const [merchants, orders] = await Promise.all([
    selectMany('merchant_profiles', [], { column: 'store_name', ascending: true }),
    // تحديث: نحدد عدد الطلبات إلى 500 لتقليل وقت التحميل
    selectMany('customer_orders', [], { column: 'updated_at', ascending: false }, 500),
  ]);
  await syncProfileSubCategoriesFromAppState(merchants);
  const userPhones = merchants.map((m) => m.phone).filter(Boolean);

  const allProducts = await selectMany(
    'merchant_products',
    [],
    { column: 'created_at', ascending: false },
    5000
  );
  const productStatsByPhone = new Map();
  for (const row of allProducts) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    let bucket = productStatsByPhone.get(phone);
    if (!bucket) {
      bucket = { total: 0, approved: 0, pending: 0 };
      productStatsByPhone.set(phone, bucket);
    }
    bucket.total += 1;
    if (isProductApproved(row)) bucket.approved += 1;
    else bucket.pending += 1;
  }

  function productStatsForMerchantPhone(phone) {
    for (const variant of getPhoneVariants(phone)) {
      const bucket = productStatsByPhone.get(variant);
      if (bucket) return bucket;
    }
    return { total: 0, approved: 0, pending: 0 };
  }

  const users = userPhones.length > 0
    ? await selectMany('app_users', [{ method: 'in', column: 'phone', value: userPhones }])
    : [];

  const userByPhone = {};
  for (const u of users) {
    userByPhone[u.phone] = u;
  }

  const needsStateEnrichment = merchants.filter((m) => {
    if (!m.phone) return false;
    const primary = String(m.primary_service_id || '').trim();
    const sub = resolveMerchantServiceSubCategory(m);
    return !primary || !sub;
  });
  const enrichPhones = [
    ...new Set(needsStateEnrichment.map((m) => m.phone).filter(Boolean)),
  ];
  const stateByPhone = {};
  if (enrichPhones.length > 0) {
    const stateRows = await selectMany(
      'app_state',
      [{ method: 'in', column: 'phone', value: enrichPhones }],
      { column: 'updated_at', ascending: false },
      enrichPhones.length,
    );
    for (const row of stateRows) {
      const phone = String(row.phone || '').trim();
      if (!phone) continue;
      stateByPhone[phone] = normalizeObject(row.state);
    }
  }

  const orderStatsByMerchant = new Map();
  for (const row of orders) {
    const meta = readOrderMeta(row);
    const merchantPhone = meta.merchantPhone;
    if (!merchantPhone) continue;

    let bucket = null;
    for (const variant of getPhoneVariants(merchantPhone)) {
      bucket = orderStatsByMerchant.get(variant);
      if (bucket) break;
    }

    if (!bucket) {
      bucket = {
        totalOrders: 0,
        completedOrders: 0,
        pendingOrders: 0,
        deliveringOrders: 0,
        totalRevenue: 0,
        lastOrderAt: null,
      };
      for (const variant of getPhoneVariants(merchantPhone)) {
        orderStatsByMerchant.set(variant, bucket);
      }
    }

    const price = Number(meta.payload.price || 0);
    bucket.totalOrders += 1;
    if (!bucket.lastOrderAt || String(row.updated_at || '') > String(bucket.lastOrderAt || '')) {
      bucket.lastOrderAt = row.updated_at || null;
    }

    if (meta.statusKey === 'completed') {
      bucket.completedOrders += 1;
      bucket.totalRevenue += price;
    } else if (
      meta.statusKey === 'delivering' ||
      ['accepted', 'picked_up', 'on_way', 'waiting'].includes(meta.deliveryStatusKey)
    ) {
      bucket.deliveringOrders += 1;
    } else {
      bucket.pendingOrders += 1;
    }
  }

  const result = [];
  for (const m of merchants) {
    if (!m.phone) continue;

    const stats = orderStatsByMerchant.get(m.phone) || {
      completedOrders: 0,
      deliveringOrders: 0,
      pendingOrders: 0,
      totalRevenue: 0,
      lastOrderAt: null,
    };

    const bazaarVisibility = evaluateBazaarCustomerVisibility(m, []);
    const productStats = productStatsForMerchantPhone(m.phone);
    const media = extractMerchantMedia(m);

    result.push(
      enrichMerchantSummaryFromState(
        {
          ...stats,
          totalProducts: productStats.total,
          availableProducts: productStats.approved,
          pendingProducts: productStats.pending,
          visibleToCustomers: bazaarVisibility.visibleToCustomers,
          visibleProductCount: bazaarVisibility.visibleProductCount,
          visibilityNotes: bazaarVisibility.visibilityNotes,
          phone: m.phone,
          storeName:
            merchantProfileDisplayName(m) ||
            String(m.store_name || '').trim() ||
            String(userByPhone[m.phone]?.full_name || '').trim() ||
            `تاجر ${String(m.phone || '').slice(-4)}`,
          isProfessional: isProfessionalMerchantProfile(m),
          description: (m.description || '').slice(0, 80),
          primaryServiceId: m.primary_service_id || '',
          serviceSubCategory: resolveMerchantServiceSubCategory(m),
          specialty: resolveMerchantSpecialty(m, stateByPhone[m.phone]),
          serviceIds: profileServiceIds(m),
          isOpen: m.is_open !== false,
          isFrozen: isMerchantFrozen(m),
          rating: Number(m.rating || 0),
          isBazaarMember: m.is_bazaar_member === true,
          createdAt: m.created_at,
          fullName: userByPhone[m.phone]?.full_name || '',
          role: userByPhone[m.phone]?.role || '',
          profileImageUrl: media.profileImageUrl,
          logoImageUrl: media.logoImageUrl,
          coverImageUrl: media.coverImageUrl,
          clinicImageUrl: media.clinicImageUrl,
          avatarImageUrl: media.avatarImageUrl,
          ...mapMerchantApprovalFields(m),
        },
        stateByPhone[m.phone],
      ),
    );
  }

  return result.sort((a, b) => {
    const rank = (item) => {
      if (item.approvalStatus === 'pending') return 0;
      if (item.approvalStatus === 'rejected') return 1;
      return 2;
    };
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return String(a.storeName || '').localeCompare(String(b.storeName || ''), 'ar');
  });
}

async function getAllCouriers(adminPhone) {
  await assertAdminAccess(adminPhone);

  const courierRows = await selectMany('courier_profiles', [], { column: 'updated_at', ascending: false }, 2500);
  const tablePhones = new Set(
    (courierRows || []).map((r) => String(r?.phone || '').trim()).filter(Boolean)
  );

  // مندوبو التخزين القديم (app_state.state->courierProfile) الذين لم يُهاجروا بعد.
  // التطبيق يقرأهم عبر getCourierProfile (fallback إلى app_state)، فكانوا يظهرون
  // للمستخدم في التطبيق ولا يظهرون في لوحة الأدمن — أُصلح ذلك بإضافتهم هنا.
  let legacyCourierRows = [];
  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase
      .from('app_state')
      .select('phone, state, updated_at')
      .filter('state', 'cs', '{"courierProfile":{}}')
      .limit(500);
    if (!error) {
      legacyCourierRows = (data || []).filter(
        (row) =>
          !tablePhones.has(String(row?.phone || '').trim()) &&
          readCourierProfileFromState(row?.state)
      );
    }
  } catch (e) {
    console.warn('admin couriers legacy app_state read error:', e?.message || e);
  }

  const phones = [
    ...new Set([
      ...(courierRows || []).map((r) => String(r?.phone || '').trim()).filter(Boolean),
      ...legacyCourierRows.map((r) => String(r?.phone || '').trim()).filter(Boolean),
    ]),
  ];
  const users = phones.length > 0 ? await selectMany('app_users', [{ method: 'in', column: 'phone', value: phones }]) : [];

  const courierProfileByPhone = {};
  for (const row of courierRows) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    courierProfileByPhone[phone] = rowToCourierProfileMap(row);
  }
  for (const row of legacyCourierRows) {
    const phone = String(row.phone || '').trim();
    if (!phone || courierProfileByPhone[phone]) continue;
    const profile = readCourierProfileFromState(row.state);
    if (profile) courierProfileByPhone[phone] = { ...profile, phone };
  }

  const userByPhone = {};
  for (const user of users) {
    const phone = String(user.phone || '').trim();
    if (!phone) continue;
    userByPhone[phone] = user;
  }

  const couriers = [];
  const seen = new Set();

  for (const [phone, dbProfile] of Object.entries(courierProfileByPhone)) {
    if (seen.has(phone)) continue;
    if (!dbProfile) continue;

    const user = userByPhone[phone] || null;
    seen.add(phone);
    couriers.push(mapCourierForAdmin(phone, user, dbProfile));
  }

  const liveByKey = await readCourierLiveLocations(couriers.map((item) => item.phone));
  const withLive = applyLiveLocations(couriers, liveByKey);

  return withLive.sort((a, b) => {
    const rank = (item) => {
      if (item.approvalStatus === 'pending') return 0;
      if (item.approvalStatus === 'rejected') return 1;
      return 2;
    };
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;

    const aName = String(a.name || '').trim().toLowerCase();
    const bName = String(b.name || '').trim().toLowerCase();
    return aName.localeCompare(bName);
  });
}

async function getAllDrivers(adminPhone) {
  await assertAdminAccess(adminPhone);

  const driverRows = await selectMany('driver_profiles', [], { column: 'updated_at', ascending: false }, 2000);

  const phones = driverRows.map(r => r.phone).filter(Boolean);
  const users = phones.length > 0 ? await selectMany('app_users', [{ method: 'in', column: 'phone', value: phones }]) : [];

  const driverProfileByPhone = {};
  for (const row of driverRows) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    driverProfileByPhone[phone] = rowToDriverProfileMap(row);
  }

  const userByPhone = {};
  for (const user of users) {
    const phone = String(user.phone || '').trim();
    if (!phone) continue;
    userByPhone[phone] = user;
  }

  const drivers = [];
  const seen = new Set();
  for (const [phone, dbProfile] of Object.entries(driverProfileByPhone)) {
    if (seen.has(phone)) continue;
    if (!dbProfile) continue;

    const user = userByPhone[phone] || null;
    const name = String(dbProfile.name ?? '').trim();
    const role = String(user?.role ?? '').trim();
    const accountType = String(user?.account_type ?? '').trim();
    
    // Accept if it's explicitly a driver account or has a non-empty name
    const isDriverAccount = role === 'driver' || accountType === 'driver' || name.length > 0;
    if (!isDriverAccount) continue;

    seen.add(phone);
    drivers.push(mapDriverForAdmin(phone, user, dbProfile));
  }

  const liveByKey = await readCourierLiveLocations(drivers.map((item) => item.phone));
  return applyLiveLocations(drivers, liveByKey);
}

function mapAdminProductRow(product) {
  const row = product || {};
  const galleryRaw = row.gallery_images_base64 ?? row.galleryImagesBase64;
  const galleryImagesBase64 = Array.isArray(galleryRaw)
    ? galleryRaw.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  return {
    id: String(row.id || ''),
    name: String(row.name || row.name_ar || row.nameAr || row.title_ar || '').trim(),
    nameAr: String(row.name_ar || row.nameAr || '').trim(),
    category: String(row.category || '').trim(),
    subCategory: String(row.sub_category || row.subCategory || '').trim(),
    sectionId: String(row.section_id || row.sectionId || '').trim(),
    descriptionAr: String(row.description_ar || row.descriptionAr || '').trim(),
    price: Number(row.price || 0),
    isAvailable: row.is_available !== false,
    image: String(row.image || row.image_url || '').trim(),
    imageUrl: String(row.image_url || row.image || '').trim(),
    galleryImagesBase64,
    createdAt: row.created_at || null,
    isApproved: row.is_approved !== false,
  };
}

async function getAdminMerchantDetails(adminPhone, merchantPhone, options = {}) {
  await assertAdminAccess(adminPhone);

  const profile = await getMerchantProfile(merchantPhone);
  if (!profile) {
    throw new Error('Merchant not found.');
  }

  const skipProducts = options.skipProducts === true;
  const skipOrders = options.skipOrders === true;

  const [orders, products, appUser, merchantState] = await Promise.all([
    skipOrders ? Promise.resolve([]) : getMerchantIncomingOrders(profile.phone),
    skipProducts
      ? Promise.resolve([])
      : getMerchantProducts(profile.phone).catch((error) => {
          console.warn(
            'getAdminMerchantDetails products skipped:',
            error?.message || error,
          );
          return [];
        }),
    getAppUser(profile.phone),
    getUserState(profile.phone).catch(() => null),
  ]);
  const storeInfo = normalizeObject(merchantState?.merchantStore || {});
  const profInfo = normalizeObject(storeInfo.professionalInfo || storeInfo.professional_info || {});

  let totalRevenue = 0;
  let completedOrders = 0;
  let pendingOrders = 0;
  let deliveringOrders = 0;
  let cancelledOrders = 0;
  let codCollected = 0;

  const mappedOrders = orders.map((row) => {
    const meta = readOrderMeta(row);
    const price = Number(meta.payload.price || 0);

    if (meta.statusKey === 'completed') {
      completedOrders += 1;
      totalRevenue += price;
      if (meta.payload.codConfirmed) {
        codCollected += price;
      }
    } else if (
      meta.statusKey === 'delivering' ||
      ['accepted', 'picked_up', 'on_way', 'waiting'].includes(meta.deliveryStatusKey)
    ) {
      deliveringOrders += 1;
    } else if (
      meta.statusKey === 'cancelled' ||
      meta.statusKey === 'rejected' ||
      meta.statusKey === 'failed'
    ) {
      cancelledOrders += 1;
    } else {
      pendingOrders += 1;
    }

    const cancel = resolveOrderCancelActor(meta.payload, meta.statusKey);

    return {
      id: meta.id,
      orderNumber: meta.payload.orderNumber || meta.id,
      statusKey: meta.statusKey,
      statusAr: cancel.displayStatusAr || meta.payload.statusAr || '',
      statusEn: meta.payload.statusEn || '',
      cancelledBy: cancel.cancelledBy,
      cancelledByAr: cancel.cancelledByAr,
      noteAr: meta.payload.noteAr || '',
      deliveryStatusKey: meta.deliveryStatusKey,
      deliveryStatusAr: meta.payload.deliveryStatusAr || '',
      deliveryStatusEn: meta.payload.deliveryStatusEn || '',
      price,
      customerName: meta.payload.customerNameAr || meta.payload.customerNameEn || '',
      customerPhone: meta.customerPhone,
      itemCount: Array.isArray(meta.payload.items)
        ? meta.payload.items.length
        : Number(meta.payload.itemsCount || 0),
      updatedAt: row.updated_at || row.created_at || null,
      createdAt: row.created_at || null,
    };
  });

  const totalOrders = orders.length;
  const averageOrderValue = completedOrders > 0 ? Math.round(totalRevenue / completedOrders) : 0;
  const media = extractMerchantMedia(profile);
  const productSections = merchantProfileSections(profile)
    .map((section) => ({
      id: String(section?.id ?? '').trim(),
      nameAr: String(section?.name_ar ?? section?.nameAr ?? '').trim(),
      sortOrder: Number(section?.sort_order ?? section?.sortOrder ?? 0) || 0,
    }))
    .filter((section) => section.id && section.nameAr);

  return {
    merchant: {
      phone: profile.phone,
      storeName: profile.store_name || '',
      description: profile.description || '',
      primaryServiceId: profile.primary_service_id || '',
      serviceIds: profileServiceIds(profile),
      serviceSubCategory: resolveMerchantServiceSubCategory(profile),
      isOpen: profile.is_open !== false,
      isFrozen: isMerchantFrozen(profile),
      isApproved: isMerchantApproved(profile),
      approvalStatus: merchantApprovalStatus(profile),
      isBazaarMember: profile.is_bazaar_member === true,
      rating: Number(profile.rating || 0),
      address: profile.address || '',
      deliveryFee: Number(profile.delivery_fee || 0),
      createdAt: profile.created_at || null,
      updatedAt: profile.updated_at || null,
      fullName: appUser?.full_name || '',
      role: appUser?.role || '',
      profileImageUrl: media.profileImageUrl,
      logoImageUrl: media.logoImageUrl,
      coverImageUrl: media.coverImageUrl,
      clinicImageUrl: media.clinicImageUrl,
      avatarImageUrl: media.avatarImageUrl,
      workSampleUrls: media.workSamples,
      productSections,
      // حقول الأطباء والعيادات (من merchantStore.professionalInfo بشكل أساسي)
      specialty: profInfo.specialty || profile.professional_info?.specialty || storeInfo.specialty || null,
      specialties: profInfo.specialties || storeInfo.specialties || profile.professional_info?.specialties || null,
      workingDays: profInfo.workingDays || storeInfo.workingDays || profile.professional_info?.workingDays || null,
      doctorPhone: profInfo.doctorPhone || storeInfo.doctorPhone || profile.professional_info?.doctorPhone || null,
      clinicPhone: profInfo.clinicPhone || storeInfo.clinicPhone || profile.professional_info?.clinicPhone || null,
      openTime: profInfo.openTime || storeInfo.openTime || profile.professional_info?.openTime || profile.open_time || null,
      closeTime: profInfo.closeTime || storeInfo.closeTime || profile.professional_info?.closeTime || profile.close_time || null,
      morningOpenTime:
        profInfo.morningOpenTime ||
        profInfo.morning_open_time ||
        storeInfo.morningOpenTime ||
        profile.professional_info?.morningOpenTime ||
        profile.professional_info?.morning_open_time ||
        null,
      morningCloseTime:
        profInfo.morningCloseTime ||
        profInfo.morning_close_time ||
        storeInfo.morningCloseTime ||
        profile.professional_info?.morningCloseTime ||
        profile.professional_info?.morning_close_time ||
        null,
      eveningOpenTime:
        profInfo.eveningOpenTime ||
        profInfo.evening_open_time ||
        storeInfo.eveningOpenTime ||
        profile.professional_info?.eveningOpenTime ||
        profile.professional_info?.evening_open_time ||
        null,
      eveningCloseTime:
        profInfo.eveningCloseTime ||
        profInfo.evening_close_time ||
        storeInfo.eveningCloseTime ||
        profile.professional_info?.eveningCloseTime ||
        profile.professional_info?.evening_close_time ||
        null,
    },
    stats: {
      totalOrders,
      completedOrders,
      pendingOrders,
      deliveringOrders,
      cancelledOrders,
      totalRevenue,
      codCollected,
      averageOrderValue,
      totalProducts: products.length,
    },
    recentOrders: mappedOrders.slice(0, 20),
    products: products.map(mapAdminProductRow),
  };
}

function mapProfessionalCategoryLabel(categoryId) {
  return labelForCategoryId(categoryId, _professionalCategoriesCache.items);
}

let _professionalCategoriesCache = {
  items: mergeProfessionalCategories([]),
  updatedAt: null,
};

async function getProfessionalCategoriesConfig() {
  const state = await getPlatformSettingsState();
  const stored = normalizeObject(
    state.professionalCategories || state.professional_categories || {},
  );
  const storedItems = Array.isArray(stored.items) ? stored.items : [];
  const items = mergeProfessionalCategories(storedItems);
  const updatedAt =
    stored.updatedAt ||
    stored.updated_at ||
    state.professionalCategoriesUpdatedAt ||
    null;
  _professionalCategoriesCache = { items, updatedAt };
  const { ids, names } = buildCategoryMaps(items);
  return {
    items,
    updatedAt,
    ids: [...ids],
    names,
  };
}

async function saveAdminProfessionalCategoriesConfig(phone, items) {
  await assertAdminAccess(phone);
  const normalized = normalizeAdminCategoriesPayload(items);
  const updatedAt = nowIso();
  await savePlatformSettingsState({
    professionalCategories: {
      items: normalized,
      updatedAt,
    },
    professionalCategoriesUpdatedAt: updatedAt,
  });
  _professionalCategoriesCache = {
    items: mergeProfessionalCategories(normalized),
    updatedAt,
  };
  try {
    const { invalidateCache } = require('../lib/response_cache');
    if (typeof invalidateCache === 'function') {
      invalidateCache('app:professional-categories');
    }
  } catch (_) {}
  return { items: _professionalCategoriesCache.items, updatedAt };
}

async function resolveProfessionalCategory(professionId) {
  const config = await getProfessionalCategoriesConfig();
  const id = String(professionId || '').trim();
  const match = config.items.find((item) => item.id === id && item.enabled);
  if (!match) return null;
  return {
    id: match.id,
    labelAr: match.labelAr,
    labelEn: match.labelEn || match.labelAr,
  };
}

function extractMerchantMedia(profile) {
  const info = normalizeObject(profile?.professional_info);
  const profileImageUrl = String(
    info.profileImageUrl ||
      info.profileImageBase64 ||
      profile?.profile_image_url ||
      profile?.profile_image_base64 ||
      profile?.logo_image_url ||
      '',
  ).trim();
  const logoImageUrl = String(
    profile?.logo_image_url || info.profileImageUrl || profileImageUrl || '',
  ).trim();
  const coverImageUrl = String(
    profile?.cover_image_url || info.coverImageUrl || info.coverImageBase64 || '',
  ).trim();
  const clinicImageUrl = String(
    info.clinicImageUrl || info.clinicImageBase64 || coverImageUrl || '',
  ).trim();
  const workSamples = normalizeArray(
    profile?.work_sample_images_base64 ??
      info.workSampleImagesBase64 ??
      info.work_sample_images_base64,
  )
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const avatarImageUrl = profileImageUrl || logoImageUrl || coverImageUrl || clinicImageUrl;
  return {
    profileImageUrl,
    logoImageUrl,
    coverImageUrl,
    clinicImageUrl,
    avatarImageUrl,
    workSamples,
  };
}

function extractProfessionalMedia(profile) {
  const { profileImageUrl, workSamples } = extractMerchantMedia(profile || {});
  return { profileImage: profileImageUrl, workSamples };
}

function isAdminProfessionalSummary(merchantSummary, profile) {
  if (!merchantSummary && !profile) return false;
  if (merchantSummary?.isProfessional) return true;
  if (merchantSummary?.primaryServiceId === 'professionals') return true;
  if (profile && isProfessionalMerchantProfile(profile)) return true;
  const serviceIds = merchantSummary?.serviceIds || profileServiceIds(profile || {});
  return serviceIds.includes('professionals');
}

async function getAllProfessionals(adminPhone) {
  await assertAdminAccess(adminPhone);

  const { isCustomerProfessionalServiceRow } = require('./customer_professionals');

  const [merchants, profiles, serviceProfiles] = await Promise.all([
    getAllMerchants(adminPhone),
    selectMany('merchant_profiles', [], { column: 'updated_at', ascending: false }),
    selectMany(
      'merchant_service_profiles',
      [{ method: 'eq', column: 'service_id', value: 'professionals' }],
      { column: 'updated_at', ascending: false },
      2000,
    ),
  ]);

  const profileByPhone = {};
  for (const profile of profiles) {
    const phone = String(profile.phone || '').trim();
    if (!phone) continue;
    for (const variant of getPhoneVariants(phone)) {
      profileByPhone[variant] = profile;
    }
  }

  const seen = new Set();
  const result = [];

  const pushProfessional = (entry) => {
    const phone = String(entry.phone || '').trim();
    const categoryId = String(entry.professionalCategoryId || '').trim();
    const dedupeKey = categoryId ? `${phone}::${categoryId}` : phone;
    if (!phone || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    result.push(entry);
  };

  for (const merchant of merchants) {
    const phone = String(merchant.phone || '').trim();
    if (!phone) continue;

    const profile = profileByPhone[phone] || null;
    if (!isAdminProfessionalSummary(merchant, profile)) continue;

    const categoryId = String(
      profile?.professional_category_id ||
        normalizeObject(profile?.professional_info)?.professionId ||
        '',
    ).trim();
    const { profileImage, workSamples } = extractProfessionalMedia(profile || {});

    pushProfessional({
      ...merchant,
      professionalCategoryId: categoryId,
      professionalCategoryLabel: mapProfessionalCategoryLabel(categoryId),
      profileImageUrl: profileImage,
      workSampleCount: workSamples.length,
    });
  }

  for (const serviceProfile of serviceProfiles) {
    if (!isCustomerProfessionalServiceRow(serviceProfile)) continue;
    const phone = String(serviceProfile.phone || '').trim();
    const categoryId = String(
      serviceProfile.professional_category_id ||
        serviceProfile.service_sub_category ||
        normalizeObject(serviceProfile.professional_info)?.professionId ||
        '',
    ).trim();
    if (!phone || !categoryId) continue;

    const shell = profileByPhone[phone] || {};
    const info = normalizeObject(serviceProfile.professional_info);
    const { profileImage, workSamples } = extractProfessionalMedia({
      ...serviceProfile,
      professional_info: info,
    });

    pushProfessional({
      phone,
      storeName: String(serviceProfile.store_name || info.name || '').trim(),
      fullName: String(info.name || serviceProfile.store_name || '').trim(),
      approvalStatus:
        serviceProfile.approval_status ||
        (serviceProfile.is_approved ? 'approved' : 'pending'),
      isApproved: serviceProfile.is_approved === true,
      isProfessional: true,
      isFrozen: shell.is_frozen === true || shell.isFrozen === true,
      professionalCategoryId: categoryId,
      professionalCategoryLabel: mapProfessionalCategoryLabel(categoryId),
      profileImageUrl: profileImage,
      workSampleCount: workSamples.length,
    });
  }

  return result.sort((a, b) => {
    const rank = (item) => {
      if (item.approvalStatus === 'pending') return 0;
      if (item.approvalStatus === 'rejected') return 1;
      return 2;
    };
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return String(a.storeName || '').localeCompare(String(b.storeName || ''), 'ar');
  });
}

async function getAdminProfessionalDetails(adminPhone, professionalPhone, options = {}) {
  const base = await getAdminMerchantDetails(adminPhone, professionalPhone, {
    skipProducts: true,
    skipOrders: true,
  });

  const professionId = String(
    options.professionId ??
      options.professionalCategoryId ??
      options.professional_category_id ??
      '',
  ).trim();

  const { PROFESSIONALS_SERVICE_ID } = require('./customer_professionals');
  const { getMerchantServiceProfile } = require('./merchant_service_profiles');
  let profile = await getMerchantProfile(professionalPhone);
  let serviceProfile = null;
  if (professionId) {
    serviceProfile = await getMerchantServiceProfile(
      professionalPhone,
      PROFESSIONALS_SERVICE_ID,
      professionId,
    );
  }

  if (serviceProfile) {
    const info = normalizeObject(serviceProfile.professional_info);
    const categoryId = String(
      serviceProfile.professional_category_id ||
        serviceProfile.service_sub_category ||
        info.professionId ||
        '',
    ).trim();
    const { profileImage, workSamples } = extractProfessionalMedia({
      ...serviceProfile,
      professional_info: info,
    });
    const visibility = resolveMerchantContactVisibility(profile || {});

    return {
      ...base,
      approvalStatus:
        serviceProfile.approval_status ||
        (serviceProfile.is_approved ? 'approved' : 'pending'),
      isApproved: serviceProfile.is_approved === true,
      professional: {
        categoryId,
        categoryLabel: mapProfessionalCategoryLabel(categoryId),
        profileImageUrl: profileImage,
        workSampleUrls: workSamples,
        description: String(serviceProfile.description || info.description || '').trim(),
        contactPhone: String(info.phone || serviceProfile.phone || '').trim(),
        whatsapp: String(info.whatsapp || info.phone || serviceProfile.phone || '').trim(),
        openTime: String(serviceProfile.open_time || info.openTime || '').trim(),
        closeTime: String(serviceProfile.close_time || info.closeTime || '').trim(),
        showPhoneToCustomers: visibility.showPhoneToCustomers,
        showWhatsAppToCustomers: visibility.showWhatsAppToCustomers,
        rejectionMessageAr: merchantRejectionMessage(serviceProfile),
        professionalInfo: info,
      },
    };
  }

  if (!profile) {
    throw new Error('Professional not found.');
  }

  const info = normalizeObject(profile.professional_info);
  const visibility = resolveMerchantContactVisibility(profile);
  const categoryId = String(profile.professional_category_id || info.professionId || '').trim();
  const { profileImage, workSamples } = extractProfessionalMedia(profile);

  return {
    ...base,
    professional: {
      categoryId,
      categoryLabel: mapProfessionalCategoryLabel(categoryId),
      profileImageUrl: profileImage,
      workSampleUrls: workSamples,
      description: String(profile.description || info.description || '').trim(),
      contactPhone: String(info.phone || profile.phone || '').trim(),
      whatsapp: String(profile.whatsapp || info.whatsapp || '').trim(),
      openTime: String(profile.open_time || info.openTime || '').trim(),
      closeTime: String(profile.close_time || info.closeTime || '').trim(),
      showPhoneToCustomers: visibility.showPhoneToCustomers,
      showWhatsAppToCustomers: visibility.showWhatsAppToCustomers,
      rejectionMessageAr: merchantRejectionMessage(profile),
      professionalInfo: info,
    },
  };
}

async function toggleBazaarMemberStatus(_adminPhone, _merchantPhone, _isBazaarMember) {
  // LEGACY — bazaar marketplace channel removed from Talab app.
  const err = new Error('قناة بازار طلب أُزيلت من التطبيق ولم تعد متاحة.');
  err.code = 'BAZAAR_REMOVED';
  err.statusCode = 410;
  throw err;
}

async function toggleCourierApprovalStatus(adminPhone, courierPhone, isApproved) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(courierPhone);

  // Try atomic RPC first
  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase.rpc('atomic_approve_courier', {
      p_phone: phoneKey,
      p_approved: Boolean(isApproved),
    });
    if (!error) {
      const user = await getAppUser(phoneKey);
      const profile = (await getCourierProfile(phoneKey)) || {};
      const mapped = mapCourierForAdmin(phoneKey, user, profile);

      if (Boolean(isApproved)) {
        try {
          const { onCourierApproved } = require('../push_events');
          await onCourierApproved(phoneKey);
        } catch (pushError) {
          console.error('push onCourierApproved error:', pushError?.message || pushError);
        }
      }

      return { success: true, courier: mapped };
    }
  } catch (_) {
    // fallback
  }

  const profile = await getCourierProfile(phoneKey);
  if (!profile || !isCourierProfileComplete(profile)) {
    throw new Error('Courier profile not found.');
  }

  const nextProfile = {
    ...profile,
    isApproved: Boolean(isApproved),
    approvalStatus: Boolean(isApproved) ? 'approved' : 'pending',
  };
  if (Boolean(isApproved)) {
    delete nextProfile.rejectionReasonKey;
    delete nextProfile.rejectionMessageAr;
    delete nextProfile.rejectedAt;
  }
  await saveCourierProfile(phoneKey, nextProfile);

  const user = await getAppUser(phoneKey);
  const mapped = mapCourierForAdmin(phoneKey, user, nextProfile);

  if (Boolean(isApproved)) {
    try {
      const { onCourierApproved } = require('../push_events');
      await onCourierApproved(phoneKey);
    } catch (pushError) {
      console.error('push onCourierApproved error:', pushError?.message || pushError);
    }
  }

  return { success: true, courier: mapped };
}

function resolveRejectionMessage(reasonKey, rejectionMessageAr, catalog = {}) {
  const custom = String(rejectionMessageAr || '').trim();
  if (custom) {
    return {
      message: custom,
      key: String(reasonKey || 'custom').trim() || 'custom',
    };
  }
  const normalizedReason = String(reasonKey || '').trim();
  const message = catalog[normalizedReason];
  if (!message) return null;
  return { message, key: normalizedReason };
}

async function rejectCourierApplication(
  adminPhone,
  courierPhone,
  reasonKey = '',
  rejectionMessageAr = ''
) {
  await assertAdminAccess(adminPhone);

  const resolved = resolveRejectionMessage(
    reasonKey,
    rejectionMessageAr,
    COURIER_REJECTION_REASONS
  );
  if (!resolved) {
    throw new Error('Rejection reason is required.');
  }
  const { message, key: normalizedReason } = resolved;

  const phoneKey = await resolvePhoneKey(courierPhone);

  // Try atomic RPC first
  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase.rpc('atomic_reject_courier', {
      p_phone: phoneKey,
      p_reason_key: normalizedReason,
      p_message_ar: message,
    });
    if (!error) {
      const user = await getAppUser(phoneKey);
      const profile = (await getCourierProfile(phoneKey)) || {};
      const mapped = mapCourierForAdmin(phoneKey, user, profile);

      try {
        const { onCourierRejected } = require('../push_events');
        await onCourierRejected(phoneKey, message, normalizedReason);
      } catch (pushError) {
        console.error('push onCourierRejected error:', pushError?.message || pushError);
      }

      return { success: true, courier: mapped };
    }
  } catch (_) {
    // fallback
  }

  const profile = await getCourierProfile(phoneKey);
  if (!profile || !isCourierProfileComplete(profile)) {
    throw new Error('Courier profile not found.');
  }

  const nextProfile = {
    ...profile,
    isApproved: false,
    approvalStatus: 'rejected',
    rejectionReasonKey: normalizedReason,
    rejectionMessageAr: message,
    rejectedAt: nowIso(),
  };
  await saveCourierProfile(phoneKey, nextProfile);

  const user = await getAppUser(phoneKey);
  const mapped = mapCourierForAdmin(phoneKey, user, nextProfile);

  try {
    const { onCourierRejected } = require('../push_events');
    await onCourierRejected(phoneKey, message, normalizedReason);
  } catch (pushError) {
    console.error('push onCourierRejected error:', pushError?.message || pushError);
  }

  return { success: true, courier: mapped };
}

async function toggleMerchantApprovalStatus(adminPhone, merchantPhone, isApproved, options = {}) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(merchantPhone);
  await ensureMerchantProfileRecord(phoneKey);

  const professionId = String(
    options.professionId ??
      options.professionalCategoryId ??
      options.professional_category_id ??
      '',
  ).trim();

  const patch = {
    isApproved: Boolean(isApproved),
    approvalStatus: Boolean(isApproved) ? 'approved' : 'pending',
    rejectionReasonKey: null,
    rejectionMessageAr: null,
    rejectedAt: null,
  };

  try {
    const {
      isCustomerProfessionalServiceRow,
      PROFESSIONALS_SERVICE_ID,
    } = require('./customer_professionals');
    const { saveMerchantServiceProfile, listMerchantServiceProfiles } = require('./merchant_service_profiles');
    const servicePatch = {
      is_approved: Boolean(isApproved),
      approval_status: Boolean(isApproved) ? 'approved' : 'pending',
    };

    if (professionId) {
      await saveMerchantServiceProfile(
        phoneKey,
        PROFESSIONALS_SERVICE_ID,
        servicePatch,
        professionId,
      );
    } else {
      const rows = await listMerchantServiceProfiles(phoneKey);
      const professionalRows = rows.filter(isCustomerProfessionalServiceRow);
      if (professionalRows.length > 0) {
        for (const row of professionalRows) {
          const categoryId = String(row.service_sub_category || row.professional_category_id || '').trim();
          if (!categoryId) continue;
          await saveMerchantServiceProfile(
            phoneKey,
            PROFESSIONALS_SERVICE_ID,
            servicePatch,
            categoryId,
          );
        }
      }
    }
  } catch (serviceError) {
    console.error('sync professional service approval error:', serviceError?.message || serviceError);
  }

  await updateMerchantApprovalRecord(phoneKey, patch);

  if (Boolean(isApproved)) {
    try {
      const { onMerchantApproved } = require('../push_events');
      await onMerchantApproved(phoneKey);
    } catch (error) {
      console.error('push onMerchantApproved error:', error?.message || error);
    }
  }

  const refreshed = await getMerchantProfile(phoneKey);
  return {
    success: true,
    merchant: {
      phone: phoneKey,
      storeName: refreshed?.store_name || '',
      ...mapMerchantApprovalFields(refreshed || {}),
    },
  };
}

async function rejectMerchantApplication(
  adminPhone,
  merchantPhone,
  reasonKey = '',
  rejectionMessageAr = ''
) {
  await assertAdminAccess(adminPhone);

  const resolved = resolveRejectionMessage(
    reasonKey,
    rejectionMessageAr,
    MERCHANT_REJECTION_REASONS
  );
  if (!resolved) {
    throw new Error('Rejection reason is required.');
  }
  const { message, key: normalizedReason } = resolved;

  const phoneKey = await resolvePhoneKey(merchantPhone);
  await ensureMerchantProfileRecord(phoneKey);

  await updateMerchantApprovalRecord(phoneKey, {
    isApproved: false,
    approvalStatus: 'rejected',
    rejectionReasonKey: normalizedReason,
    rejectionMessageAr: message,
    rejectedAt: nowIso(),
  });

  try {
    const { onMerchantRejected } = require('../push_events');
    await onMerchantRejected(phoneKey, message, normalizedReason);
  } catch (error) {
    console.error('push onMerchantRejected error:', error?.message || error);
  }

  const refreshed = await getMerchantProfile(phoneKey);
  return {
    success: true,
    merchant: {
      phone: phoneKey,
      storeName: refreshed?.store_name || '',
      ...mapMerchantApprovalFields(refreshed || {}),
    },
  };
}

async function toggleMerchantFreezeStatus(adminPhone, merchantPhone, isFrozen) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();

  // Try atomic RPC first
  try {
    const { data, error } = await supabase.rpc('atomic_toggle_frozen', {
      p_phone: phoneKey,
      p_is_frozen: Boolean(isFrozen),
    });
    if (!error) {
      try {
        const { onMerchantFrozen } = require('../push_events');
        await onMerchantFrozen(merchantPhone, Boolean(isFrozen));
      } catch (pushError) {
        console.error('push onMerchantFrozen error:', pushError?.message || pushError);
      }
      return { success: true, merchant: { phone: phoneKey, is_frozen: Boolean(isFrozen) } };
    }
  } catch (_) {
    // fallback
  }

  const variants = getPhoneVariants(merchantPhone);

  const { data, error } = await supabase
    .from('merchant_profiles')
    .update({ is_frozen: Boolean(isFrozen), updated_at: nowIso() })
    .in('phone', variants)
    .select();

  if (error) throw new Error(error.message);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Merchant not found.');
  }

  try {
    const { onMerchantFrozen } = require('../push_events');
    await onMerchantFrozen(merchantPhone, Boolean(isFrozen));
  } catch (pushError) {
    console.error('push onMerchantFrozen error:', pushError?.message || pushError);
  }

  return { success: true, merchant: data[0] };
}

async function updateAccountRole(adminPhone, targetPhone, newRole) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(targetPhone);
  if (!phoneKey) {
    throw new Error('Account phone is required.');
  }

  const existing = await getAppUser(phoneKey);
  if (!existing) {
    throw new Error('Account not found.');
  }

  const normalizedRole = String(newRole || '').trim().toLowerCase();
  const validRoles = ['customer', 'merchant', 'delivery', 'driver', 'admin', 'salary_outlet'];
  if (!validRoles.includes(normalizedRole)) {
    throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
  }

  const supabase = assertSupabaseAdmin();

  // Try atomic RPC first
  try {
    const { data, error } = await supabase.rpc('atomic_update_account_role', {
      p_phone: phoneKey,
      p_role: normalizedRole,
    });
    if (!error) {
      return { success: true, phone: phoneKey, role: normalizedRole };
    }
  } catch (_) {
    // fallback
  }

  const { error } = await supabase
    .from('app_users')
    .update({
      role: normalizedRole,
      account_type: normalizedRole,
      updated_at: nowIso(),
    })
    .eq('phone', phoneKey);

  if (error) throw new Error(error.message);

  const state = (await getUserState(phoneKey)) || {};
  await saveUserState(phoneKey, {
    ...state,
    userRole: normalizedRole,
    user_role: normalizedRole,
  });

  return { success: true, phone: phoneKey, role: normalizedRole };
}

async function isProtectedAdminAccount(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const adminPhones = await getConfiguredAdminPhones();
  if (variants.some((item) => adminPhones.has(item))) {
    return true;
  }
  const user = await getAppUser(phoneKey);
  if (String(user?.role ?? '').trim() === 'admin') {
    return true;
  }
  const state = await getUserState(phoneKey);
  if (state?.adminAccess === true) {
    return true;
  }
  const role = String(state?.userRole ?? state?.user_role ?? '').trim();
  return role === 'admin';
}

async function toggleDriverApprovalStatus(adminPhone, driverPhone, isApproved) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(driverPhone);
  const { invalidateDriverProfileCache } = require('./operator_profiles');
  invalidateDriverProfileCache(phoneKey);

  // Try atomic RPC first — بعض الإصدارات القديمة من الدالة تعطي
  // null user_id؛ عند الفشل ننتقل للتحديث المباشر.
  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase.rpc('atomic_approve_driver', {
      p_phone: phoneKey,
      p_approved: Boolean(isApproved),
    });
    if (!error) {
      const user = await getAppUser(phoneKey);
      const refreshedState = (await getUserState(phoneKey)) || {};
      const operatorProfiles = await loadOperatorProfiles(phoneKey);
      const mapped = mapAdminAccountSummary(
        user,
        refreshedState,
        null,
        operatorProfiles
      );

      if (Boolean(isApproved)) {
        try {
          const { onDriverApproved } = require('../push_events');
          await onDriverApproved(phoneKey);
        } catch (pushError) {
          console.error('push onDriverApproved error:', pushError?.message || pushError);
        }
      }

      return { success: true, driver: mapped };
    }
  } catch (_) {
    // fallback
  }

  const profile = await getDriverProfile(phoneKey);
  if (!profile || !isDriverProfileComplete(profile)) {
    throw new Error('Driver profile not found.');
  }

  const nextProfile = {
    ...profile,
    isApproved: Boolean(isApproved),
    approvalStatus: Boolean(isApproved) ? 'approved' : 'pending',
  };
  if (Boolean(isApproved)) {
    delete nextProfile.rejectionReasonKey;
    delete nextProfile.rejectionMessageAr;
    delete nextProfile.rejectedAt;
  }
  await saveDriverProfile(phoneKey, nextProfile);

  // تحديث مباشر لجدول driver_profiles (يغطي فشل الـ RPC القديم).
  try {
    const supabase = assertSupabaseAdmin();
    const row = await supabase
      .from('driver_profiles')
      .select('id, phone, user_id')
      .eq('phone', phoneKey)
      .limit(1)
      .maybeSingle();
    if (!row.error && row.data) {
      const appUserId = await getAppUserId(phoneKey);
      await supabase
        .from('driver_profiles')
        .update({
          approval_status: Boolean(isApproved) ? 'approved' : 'pending',
          is_approved: Boolean(isApproved),
          user_id: row.data.user_id || appUserId || null,
          updated_at: nowIso(),
        })
        .eq('phone', phoneKey);
    }
  } catch (directError) {
    console.error('direct driver_profiles update error:', directError?.message || directError);
  }

  const user = await getAppUser(phoneKey);
  const refreshedState = (await getUserState(phoneKey)) || {};
  const mapped = mapAdminAccountSummary(user, refreshedState, null, {
    driverProfile: nextProfile,
  });

  if (Boolean(isApproved)) {
    try {
      const { onDriverApproved } = require('../push_events');
      await onDriverApproved(phoneKey);
    } catch (pushError) {
      console.error('push onDriverApproved error:', pushError?.message || pushError);
    }
  }

  return { success: true, driver: mapped };
}

async function rejectDriverApplication(
  adminPhone,
  driverPhone,
  reasonKey = '',
  rejectionMessageAr = ''
) {
  await assertAdminAccess(adminPhone);

  const resolved = resolveRejectionMessage(reasonKey, rejectionMessageAr, {});
  if (!resolved) {
    throw new Error('Rejection reason is required.');
  }
  const { message, key: normalizedReason } = resolved;

  const phoneKey = await resolvePhoneKey(driverPhone);
  const { invalidateDriverProfileCache } = require('./operator_profiles');
  invalidateDriverProfileCache(phoneKey);

  // Try atomic RPC first
  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase.rpc('atomic_reject_driver', {
      p_phone: phoneKey,
      p_reason_key: normalizedReason,
      p_message_ar: message,
    });
    if (!error) {
      const user = await getAppUser(phoneKey);
      const refreshedState = (await getUserState(phoneKey)) || {};
      const operatorProfiles = await loadOperatorProfiles(phoneKey);
      const mapped = mapAdminAccountSummary(
        user,
        refreshedState,
        null,
        operatorProfiles
      );

      try {
        const { onDriverRejected } = require('../push_events');
        await onDriverRejected(phoneKey, message, normalizedReason);
      } catch (pushError) {
        console.error('push onDriverRejected error:', pushError?.message || pushError);
      }

      return { success: true, driver: mapped };
    }
  } catch (_) {
    // fallback
  }

  const profile = await getDriverProfile(phoneKey);
  if (!profile || !isDriverProfileComplete(profile)) {
    throw new Error('Driver profile not found.');
  }

  const nextProfile = {
    ...profile,
    isApproved: false,
    approvalStatus: 'rejected',
    rejectionReasonKey: normalizedReason,
    rejectionMessageAr: message,
    rejectedAt: nowIso(),
  };
  await saveDriverProfile(phoneKey, nextProfile);

  const user = await getAppUser(phoneKey);
  const refreshedState = (await getUserState(phoneKey)) || {};
  const mapped = mapAdminAccountSummary(user, refreshedState, null, {
    driverProfile: nextProfile,
  });

  try {
    const { onDriverRejected } = require('../push_events');
    await onDriverRejected(phoneKey, message, normalizedReason);
  } catch (pushError) {
    console.error('push onDriverRejected error:', pushError?.message || pushError);
  }

  return { success: true, driver: mapped };
}

async function loadOperatorProfiles(phoneKey) {
  const [driverProfile, courierProfile] = await Promise.all([
    getDriverProfile(phoneKey),
    getCourierProfile(phoneKey),
  ]);
  return { driverProfile, courierProfile };
}

function resolveDriverProfile(state, operatorProfiles = {}) {
  return operatorProfiles.driverProfile ?? readDriverProfileFromState(state);
}

function resolveCourierProfile(state, operatorProfiles = {}) {
  return operatorProfiles.courierProfile ?? readCourierProfileFromState(state);
}

function classifyAdminAccountKind(user, state, merchantProfile, operatorProfiles = {}) {
  const role = String(user?.role ?? '').trim();
  const accountType = String(user?.account_type ?? '').trim();

  if (role === 'admin' || state?.adminAccess === true) {
    return 'admin';
  }

  const storeName = String(merchantProfile?.store_name ?? '').trim();
  const merchantStoreName = String(state?.merchantStore?.name ?? '').trim();
  const professionalInfo = normalizeObject(merchantProfile?.professional_info);
  const hasProfessionalProfile =
    Boolean(String(professionalInfo.name ?? '').trim()) ||
    Boolean(String(merchantProfile?.professional_category_id ?? '').trim()) ||
    isProfessionalMerchantProfile(merchantProfile);
  if (role === 'merchant' || storeName || merchantStoreName || hasProfessionalProfile) {
    return 'merchant';
  }

  const driverProfile = resolveDriverProfile(state, operatorProfiles);
  if (
    role === 'driver' ||
    accountType === 'driver' ||
    (driverProfile && Object.keys(driverProfile).length > 0)
  ) {
    return 'driver';
  }

  const courierProfile = resolveCourierProfile(state, operatorProfiles);
  if (
    role === 'delivery' ||
    accountType === 'delivery' ||
    isCourierProfileComplete(courierProfile)
  ) {
    return 'courier';
  }

  return 'customer';
}

function accountDisplayName(user, state, merchantProfile, kind, operatorProfiles = {}) {
  const fullName = String(user?.full_name ?? '').trim();
  const merchantName = String(merchantProfile?.store_name ?? '').trim();
  const merchantStoreName = String(state?.merchantStore?.name ?? '').trim();
  const courierName = String(
    resolveCourierProfile(state, operatorProfiles)?.name ?? ''
  ).trim();
  const driverName = String(
    resolveDriverProfile(state, operatorProfiles)?.name ?? ''
  ).trim();
  const professionalName = String(
    normalizeObject(merchantProfile?.professional_info)?.name ?? ''
  ).trim();

  if (kind === 'merchant') {
    return merchantName || merchantStoreName || professionalName || fullName || 'تاجر';
  }
  if (kind === 'courier') {
    return courierName || fullName || 'مندوب توصيل';
  }
  if (kind === 'driver') {
    return driverName || fullName || 'سائق تكسي';
  }
  if (kind === 'admin') {
    return fullName || 'مشرف';
  }
  return fullName || 'زبون';
}

function resolveAccountSuspended(state, merchantProfile, operatorProfiles = {}) {
  if (state?.accountSuspended === true) return true;
  if (isMerchantFrozen(merchantProfile)) return true;
  if (resolveCourierProfile(state, operatorProfiles)?.isSuspended === true) {
    return true;
  }
  if (resolveDriverProfile(state, operatorProfiles)?.isSuspended === true) {
    return true;
  }
  return false;
}

const DRIVER_DOCUMENT_KEYS = [
  'profileImage', 'vehicleImage', 'idFrontImage', 'idBackImage',
  'residenceCardImage', 'vehicleRegFrontImage', 'vehicleRegBackImage',
];

function extractDriverDocuments(profile) {
  if (!profile || typeof profile !== 'object') return undefined;
  const docs = {};
  let hasAny = false;
  for (const key of DRIVER_DOCUMENT_KEYS) {
    const url = String(profile[key] ?? '').trim();
    if (url) {
      docs[key] = url;
      hasAny = true;
    }
  }
  return hasAny ? docs : undefined;
}

function mapAdminAccountSummary(user, state, merchantProfile, operatorProfiles = {}) {
  const phone = String(user?.phone ?? '').trim();
  const kind = classifyAdminAccountKind(
    user,
    state,
    merchantProfile,
    operatorProfiles
  );
  const courierProfile = resolveCourierProfile(state, operatorProfiles);
  const driverProfile = resolveDriverProfile(state, operatorProfiles);
  const approval = resolveAccountApproval(state, merchantProfile, kind, operatorProfiles);
  const hasDriverCredential = Boolean(
    driverProfile &&
      (isDriverProfileComplete(driverProfile) ||
        String(driverProfile.name ?? '').trim() ||
        driverProfile.adminPreRegistered === true)
  );

  return {
    phone,
    displayName: accountDisplayName(
      user,
      state,
      merchantProfile,
      kind,
      operatorProfiles
    ),
    fullName: String(user?.full_name ?? '').trim(),
    role: String(user?.role ?? '').trim(),
    accountType: String(user?.account_type ?? '').trim(),
    kind,
    isSuspended: resolveAccountSuspended(state, merchantProfile, operatorProfiles),
    merchantStoreName: String(merchantProfile?.store_name ?? '').trim(),
    primaryServiceId: String(merchantProfile?.primary_service_id ?? '').trim(),
    courierApproved: isCourierApproved(courierProfile),
    needsApproval: approval.needsApproval,
    approvalStatus: approval.approvalStatus,
    isApproved: approval.isApproved,
    rejectionMessageAr: approval.rejectionMessageAr,
    driverIsApproved: isDriverApproved(driverProfile),
    driverApprovalStatus: driverApprovalStatus(driverProfile),
    updatedAt: user?.updated_at ?? merchantProfile?.updated_at ?? null,
    createdAt: user?.created_at ?? merchantProfile?.created_at ?? null,
    hasMerchantProfile: Boolean(merchantProfile),
    hasCourierProfile: isCourierProfileComplete(courierProfile),
    hasDriverProfile: isDriverProfileComplete(driverProfile),
    hasDriverCredential,
    driverProfileComplete: isDriverProfileComplete(driverProfile),
    documents: kind === 'driver' || hasDriverCredential
      ? extractDriverDocuments(driverProfile)
      : undefined,
  };
}

function resolveAccountApproval(state, merchantProfile, kind, operatorProfiles = {}) {
  if (kind === 'customer' || kind === 'admin') {
    return {
      needsApproval: false,
      approvalStatus: null,
      isApproved: true,
      rejectionMessageAr: null,
    };
  }
  if (kind === 'merchant') {
    const profile = merchantProfile || {};
    return {
      needsApproval: true,
      approvalStatus: merchantApprovalStatus(profile),
      isApproved: isMerchantApproved(profile),
      rejectionMessageAr: merchantRejectionMessage(profile) || null,
    };
  }
  if (kind === 'courier') {
    const profile = resolveCourierProfile(state, operatorProfiles);
    return {
      needsApproval: true,
      approvalStatus: courierApprovalStatus(profile),
      isApproved: isCourierApproved(profile),
      rejectionMessageAr: courierRejectionMessage(profile) || null,
    };
  }
  if (kind === 'driver') {
    const profile = resolveDriverProfile(state, operatorProfiles);
    return {
      needsApproval: true,
      approvalStatus: driverApprovalStatus(profile),
      isApproved: isDriverApproved(profile),
      rejectionMessageAr: driverRejectionMessage(profile) || null,
    };
  }
  return {
    needsApproval: false,
    approvalStatus: null,
    isApproved: true,
    rejectionMessageAr: null,
  };
}

function resolveStateForAdminAccount(states, phone) {
  for (const row of states) {
    const rowPhone = String(row.phone || '').trim();
    if (!rowPhone) continue;
    for (const variant of getPhoneVariants(phone)) {
      if (getPhoneVariants(rowPhone).includes(variant)) {
        return row.state || {};
      }
    }
  }
  return {};
}

async function buildAllAdminAccountsSorted(adminPhone) {
  await assertAdminAccess(adminPhone);
  await syncMissingMerchantProfilesFromAppState();

  const [users, states, merchants, drivers, couriers] = await Promise.all([
    selectMany('app_users', [], { column: 'updated_at', ascending: false }, 3000),
    selectManyColumns(
      'app_state',
      'phone, state',
      [],
      { column: 'updated_at', ascending: false },
      2500
    ),
    selectMany('merchant_profiles', [], { column: 'updated_at', ascending: false }, 2000),
    selectMany('driver_profiles', [], { column: 'updated_at', ascending: false }, 2000),
    selectMany('courier_profiles', [], { column: 'updated_at', ascending: false }, 2000),
  ]);

  const merchantByPhone = {};
  for (const row of merchants) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    for (const variant of getPhoneVariants(phone)) {
      merchantByPhone[variant] = row;
    }
  }

  const driverByPhone = {};
  for (const row of drivers) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    for (const variant of getPhoneVariants(phone)) {
      driverByPhone[variant] = row;
    }
  }

  const courierByPhone = {};
  for (const row of couriers) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    for (const variant of getPhoneVariants(phone)) {
      courierByPhone[variant] = row;
    }
  }

  const accounts = users
    .map((user) => {
      const phone = String(user.phone || '').trim();
      if (!phone) return null;
      const state = resolveStateForAdminAccount(states, phone);
      let merchantProfile = null;
      let driverRow = null;
      let courierRow = null;
      for (const variant of getPhoneVariants(phone)) {
        if (!merchantProfile && merchantByPhone[variant]) {
          merchantProfile = merchantByPhone[variant];
        }
        if (!driverRow && driverByPhone[variant]) {
          driverRow = driverByPhone[variant];
        }
        if (!courierRow && courierByPhone[variant]) {
          courierRow = courierByPhone[variant];
        }
      }
      return mapAdminAccountSummary(user, state, merchantProfile, {
        driverProfile: driverRow ? rowToDriverProfileMap(driverRow) : null,
        courierProfile: courierRow ? rowToCourierProfileMap(courierRow) : null,
      });
    })
    .filter(Boolean);

  const kindRank = {
    admin: 0,
    merchant: 1,
    courier: 2,
    driver: 3,
    customer: 4,
  };

  return accounts.sort((a, b) => {
    const rankDiff = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    if (a.isSuspended !== b.isSuspended) {
      return a.isSuspended ? -1 : 1;
    }
    return String(a.displayName || '').localeCompare(String(b.displayName || ''), 'ar');
  });
}

function filterAdminAccounts(accounts, { q = '', kind = 'all' } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const kindFilter = String(kind || 'all').trim();
  return (Array.isArray(accounts) ? accounts : []).filter((a) => {
    if (kindFilter && kindFilter !== 'all' && a.kind !== kindFilter) return false;
    if (!query) return true;
    const hay = `${a.phone || ''} ${a.fullName || ''} ${a.displayName || ''} ${a.merchantStoreName || ''}`.toLowerCase();
    return hay.includes(query);
  });
}

/**
 * بدون page/limit: يرجع مصفوفة كاملة (توافق قديم).
 * مع page أو limit: { items, total, page, limit, pageCount }
 */
async function getAllAdminAccounts(adminPhone, options = {}) {
  const accounts = await buildAllAdminAccountsSorted(adminPhone);
  const filtered = filterAdminAccounts(accounts, {
    q: options.q,
    kind: options.kind,
  });

  const wantsPagination =
    options.page != null ||
    options.limit != null ||
    options.paginated === true;

  if (!wantsPagination) {
    return filtered;
  }

  const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));
  const rawPage = Math.max(1, Number(options.page) || 1);
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / limit) || 1);
  const page = Math.min(rawPage, pageCount);
  const start = (page - 1) * limit;

  return {
    items: filtered.slice(start, start + limit),
    total,
    page,
    limit,
    pageCount,
  };
}

async function purgeAccountData(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const variants = getPhoneVariants(phoneKey);

  if (variants.length > 0) {
    const { error: productsError } = await supabase
      .from('merchant_products')
      .delete()
      .in('phone', variants);
    if (productsError && !/does not exist/i.test(productsError.message || '')) {
      throw new Error(productsError.message);
    }

    if (await hasColumn('customer_favorites', 'phone')) {
      const { error: favoritesError } = await supabase
        .from('customer_favorites')
        .delete()
        .in('phone', variants);
      if (favoritesError && !/does not exist/i.test(favoritesError.message || '')) {
        console.warn('purgeAccountData favorites cleanup:', favoritesError.message);
      }
    }
  }

  try {
    await deleteMerchantProfile(phoneKey);
  } catch (error) {
    if (!/not found|No rows/i.test(String(error?.message || ''))) {
      console.warn('purgeAccountData merchant profile:', error?.message || error);
    }
  }

  try {
    await deleteCustomerProfile(phoneKey);
  } catch (error) {
    if (!/not found|No rows/i.test(String(error?.message || ''))) {
      console.warn('purgeAccountData customer profile:', error?.message || error);
    }
  }

  try {
    await deleteCourierProfile(phoneKey);
  } catch (error) {
    if (!/not found|No rows/i.test(String(error?.message || ''))) {
      console.warn('purgeAccountData courier profile:', error?.message || error);
    }
  }

  try {
    await deleteDriverProfile(phoneKey);
  } catch (error) {
    if (!/not found|No rows/i.test(String(error?.message || ''))) {
      console.warn('purgeAccountData driver profile:', error?.message || error);
    }
  }

  try {
    await deleteUserState(phoneKey);
  } catch (error) {
    console.warn('purgeAccountData user state:', error?.message || error);
  }

  try {
    await deleteAllDeviceTokens(phoneKey);
  } catch (error) {
    console.warn('purgeAccountData device tokens:', error?.message || error);
  }

  await deleteAppUser(phoneKey);
  return { success: true, phone: phoneKey };
}

async function adminDeleteAccount(adminPhone, targetPhone) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(targetPhone);
  if (!phoneKey) {
    throw new Error('Account phone is required.');
  }

  const adminKey = await resolvePhoneKey(adminPhone);
  if (getPhoneVariants(adminKey).some((item) => getPhoneVariants(phoneKey).includes(item))) {
    throw new Error('Cannot delete your own admin session account.');
  }

  if (await isProtectedAdminAccount(phoneKey)) {
    throw new Error('Cannot delete a protected admin account.');
  }

  const existing = await getAppUser(phoneKey);
  if (!existing) {
    throw new Error('Account not found.');
  }

  return purgeAccountData(phoneKey);
}

async function deleteDriverAccount(adminPhone, targetPhone) {
  return adminDeleteAccount(adminPhone, targetPhone);
}

async function notifyAccountSuspended(phoneKey) {
  try {
    const { sendPushToPhone } = require('../push_events');
    await sendPushToPhone(
      phoneKey,
      {
        title: 'تم إيقاف حسابك',
        body: 'تم إيقاف حسابك من الإدارة. لن تصلك طلبات أو إشعارات حتى يُرفع الإيقاف.',
        data: {
          orderId: '',
          eventKey: `account:${phoneKey}:suspended`,
          category: 'account',
        },
      },
      { showSystemBanner: true, immediate: true }
    );
  } catch (pushError) {
    console.error('suspend account push error:', pushError?.message || pushError);
  }
}

/** مزامنة جداول السائق/المندوب + قطع الاتصال من pool التكسي. */
async function syncOperatorSuspendAndForceOffline(phoneKey, isSuspended) {
  const driverProfile = await getDriverProfile(phoneKey);
  const courierProfile = await getCourierProfile(phoneKey);

  if (driverProfile) {
    await saveDriverProfile(phoneKey, {
      ...driverProfile,
      isSuspended: Boolean(isSuspended),
      // عند التعليق: غير متاح. عند الرفع: يُسمح له بالاتصال يدوياً مجدداً.
      available: isSuspended ? false : true,
    });
  }
  if (courierProfile) {
    await saveCourierProfile(phoneKey, {
      ...courierProfile,
      isSuspended: Boolean(isSuspended),
      available: isSuspended ? false : true,
    });
  }

  if (!isSuspended) return;

  try {
    const driverLocations = require('../domains/taxi/repository/driver_locations');
    await driverLocations.setDriverOnline(phoneKey, false);
  } catch (locationError) {
    console.error(
      'suspend force driver_locations offline error:',
      locationError?.message || locationError,
    );
  }

  try {
    const taxiRepo = require('../domains/taxi/repository/taxi');
    await taxiRepo.setDriverOnlineStatus(phoneKey, false);
  } catch (onlineError) {
    // قد يفشل إن لم يكن الملف جاهزاً — الموقع أُطفئ أعلاه.
    console.error(
      'suspend force setDriverOnlineStatus error:',
      onlineError?.message || onlineError,
    );
  }
}

async function adminSuspendAccount(adminPhone, targetPhone, isSuspended) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(targetPhone);
  if (!phoneKey) {
    throw new Error('Account phone is required.');
  }

  if (await isProtectedAdminAccount(phoneKey)) {
    throw new Error('Cannot suspend a protected admin account.');
  }

  const existing = await getAppUser(phoneKey);
  if (!existing) {
    throw new Error('Account not found.');
  }

  const supabase = assertSupabaseAdmin();
  const wantSuspended = Boolean(isSuspended);

  // Try atomic RPC first
  try {
    const { data, error } = await supabase.rpc('atomic_suspend_account', {
      p_phone: phoneKey,
      p_is_suspended: wantSuspended,
    });
    if (!error) {
      // حتى لو نجحت الـ RPC القديمة: نزامن الجداول ونقطع الاتصال من الـ pool.
      await syncOperatorSuspendAndForceOffline(phoneKey, wantSuspended);
      if (wantSuspended) {
        await bumpSessionEpoch(phoneKey);
        await notifyAccountSuspended(phoneKey);
      } else {
        invalidateSessionGate(phoneKey);
      }
      const refreshedState = (await getUserState(phoneKey)) || {};
      const refreshedMerchant = await getMerchantProfile(phoneKey);
      const operatorProfiles = await loadOperatorProfiles(phoneKey);
      return {
        success: true,
        phone: phoneKey,
        isSuspended: resolveAccountSuspended(
          refreshedState,
          refreshedMerchant,
          operatorProfiles
        ),
        account: mapAdminAccountSummary(
          existing,
          refreshedState,
          refreshedMerchant,
          operatorProfiles
        ),
      };
    }
  } catch (_) {
    // fallback
  }

  const state = (await getUserState(phoneKey)) || {};
  const merchantProfile = await getMerchantProfile(phoneKey);

  const nextState = {
    ...state,
    accountSuspended: wantSuspended,
    suspendedAt: wantSuspended ? nowIso() : null,
    sessionEpoch: wantSuspended
      ? Number(state.sessionEpoch || 0) + 1
      : Number(state.sessionEpoch || 0),
  };

  await syncOperatorSuspendAndForceOffline(phoneKey, wantSuspended);
  await saveUserState(phoneKey, nextState);
  invalidateSessionGate(phoneKey);
  if (wantSuspended) {
    await notifyAccountSuspended(phoneKey);
  }

  if (merchantProfile) {
    const variants = getPhoneVariants(phoneKey);
    const { error } = await supabase
      .from('merchant_profiles')
      .update({ is_frozen: wantSuspended, updated_at: nowIso() })
      .in('phone', variants);
    if (error) throw new Error(error.message);
  }

  const refreshedState = (await getUserState(phoneKey)) || nextState;
  const refreshedMerchant = await getMerchantProfile(phoneKey);
  const operatorProfiles = await loadOperatorProfiles(phoneKey);
  return {
    success: true,
    phone: phoneKey,
    isSuspended: resolveAccountSuspended(
      refreshedState,
      refreshedMerchant,
      operatorProfiles
    ),
    account: mapAdminAccountSummary(
      existing,
      refreshedState,
      refreshedMerchant,
      operatorProfiles
    ),
  };
}

function isPlatformAdminPhone(phone) {
  const allowed = new Set();
  for (const configured of PLATFORM_ADMIN_PHONES) {
    for (const variant of getPhoneVariants(configured)) {
      allowed.add(variant);
    }
  }
  for (const variant of getPhoneVariants(phone)) {
    if (allowed.has(variant)) return true;
  }
  return false;
}

/**
 * Soft grant: if phone is a platform admin, ensure adminAccess flag and return true.
 * Otherwise return false (does NOT throw). Use only for login side-effects.
 * For route/repository guards, use assertPlatformAdminAccess() instead.
 */
async function ensurePlatformAdminAccess(phone) {
  if (!isPlatformAdminPhone(phone)) return false;
  const phoneKey = await resolvePhoneKey(phone);
  if (!phoneKey) return false;

  const existingUser = await getAppUser(phoneKey);
  const primaryRole =
    existingUser?.role === 'customer' || existingUser?.role === 'merchant'
      ? existingUser.role
      : 'customer';

  await ensureAppUser(phoneKey, {
    role: primaryRole,
    full_name: existingUser?.full_name || 'مدير المنصة',
    account_type: existingUser?.account_type || primaryRole,
  });

  const existingState = (await getUserState(phoneKey)) || {};
  if (existingState.adminAccess === true) return true;

  await saveUserState(phoneKey, {
    ...existingState,
    adminAccess: true,
    userRole: existingState.userRole || existingState.user_role || primaryRole,
  });
  return true;
}

/** Hard guard: throws when the phone is not a platform admin. */
async function assertPlatformAdminAccess(phone) {
  const ok = await ensurePlatformAdminAccess(phone);
  if (!ok) {
    throw new Error('Admin access required.');
  }
  return true;
}

const MERCHANT_SIGNUP_SERVICE_IDS = new Set([
  'restaurant',
  'product',
  'cars',
  'global_shopping',
  'professionals',
  'beauty',
  'tourism',
]);

async function preRegisterCustomerAccount(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(payload.phone ?? payload.customerPhone ?? '').trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const phoneKey = await resolvePhoneKey(rawPhone);
  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  const address = String(payload.address ?? '').trim();

  const existingUser = await getAppUser(phoneKey);
  if (existingUser && String(existingUser.role ?? '').trim() === 'admin') {
    throw new Error('لا يمكن تسجيل رقم المشرف كزبون.');
  }

  await ensureAppUser(phoneKey, {
    role: 'customer',
    account_type: 'marketplace',
    full_name: fullName || undefined,
  });

  if (fullName || address) {
    await saveCustomerProfile(phoneKey, {
      display_name: fullName || undefined,
      full_name: fullName || undefined,
      address: address || undefined,
    });
  }

  const merchantProfile = await getMerchantProfile(phoneKey);
  if (merchantProfile) {
    throw new Error('هذا الرقم مرتبط بحساب تاجر. استخدم رقماً آخر.');
  }

  return {
    success: true,
    phone: phoneKey,
    fullName: fullName || null,
    role: 'customer',
  };
}

async function preRegisterMerchantAccount(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(
    payload.merchantPhone ?? payload.phone ?? ''
  ).trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const phoneKey = await resolvePhoneKey(rawPhone);
  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  const note = String(payload.note ?? payload.notes ?? '').trim();
  // LEGACY — bazaar membership no longer granted on register.
  const serviceSubCategory = String(
    payload.serviceSubCategory ?? payload.service_sub_category ?? '',
  ).trim();
  const { normalizeCourierMode } = require('./merchant_couriers');
  const courierMode = normalizeCourierMode(
    payload.courierMode ?? payload.courier_mode ?? 'public',
  );

  let serviceIds = normalizeArray(payload.serviceIds ?? payload.service_ids);
  const primaryServiceId = String(
    payload.primaryServiceId ?? payload.primary_service_id ?? serviceIds[0] ?? ''
  ).trim();

  if (serviceIds.length === 0 && primaryServiceId) {
    serviceIds = [primaryServiceId];
  }
  if (serviceIds.length === 0) {
    throw new Error('يرجى اختيار قسم واحد على الأقل.');
  }

  for (const id of serviceIds) {
    if (!MERCHANT_SIGNUP_SERVICE_IDS.has(String(id).trim())) {
      throw new Error(`قسم غير صالح: ${id}`);
    }
  }

  const primary =
    primaryServiceId && serviceIds.includes(primaryServiceId)
      ? primaryServiceId
      : serviceIds[0];

  const existingUser = await getAppUser(phoneKey);
  if (existingUser && String(existingUser.role ?? '').trim() === 'admin') {
    throw new Error('لا يمكن تسجيل رقم المشرف كتاجر.');
  }

  const placeholderStoreName =
    fullName || `تاجر ${phoneKey.slice(-4)}`;

  const existingProfile = await getMerchantProfile(phoneKey);
  if (existingProfile) {
    const existingState = (await getUserState(phoneKey)) || {};
    if (existingState.merchantProfileComplete === true) {
      throw new Error('يوجد ملف تاجر مكتمل لهذا الرقم بالفعل.');
    }
    const storeName = String(existingProfile.store_name ?? '').trim();
    if (storeName && !existingState.adminPreRegisteredMerchant) {
      throw new Error('يوجد ملف تاجر مكتمل لهذا الرقم بالفعل.');
    }
  }

  if (!existingUser) {
    await saveAppUser(phoneKey, {
      role: 'merchant',
      account_type: 'marketplace',
      full_name: fullName || undefined,
    });
  } else {
    const patch = {};
    const existingName = String(existingUser.full_name ?? '').trim();
    if (fullName && !existingName) patch.full_name = fullName;
    if (!String(existingUser.account_type ?? '').trim()) {
      patch.account_type = 'marketplace';
    }
    if (Object.keys(patch).length > 0) {
      await saveAppUser(phoneKey, patch);
    }
  }

  await saveMerchantProfile(phoneKey, {
    store_name: placeholderStoreName,
    primary_service_id: primary,
    service_ids: serviceIds,
    active_service_id: primary,
    is_approved: true,
    approval_status: 'approved',
    is_open: true,
    is_bazaar_member: false,
    admin_pre_registered: true,
    _adminModerationBypass: true,
    description: note || undefined,
    service_sub_category: serviceSubCategory || undefined,
    courier_mode: courierMode,
    courierMode,
  });

  const merchantStoreStub = {
    category: primary,
    serviceIds,
    service_ids: serviceIds,
    activeServiceId: primary,
    active_service_id: primary,
    primary_service_id: primary,
    isApproved: true,
    approvalStatus: 'approved',
    adminPreRegistered: true,
    admin_pre_registered: true,
    name: placeholderStoreName,
    store_name: placeholderStoreName,
    courierMode,
    courier_mode: courierMode,
  };

  const merchantState = (await getUserState(phoneKey)) || {};
  await saveUserState(phoneKey, {
    ...merchantState,
    userRole: merchantState.userRole || merchantState.user_role || 'merchant',
    user_role: merchantState.user_role || merchantState.userRole || 'merchant',
    merchantProfileComplete: false,
    merchantStore: merchantStoreStub,
    adminPreRegisteredMerchant: true,
    adminPreRegisteredAt: nowIso(),
    adminPreRegisteredBy: adminPhone,
    multiRoleAccount: true,
  });

  const refreshed = await getMerchantProfile(phoneKey);
  const user = await getAppUser(phoneKey);

  return {
    success: true,
    phone: phoneKey,
    fullName: String(user?.full_name ?? fullName ?? '').trim(),
    primaryServiceId: primary,
    serviceIds,
    isApproved: true,
    approvalStatus: 'approved',
    merchantProfileComplete: false,
    storeName: String(refreshed?.store_name ?? '').trim(),
    isBazaarMember: false,
    serviceSubCategory: serviceSubCategory || null,
    courierMode,
  };
}

async function updateProfessionalCategoryByAdmin(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(
    payload.professionalPhone ?? payload.merchantPhone ?? payload.phone ?? '',
  ).trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const phoneKey = await resolvePhoneKey(rawPhone);
  const profile = await getMerchantProfile(phoneKey);
  if (!profile) {
    throw new Error('المهني غير موجود.');
  }
  if (!isProfessionalMerchantProfile(profile)) {
    throw new Error('هذا الحساب ليس مهنياً.');
  }

  const professionId = String(
    payload.professionId ??
      payload.profession_id ??
      payload.professionalCategoryId ??
      payload.professional_category_id ??
      '',
  ).trim();
  const category = await resolveProfessionalCategory(professionId);
  if (!category) {
    throw new Error('يرجى اختيار تخصص مهني صحيح.');
  }

  const existingInfo = normalizeObject(profile.professional_info);
  const currentId = String(
    profile.professional_category_id || existingInfo.professionId || '',
  ).trim();
  if (currentId === professionId) {
    return {
      success: true,
      phone: phoneKey,
      professionId,
      professionNameAr: category.labelAr,
      professionNameEn: category.labelEn,
      categoryLabel: mapProfessionalCategoryLabel(professionId),
      previousProfessionId: currentId || null,
      unchanged: true,
    };
  }

  const professionalInfo = {
    ...existingInfo,
    professionId,
    professionNameAr: category.labelAr,
    professionNameEn: category.labelEn,
  };

  const serviceIds = normalizeArray(profile.service_ids);
  const nextServiceIds = serviceIds.length
    ? [...new Set([...serviceIds.map(String), 'professionals'])]
    : ['professionals'];

  await saveMerchantProfile(phoneKey, {
    primary_service_id: 'professionals',
    service_ids: nextServiceIds,
    active_service_id: 'professionals',
    professional_category_id: professionId,
    professional_info: professionalInfo,
    _adminModerationBypass: true,
  });

  const merchantState = (await getUserState(phoneKey)) || {};
  const merchantStore = normalizeObject(merchantState.merchantStore);
  merchantStore.category = 'professionals';
  merchantStore.primary_service_id = 'professionals';
  merchantStore.primaryServiceId = 'professionals';
  merchantStore.active_service_id = 'professionals';
  merchantStore.activeServiceId = 'professionals';
  merchantStore.service_ids = nextServiceIds;
  merchantStore.serviceIds = nextServiceIds;
  merchantStore.professionalCategoryId = professionId;
  merchantStore.professionalInfo = professionalInfo;
  merchantStore.isProfessional = true;

  await saveUserState(phoneKey, {
    ...merchantState,
    merchantStore,
    multiRoleAccount: true,
  });

  try {
    await saveMerchantServiceProfile(phoneKey, 'professionals', {
      professional_category_id: professionId,
      professional_info: professionalInfo,
      store_name: profile.store_name,
    });
  } catch (serviceProfileError) {
    console.warn(
      'updateProfessionalCategory service profile:',
      serviceProfileError?.message || serviceProfileError,
    );
  }

  return {
    success: true,
    phone: phoneKey,
    professionId,
    professionNameAr: category.labelAr,
    professionNameEn: category.labelEn,
    categoryLabel: mapProfessionalCategoryLabel(professionId),
    previousProfessionId: currentId || null,
  };
}

async function updateMerchantCategoryByAdmin(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(payload.merchantPhone ?? payload.phone ?? '').trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const phoneKey = await resolvePhoneKey(rawPhone);
  const profile = await getMerchantProfile(phoneKey);
  if (!profile) {
    throw new Error('التاجر غير موجود.');
  }

  const primaryServiceId = String(
    payload.primaryServiceId ?? payload.primary_service_id ?? '',
  ).trim();
  if (!primaryServiceId) {
    throw new Error('يرجى اختيار القسم الجديد.');
  }
  if (!MERCHANT_SIGNUP_SERVICE_IDS.has(primaryServiceId)) {
    throw new Error(`قسم غير صالح: ${primaryServiceId}`);
  }

  let serviceIds = normalizeArray(payload.serviceIds ?? payload.service_ids);
  if (serviceIds.length === 0) {
    serviceIds = [primaryServiceId];
  }
  for (const id of serviceIds) {
    if (!MERCHANT_SIGNUP_SERVICE_IDS.has(String(id).trim())) {
      throw new Error(`قسم غير صالح: ${id}`);
    }
  }
  if (!serviceIds.includes(primaryServiceId)) {
    serviceIds = [primaryServiceId, ...serviceIds.filter((id) => id !== primaryServiceId)];
  }

  const serviceSubCategory = String(
    payload.serviceSubCategory ?? payload.service_sub_category ?? '',
  ).trim();

  const profilePatch = {
    primary_service_id: primaryServiceId,
    service_ids: serviceIds,
    active_service_id: primaryServiceId,
    _adminModerationBypass: true,
  };
  if (serviceSubCategory) {
    profilePatch.service_sub_category = serviceSubCategory;
  } else if (primaryServiceId !== 'beauty') {
    profilePatch.service_sub_category = null;
  }
  // LEGACY — ignore bazaar membership toggles; channel removed.
  profilePatch.is_bazaar_member = false;

  await saveMerchantProfile(phoneKey, profilePatch);

  const merchantState = (await getUserState(phoneKey)) || {};
  const merchantStore = normalizeObject(merchantState.merchantStore);
  merchantStore.category = primaryServiceId;
  merchantStore.primary_service_id = primaryServiceId;
  merchantStore.primaryServiceId = primaryServiceId;
  merchantStore.active_service_id = primaryServiceId;
  merchantStore.activeServiceId = primaryServiceId;
  merchantStore.service_ids = serviceIds;
  merchantStore.serviceIds = serviceIds;
  if (primaryServiceId === 'beauty') {
    if (serviceSubCategory) {
      merchantStore.serviceSubCategory = serviceSubCategory;
      merchantStore.service_sub_category = serviceSubCategory;
    }
  } else if (serviceSubCategory) {
    merchantStore.serviceSubCategory = serviceSubCategory;
    merchantStore.service_sub_category = serviceSubCategory;
  } else {
    delete merchantStore.serviceSubCategory;
    delete merchantStore.service_sub_category;
    delete merchantStore.subCategoryId;
  }

  await saveUserState(phoneKey, {
    ...merchantState,
    merchantStore,
    multiRoleAccount: true,
  });

  const refreshed = await getMerchantProfile(phoneKey);
  return {
    success: true,
    phone: phoneKey,
    primaryServiceId,
    serviceIds,
    serviceSubCategory: serviceSubCategory || null,
    isBazaarMember: false,
    storeName: String(refreshed?.store_name ?? '').trim(),
  };
}

async function updateMerchantProfileByAdmin(adminPhone, merchantPhone, patch = {}) {
  await assertAdminAccess(adminPhone);
  const phoneKey = await resolvePhoneKey(merchantPhone);
  const profile = await getMerchantProfile(phoneKey);
  if (!profile) {
    throw new Error('التاجر غير موجود.');
  }

  const state = (await getUserState(phoneKey)) || {};
  const store = normalizeObject(state.merchantStore || {});

  const storeName = String(patch.storeName ?? patch.store_name ?? '').trim();
  if (storeName) {
    store.store_name = storeName;
    store.name = storeName;
  }

  const address = String(patch.address ?? '').trim();
  if (address) store.address = address;

  const description = String(patch.description ?? '').trim();
  if (description) {
    store.description = description;
    if (store.professionalInfo) store.professionalInfo.description = description;
  }

  const doctorPhone = String(patch.doctorPhone ?? patch.doctor_phone ?? '').trim();
  if (doctorPhone) store.doctorPhone = doctorPhone;
  const clinicPhone = String(patch.clinicPhone ?? patch.clinic_phone ?? '').trim();
  if (clinicPhone) store.clinicPhone = clinicPhone;
  const contactPhone = String(patch.contactPhone ?? patch.phone ?? '').trim();
  if (contactPhone) {
    store.phone = contactPhone;
    store.doctorPhone = doctorPhone || contactPhone;
  }

  // التخصصات المتعددة
  if (Array.isArray(patch.specialties)) {
    const specialties = patch.specialties.map((s) => String(s).trim()).filter(Boolean);
    if (specialties.length) {
      store.specialty = specialties[0];
      store.specialties = specialties;
      if (store.professionalInfo) {
        store.professionalInfo.specialty = specialties[0];
        store.professionalInfo.specialties = specialties;
      }
    }
  }

  // أيام التواجد
  if (Array.isArray(patch.workingDays)) {
    const workingDays = patch.workingDays.map((d) => String(d).trim()).filter(Boolean);
    store.workingDays = workingDays.length ? workingDays : undefined;
    if (store.professionalInfo) {
      store.professionalInfo.workingDays = workingDays.length ? workingDays : undefined;
    }
  }

  // أوقات الدوام (فترة صباحية / مسائية)
  const openTime = String(patch.openTime ?? '').trim();
  const closeTime = String(patch.closeTime ?? '').trim();
  const morningOpenTime = String(patch.morningOpenTime ?? patch.morning_open_time ?? '').trim();
  const morningCloseTime = String(patch.morningCloseTime ?? patch.morning_close_time ?? '').trim();
  const eveningOpenTime = String(patch.eveningOpenTime ?? patch.evening_open_time ?? '').trim();
  const eveningCloseTime = String(patch.eveningCloseTime ?? patch.evening_close_time ?? '').trim();
  if (openTime) store.openTime = openTime;
  if (closeTime) store.closeTime = closeTime;
  store.morningOpenTime = morningOpenTime || undefined;
  store.morningCloseTime = morningCloseTime || undefined;
  store.eveningOpenTime = eveningOpenTime || undefined;
  store.eveningCloseTime = eveningCloseTime || undefined;

  const hasProfileImage =
    Object.prototype.hasOwnProperty.call(patch, 'profileImageUrl') ||
    Object.prototype.hasOwnProperty.call(patch, 'profile_image_url');
  const hasClinicImage =
    Object.prototype.hasOwnProperty.call(patch, 'clinicImageUrl') ||
    Object.prototype.hasOwnProperty.call(patch, 'clinic_image_url');
  const profileImageUrl = hasProfileImage
    ? String(patch.profileImageUrl ?? patch.profile_image_url ?? '').trim()
    : '';
  const clinicImageUrl = hasClinicImage
    ? String(patch.clinicImageUrl ?? patch.clinic_image_url ?? '').trim()
    : '';

  if (!store.professionalInfo || typeof store.professionalInfo !== 'object') {
    store.professionalInfo = {};
  }
  if (hasProfileImage) {
    store.profileImageUrl = profileImageUrl || undefined;
    store.profile_image_url = profileImageUrl || undefined;
    store.logoImageUrl = profileImageUrl || undefined;
    store.logo_image_url = profileImageUrl || undefined;
    store.professionalInfo.profileImageUrl = profileImageUrl;
    store.professionalInfo.profileImageBase64 = profileImageUrl;
  }
  if (hasClinicImage) {
    store.clinicImageUrl = clinicImageUrl || undefined;
    store.coverImageUrl = clinicImageUrl || undefined;
    store.cover_image_url = clinicImageUrl || undefined;
    store.professionalInfo.clinicImageUrl = clinicImageUrl;
    store.professionalInfo.clinicImageBase64 = clinicImageUrl;
    store.professionalInfo.coverImageUrl = clinicImageUrl;
  }

  await saveUserState(phoneKey, {
    ...state,
    merchantStore: store,
    multiRoleAccount: true,
  });

  const profilePatch = {};
  if (storeName) profilePatch.store_name = storeName;
  if (hasProfileImage) {
    profilePatch.profile_image_url = profileImageUrl;
    profilePatch.profileImageUrl = profileImageUrl;
    profilePatch.logo_image_url = profileImageUrl;
    profilePatch.logoImageUrl = profileImageUrl;
    profilePatch.profile_image_base64 = profileImageUrl;
  }
  if (hasClinicImage) {
    profilePatch.cover_image_url = clinicImageUrl;
    profilePatch.coverImageUrl = clinicImageUrl;
  }
  // انقل بيانات الطبيب (التخصص، الدوام، الهواتف...) إلى merchant_profiles
  // حتى تظهر في فلاتر الزبائن — كانت تُحفظ في app_state فقط.
  const info = store.professionalInfo || {};
  if (
    info.specialty ||
    info.specialties ||
    store.specialty ||
    store.specialties ||
    store.workingDays ||
    store.openTime ||
    store.closeTime ||
    store.morningOpenTime ||
    store.eveningOpenTime ||
    hasProfileImage ||
    hasClinicImage
  ) {
    profilePatch.open_time = store.openTime || undefined;
    profilePatch.close_time = store.closeTime || undefined;
    profilePatch.professional_info = {
      ...info,
      specialty: info.specialty || store.specialty || undefined,
      specialties: info.specialties || store.specialties || undefined,
      workingDays: store.workingDays || info.workingDays || undefined,
      doctorPhone: store.doctorPhone || info.doctorPhone || undefined,
      clinicPhone: store.clinicPhone || info.clinicPhone || undefined,
      description: info.description || store.description || undefined,
      openTime: store.openTime || info.openTime || undefined,
      closeTime: store.closeTime || info.closeTime || undefined,
      morningOpenTime: store.morningOpenTime || info.morningOpenTime || undefined,
      morningCloseTime: store.morningCloseTime || info.morningCloseTime || undefined,
      eveningOpenTime: store.eveningOpenTime || info.eveningOpenTime || undefined,
      eveningCloseTime: store.eveningCloseTime || info.eveningCloseTime || undefined,
      ...(hasProfileImage ? { profileImageUrl, profileImageBase64: profileImageUrl } : {}),
      ...(hasClinicImage
        ? { clinicImageUrl, clinicImageBase64: clinicImageUrl, coverImageUrl: clinicImageUrl }
        : {}),
    };
  }
  if (Object.keys(profilePatch).length) {
    profilePatch._adminModerationBypass = true;
    await saveMerchantProfile(phoneKey, profilePatch);
  }

  return {
    success: true,
    phone: phoneKey,
    storeName: storeName || String(profile.store_name ?? '').trim(),
    specialty: store.specialty || null,
    specialties: store.specialties || null,
    workingDays: store.workingDays || null,
  };
}

async function preRegisterDriverAccount(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(payload.driverPhone ?? payload.phone ?? '').trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  if (!fullName) {
    throw new Error('اسم السائق مطلوب.');
  }

  const note = String(payload.note ?? payload.notes ?? '').trim();
  const taxiTypeRaw = String(payload.taxiType ?? payload.taxi_type ?? 'economic')
    .trim()
    .toLowerCase();
  const taxiType =
    taxiTypeRaw === 'starx11' || taxiTypeRaw === 'starx'
      ? 'starx11'
      : taxiTypeRaw === 'tuktuk' || taxiTypeRaw === 'wazz'
        ? taxiTypeRaw
        : 'economic';
  const phoneKey = await resolvePhoneKey(rawPhone);

  const existingUser = await getAppUser(phoneKey);
  if (existingUser && String(existingUser.role ?? '').trim() === 'admin') {
    throw new Error('لا يمكن تسجيل رقم المشرف كسائق.');
  }

  const existingState = (await getUserState(phoneKey)) || {};
  const existingDriver = await getDriverProfile(phoneKey);
  if (
    existingDriver &&
    isDriverProfileComplete(existingDriver) &&
    !existingState.adminPreRegisteredDriver
  ) {
    throw new Error('يوجد ملف سائق مكتمل لهذا الرقم بالفعل.');
  }

  if (!existingUser) {
    await saveAppUser(phoneKey, {
      role: 'customer',
      account_type: 'marketplace',
      full_name: fullName,
    });
  } else {
    const existingName = String(existingUser.full_name ?? '').trim();
    if (!existingName && fullName) {
      await saveAppUser(phoneKey, { full_name: fullName });
    }
  }

  const savedProfile = await saveDriverProfile(phoneKey, {
    name: fullName,
    phone: phoneKey,
    type: 'taxi',
    taxiType,
    services: { taxi: true, delivery: false },
    isApproved: true,
    approvalStatus: 'approved',
    available: false,
    adminPreRegistered: true,
    adminNote: note || undefined,
  });

  await saveUserState(phoneKey, {
    ...existingState,
    driverProfile: savedProfile,
    driverProfileComplete: false,
    adminPreRegisteredDriver: true,
    adminPreRegisteredAt: nowIso(),
    adminPreRegisteredBy: adminPhone,
    multiRoleAccount: true,
  });

  const user = await getAppUser(phoneKey);

  return {
    success: true,
    phone: phoneKey,
    fullName: String(user?.full_name ?? fullName).trim(),
    taxiType,
    isApproved: true,
    approvalStatus: 'approved',
    driverProfileComplete: false,
  };
}

async function preRegisterCourierAccount(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(payload.courierPhone ?? payload.phone ?? '').trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  if (!fullName) {
    throw new Error('اسم المندوب مطلوب.');
  }

  const note = String(payload.note ?? payload.notes ?? '').trim();
  const phoneKey = await resolvePhoneKey(rawPhone);

  const existingUser = await getAppUser(phoneKey);
  if (existingUser && String(existingUser.role ?? '').trim() === 'admin') {
    throw new Error('لا يمكن تسجيل رقم المشرف كمندوب.');
  }

  const existingState = (await getUserState(phoneKey)) || {};
  const existingCourier = await getCourierProfile(phoneKey);
  if (
    existingCourier &&
    isCourierProfileComplete(existingCourier) &&
    existingState.courierProfileComplete === true &&
    !existingState.adminPreRegisteredCourier
  ) {
    throw new Error('يوجد ملف مندوب مكتمل لهذا الرقم بالفعل.');
  }

  if (!existingUser) {
    await saveAppUser(phoneKey, {
      role: 'customer',
      account_type: 'marketplace',
      full_name: fullName,
    });
  } else {
    const existingName = String(existingUser.full_name ?? '').trim();
    if (!existingName && fullName) {
      await saveAppUser(phoneKey, { full_name: fullName });
    }
  }

  const savedProfile = await saveCourierProfile(phoneKey, {
    name: fullName,
    phone: phoneKey,
    isApproved: true,
    approvalStatus: 'approved',
    available: false,
    adminPreRegistered: true,
    adminNote: note || undefined,
  });

  await saveUserState(phoneKey, {
    ...existingState,
    courierProfile: savedProfile,
    courierProfileComplete: false,
    adminPreRegisteredCourier: true,
    adminPreRegisteredAt: nowIso(),
    adminPreRegisteredBy: adminPhone,
    multiRoleAccount: true,
  });

  const user = await getAppUser(phoneKey);

  const merchantPhone = String(
    payload.merchantPhone ?? payload.merchant_phone ?? '',
  ).trim();
  if (merchantPhone) {
    try {
      const { upsertMerchantCourierLink } = require('./merchant_couriers');
      await upsertMerchantCourierLink({
        merchantPhone,
        courierPhone: phoneKey,
        status: 'approved',
        invitedBy: 'admin',
        displayName: fullName,
        note: note || undefined,
      });
    } catch (linkError) {
      console.error(
        'preRegister courier merchant link error:',
        linkError?.message || linkError,
      );
    }
  }

  return {
    success: true,
    phone: phoneKey,
    fullName: String(user?.full_name ?? fullName).trim(),
    isApproved: true,
    approvalStatus: 'approved',
    courierProfileComplete: false,
    merchantPhone: merchantPhone || null,
  };
}

async function preRegisterProfessionalAccount(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(payload.professionalPhone ?? payload.phone ?? '').trim();
  if (!rawPhone) {
    throw new Error('رقم الهاتف مطلوب.');
  }

  const phoneKey = await resolvePhoneKey(rawPhone);
  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  if (!fullName) {
    throw new Error('اسم المهني مطلوب.');
  }

  const professionId = String(payload.professionId ?? payload.profession_id ?? '').trim();
  const category = await resolveProfessionalCategory(professionId);
  if (!category) {
    throw new Error('يرجى اختيار تخصص مهني صحيح.');
  }

  const catNames = { ar: category.labelAr, en: category.labelEn };
  const description = String(payload.description ?? '').trim();
  const address = String(payload.address ?? '').trim();
  const phone = String(payload.phone ?? payload.contactPhone ?? '').trim();
  const whatsapp = String(payload.whatsapp ?? '').trim();
  const openTime = String(payload.openTime ?? payload.open_time ?? '').trim();
  const closeTime = String(payload.closeTime ?? payload.close_time ?? '').trim();
  const profileImageUrl = String(payload.profileImageUrl ?? payload.profile_image_url ?? '').trim();
  const workSampleUrls = normalizeArray(payload.workSampleUrls ?? payload.work_sample_urls);

  const showPhone = payload.showPhoneToCustomers !== false;
  const showWhatsapp = payload.showWhatsAppToCustomers !== false;

  const existingUser = await getAppUser(phoneKey);
  if (existingUser && String(existingUser.role ?? '').trim() === 'admin') {
    throw new Error('لا يمكن تسجيل رقم المشرف كمهني.');
  }

  const existingProfileCheck = await getMerchantProfile(phoneKey);
  if (existingProfileCheck) {
    const existingState = (await getUserState(phoneKey)) || {};
    if (existingState.merchantProfileComplete === true) {
      throw new Error('يوجد ملف تاجر مكتمل لهذا الرقم بالفعل.');
    }
  }

  if (!existingUser) {
    await saveAppUser(phoneKey, {
      role: 'merchant',
      account_type: 'marketplace',
      full_name: fullName,
    });
  } else {
    const patch = {};
    const existingName = String(existingUser.full_name ?? '').trim();
    if (!existingName) patch.full_name = fullName;
    if (!String(existingUser.account_type ?? '').trim()) {
      patch.account_type = 'marketplace';
    }
    if (Object.keys(patch).length > 0) {
      await saveAppUser(phoneKey, patch);
    }
  }

  const professionalInfo = {
    name: fullName,
    address,
    phone,
    whatsapp,
    openTime,
    closeTime,
    professionId,
    professionNameAr: catNames.ar,
    professionNameEn: catNames.en,
    profileImageBase64: profileImageUrl,
    workSampleImagesBase64: workSampleUrls,
    contact_visibility: {
      show_phone_to_customers: showPhone,
      show_whatsapp_to_customers: showWhatsapp,
      showPhoneToCustomers: showPhone,
      showWhatsAppToCustomers: showWhatsapp,
    },
    contactVisibility: {
      showPhoneToCustomers: showPhone,
      showWhatsAppToCustomers: showWhatsapp,
    },
  };

  // _adminModerationBypass is an in-memory flag only — saveMerchantProfile
  // reads it and never writes it as a DB column (direct upserts must not include it).
  await saveMerchantProfile(phoneKey, {
    store_name: fullName,
    primary_service_id: 'professionals',
    service_ids: ['professionals'],
    active_service_id: 'professionals',
    description: description || undefined,
    is_approved: true,
    approval_status: 'approved',
    is_open: true,
    admin_pre_registered: true,
    _adminModerationBypass: true,
    professional_info: professionalInfo,
    professional_category_id: professionId,
    // profile_image_base64 محذوفة عمداً — صورة المهني تخزن داخل professional_info فقط
  });

  const merchantStoreStub = {
    category: 'professionals',
    serviceIds: ['professionals'],
    service_ids: ['professionals'],
    activeServiceId: 'professionals',
    active_service_id: 'professionals',
    primary_service_id: 'professionals',
    isApproved: true,
    approvalStatus: 'approved',
    adminPreRegistered: true,
    name: fullName,
    store_name: fullName,
    isProfessional: true,
    professionalCategoryId: professionId,
    professionalInfo,
  };

  const merchantState = (await getUserState(phoneKey)) || {};
  await saveUserState(phoneKey, {
    ...merchantState,
    userRole: merchantState.userRole || merchantState.user_role || 'merchant',
    user_role: merchantState.user_role || merchantState.userRole || 'merchant',
    merchantProfileComplete: false,
    merchantStore: merchantStoreStub,
    adminPreRegisteredMerchant: true,
    adminPreRegisteredAt: nowIso(),
    adminPreRegisteredBy: adminPhone,
    multiRoleAccount: true,
  });

  const refreshed = await getMerchantProfile(phoneKey);
  const user = await getAppUser(phoneKey);

  return {
    success: true,
    phone: phoneKey,
    fullName: String(user?.full_name ?? fullName).trim(),
    professionId,
    storeName: String(refreshed?.store_name ?? fullName).trim(),
    isApproved: true,
    approvalStatus: 'approved',
    merchantProfileComplete: false,
  };
}

const BEAUTY_SUB_CATEGORIES = new Set(['أطباء وعيادات', 'صيدلية', 'مختبرات طبية']);

const {
  isValidDoctorSpecialty,
} = require('../constants/doctor_specialties');

const BEAUTY_SUB_CATEGORY_NAMES = {
  'أطباء وعيادات': { ar: 'أطباء وعيادات', en: 'Doctors & Clinics' },
  'صيدلية': { ar: 'صيدلية', en: 'Pharmacy' },
  'مختبرات طبية': { ar: 'مختبرات طبية', en: 'Medical Labs' },
};

async function preRegisterBeautyAccount(adminPhone, payload = {}) {
  await assertAdminAccess(adminPhone);

  const rawPhone = String(payload.subscriberPhone ?? payload.phone ?? '').trim();
  if (!rawPhone) throw new Error('رقم الهاتف مطلوب.');

  const phoneKey = await resolvePhoneKey(rawPhone);
  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  if (!fullName) throw new Error('الاسم مطلوب.');

  const subCategoryId = String(payload.subCategoryId ?? payload.sub_category_id ?? '').trim();
  if (!subCategoryId || !BEAUTY_SUB_CATEGORIES.has(subCategoryId)) {
    throw new Error('يرجى اختيار تصنيف صحيح (طبيب/صيدلية/مختبر طبي).');
  }

  const catNames = BEAUTY_SUB_CATEGORY_NAMES[subCategoryId] || { ar: '', en: '' };
  const description = String(payload.description ?? '').trim();
  const address = String(payload.address ?? '').trim();
  const phone = String(payload.phone ?? payload.contactPhone ?? '').trim();
  const whatsapp = String(payload.whatsapp ?? '').trim();
  const latitudeRaw = payload.latitude ?? payload.lat;
  const longitudeRaw = payload.longitude ?? payload.lng;
  const latitude = latitudeRaw === '' || latitudeRaw == null
    ? null
    : Number(latitudeRaw);
  const longitude = longitudeRaw === '' || longitudeRaw == null
    ? null
    : Number(longitudeRaw);
  const specialty = String(payload.specialty ?? '').trim();
  const rawSpecialties = Array.isArray(payload.specialties) ? payload.specialties : [];
  const specialties = rawSpecialties.length
    ? rawSpecialties.map((s) => String(s).trim()).filter(Boolean)
    : specialty
      ? [specialty]
      : [];
  const workingDays = Array.isArray(payload.workingDays)
    ? payload.workingDays.map((d) => String(d).trim()).filter(Boolean)
    : [];
  const doctorPhone = String(payload.doctorPhone ?? payload.doctor_phone ?? '').trim();
  const clinicPhone = String(payload.clinicPhone ?? payload.clinic_phone ?? '').trim();
  if (subCategoryId === 'أطباء وعيادات') {
    if (specialties.length === 0) {
      throw new Error('يرجى اختيار التخصص الطبي.');
    }
    for (const sp of specialties) {
      if (!isValidDoctorSpecialty(sp)) {
        throw new Error('التخصص الطبي غير صالح: ' + sp);
      }
    }
  }
  if (subCategoryId === 'صيدلية' || subCategoryId === 'مختبرات طبية') {
    if (!phone) throw new Error('رقم التواصل مطلوب.');
    if (!address) throw new Error('العنوان مطلوب.');
  }
  const openTimeRaw = String(payload.openTime ?? payload.open_time ?? '').trim();
  const closeTimeRaw = String(payload.closeTime ?? payload.close_time ?? '').trim();
  const morningOpenTime = String(
    payload.morningOpenTime ?? payload.morning_open_time ?? '',
  ).trim();
  const morningCloseTime = String(
    payload.morningCloseTime ?? payload.morning_close_time ?? '',
  ).trim();
  const eveningOpenTime = String(
    payload.eveningOpenTime ?? payload.evening_open_time ?? '',
  ).trim();
  const eveningCloseTime = String(
    payload.eveningCloseTime ?? payload.evening_close_time ?? '',
  ).trim();

  const shiftRanges = [];
  if (morningOpenTime && morningCloseTime) {
    shiftRanges.push({ open: morningOpenTime, close: morningCloseTime });
  }
  if (eveningOpenTime && eveningCloseTime) {
    shiftRanges.push({ open: eveningOpenTime, close: eveningCloseTime });
  }
  let openTime = openTimeRaw;
  let closeTime = closeTimeRaw;
  if (shiftRanges.length > 0) {
    openTime = shiftRanges.reduce(
      (best, range) => (range.open < best ? range.open : best),
      shiftRanges[0].open,
    );
    closeTime = shiftRanges.reduce(
      (best, range) => (range.close > best ? range.close : best),
      shiftRanges[0].close,
    );
  }

  const doctorShiftFields = {
    ...(morningOpenTime ? { morningOpenTime, morning_open_time: morningOpenTime } : {}),
    ...(morningCloseTime ? { morningCloseTime, morning_close_time: morningCloseTime } : {}),
    ...(eveningOpenTime ? { eveningOpenTime, evening_open_time: eveningOpenTime } : {}),
    ...(eveningCloseTime ? { eveningCloseTime, evening_close_time: eveningCloseTime } : {}),
  };

  const profileImageUrl = String(payload.profileImageUrl ?? payload.profile_image_url ?? '').trim();
  const clinicImageUrl = String(payload.clinicImageUrl ?? payload.clinic_image_url ?? '').trim();

  const existingUser = await getAppUser(phoneKey);
  if (existingUser && String(existingUser.role ?? '').trim() === 'admin') {
    throw new Error('لا يمكن تسجيل رقم المشرف.');
  }

  const existingProfile = await getMerchantProfile(phoneKey);
  if (existingProfile) {
    const existingState = (await getUserState(phoneKey)) || {};
    if (existingState.merchantProfileComplete === true) {
      throw new Error('يوجد ملف مكتمل لهذا الرقم بالفعل.');
    }
  }

  if (!existingUser) {
    await saveAppUser(phoneKey, {
      role: 'merchant',
      account_type: 'marketplace',
      full_name: fullName,
    });
  } else {
    const patch = {};
    const existingName = String(existingUser.full_name ?? '').trim();
    if (!existingName) patch.full_name = fullName;
    if (!String(existingUser.account_type ?? '').trim()) patch.account_type = 'marketplace';
    if (Object.keys(patch).length > 0) await saveAppUser(phoneKey, patch);
  }

  await saveMerchantProfile(phoneKey, {
    store_name: fullName,
    primary_service_id: 'beauty',
    service_ids: ['beauty'],
    active_service_id: 'beauty',
    is_approved: true,
    approval_status: 'approved',
    is_open: true,
    admin_pre_registered: true,
    _adminModerationBypass: true,
    address: address || undefined,
    whatsapp: whatsapp || undefined,
    open_time: openTime || undefined,
    close_time: closeTime || undefined,
    latitude: Number.isFinite(latitude) ? latitude : undefined,
    longitude: Number.isFinite(longitude) ? longitude : undefined,
    service_sub_category: subCategoryId,
    serviceSubCategory: subCategoryId,
    subCategoryId,
    doctor_phone: doctorPhone || undefined,
    clinic_phone: clinicPhone || undefined,
    profile_image_url: profileImageUrl || undefined,
    profileImageUrl: profileImageUrl || undefined,
    cover_image_url: clinicImageUrl || undefined,
    coverImageUrl: clinicImageUrl || undefined,
    logo_image_url: profileImageUrl || undefined,
    logoImageUrl: profileImageUrl || undefined,
    ...(subCategoryId === 'أطباء وعيادات'
      ? {
          professional_info: {
            specialty,
            specialties,
            workingDays: workingDays.length ? workingDays : undefined,
            doctorPhone: doctorPhone || undefined,
            clinicPhone: clinicPhone || undefined,
            profileImageUrl: profileImageUrl || undefined,
            clinicImageUrl: clinicImageUrl || undefined,
            description: description || fullName,
            openTime: openTime || undefined,
            closeTime: closeTime || undefined,
            ...doctorShiftFields,
          },
        }
      : subCategoryId === 'صيدلية' || subCategoryId === 'مختبرات طبية'
        ? {
            professional_info: {
              phone: phone || undefined,
              whatsapp: whatsapp || undefined,
              address: address || undefined,
              latitude: Number.isFinite(latitude) ? latitude : undefined,
              longitude: Number.isFinite(longitude) ? longitude : undefined,
              profileImageUrl: profileImageUrl || undefined,
              clinicImageUrl: clinicImageUrl || undefined,
              description: description || fullName,
              openTime: openTime || undefined,
              closeTime: closeTime || undefined,
              ...doctorShiftFields,
            },
          }
        : {}),
  });

  await saveMerchantProfile(phoneKey, {
    primary_service_id: 'beauty',
    service_ids: ['beauty'],
    active_service_id: 'beauty',
    service_sub_category: subCategoryId,
    serviceSubCategory: subCategoryId,
    subCategoryId,
    is_approved: true,
    approval_status: 'approved',
    is_open: true,
  });

  const merchantState = (await getUserState(phoneKey)) || {};
  await saveUserState(phoneKey, {
    ...merchantState,
    userRole: merchantState.userRole || merchantState.user_role || 'merchant',
    user_role: merchantState.user_role || merchantState.userRole || 'merchant',
    merchantProfileComplete: false,
    merchantStore: {
      category: 'beauty',
      serviceIds: ['beauty'],
      service_ids: ['beauty'],
      activeServiceId: 'beauty',
      active_service_id: 'beauty',
      primary_service_id: 'beauty',
      subCategoryId,
      sub_category_id: subCategoryId,
      serviceSubCategory: subCategoryId,
      service_sub_category: subCategoryId,
      isApproved: true,
      approvalStatus: 'approved',
      adminPreRegistered: true,
      name: fullName,
      store_name: fullName,
      description: description || undefined,
      address: address || undefined,
      phone: doctorPhone || phone || undefined,
      whatsapp: whatsapp || undefined,
      ...(subCategoryId === 'أطباء وعيادات' ? {
        specialty,
        specialties,
        workingDays: workingDays.length ? workingDays : undefined,
        doctorPhone: doctorPhone || undefined,
        clinicPhone: clinicPhone || undefined,
        profileImageUrl: profileImageUrl || undefined,
        clinicImageUrl: clinicImageUrl || undefined,
        openTime: openTime || undefined,
        closeTime: closeTime || undefined,
        ...doctorShiftFields,
        professionalInfo: {
          specialty,
          specialties,
          workingDays: workingDays.length ? workingDays : undefined,
          doctorPhone: doctorPhone || undefined,
          clinicPhone: clinicPhone || undefined,
          profileImageUrl: profileImageUrl || undefined,
          clinicImageUrl: clinicImageUrl || undefined,
          description: description || fullName,
          openTime: openTime || undefined,
          closeTime: closeTime || undefined,
          ...doctorShiftFields,
        },
      } : {
        phone: phone || undefined,
        profileImageUrl: profileImageUrl || undefined,
        clinicImageUrl: clinicImageUrl || undefined,
        openTime: openTime || undefined,
        closeTime: closeTime || undefined,
        ...doctorShiftFields,
        address: address || undefined,
        latitude: Number.isFinite(latitude) ? latitude : undefined,
        longitude: Number.isFinite(longitude) ? longitude : undefined,
        professionalInfo: {
          phone: phone || undefined,
          whatsapp: whatsapp || undefined,
          address: address || undefined,
          latitude: Number.isFinite(latitude) ? latitude : undefined,
          longitude: Number.isFinite(longitude) ? longitude : undefined,
          profileImageUrl: profileImageUrl || undefined,
          clinicImageUrl: clinicImageUrl || undefined,
          openTime: openTime || undefined,
          closeTime: closeTime || undefined,
          ...doctorShiftFields,
        },
      }),
    },
    adminPreRegisteredMerchant: true,
    adminPreRegisteredAt: nowIso(),
    adminPreRegisteredBy: adminPhone,
    multiRoleAccount: true,
  });

  return {
    success: true,
    phone: phoneKey,
    fullName,
    subCategoryId,
    storeName: fullName,
    isApproved: true,
    approvalStatus: 'approved',
    merchantProfileComplete: false,
  };
}

const DEFAULT_APP_UPDATE_POLICY = Object.freeze({
  minBuildNumber: 1,
  minVersionName: '1.0.0',
  forceUpdateEnabled: false,
  latestBuildNumber: 0,
  latestVersionName: '',
  publishedLatestBuildNumber: 0,
  publishedLatestVersionName: '',
  messageAr:
    'يتوفر إصدار أحدث من التطبيق في المتجر. يرجى التحديث للاستمرار.',
  optionalUpdateMessageAr:
    'يتوفر تحديث جديد للتطبيق في المتجر. ننصح بالتحديث للحصول على آخر التحسينات.',
  androidStoreUrl:
    'https://play.google.com/store/apps/details?id=com.alghaith.app',
  iosStoreUrl: 'https://apps.apple.com/app/id6776741811',
});

async function getPlatformSettingsState() {
  const row = await selectSingleByPhone('app_state', PLATFORM_SETTINGS_PHONE);
  return normalizeObject(row?.state);
}

async function savePlatformSettingsState(patch = {}) {
  const phoneKey = await resolvePhoneKey(PLATFORM_SETTINGS_PHONE);
  await ensureAppUser(phoneKey);
  const current = await getPlatformSettingsState();
  const next = { ...current, ...normalizeObject(patch) };
  await saveRow(
    'app_state',
    { phone: phoneKey, state: next, updated_at: nowIso() },
    'phone',
  );
  return next;
}

function readOptionalBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeHomeCategoryOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [categoryId, value] of Object.entries(raw)) {
    const id = String(categoryId || '').trim();
    if (!id) continue;

    if (typeof value === 'boolean') {
      out[id] = { default: value };
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const entry = {};
    for (const key of ['default', 'android', 'ios', 'web']) {
      const parsed = readOptionalBool(value[key]);
      if (parsed != null) entry[key] = parsed;
    }
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

function normalizeAppUpdatePolicy(raw = {}) {
  const source = normalizeObject(raw);
  const minBuildNumber = Number(
    source.minBuildNumber ?? source.min_build_number ?? DEFAULT_APP_UPDATE_POLICY.minBuildNumber,
  );
  const latestBuildNumber = Number(
    source.latestBuildNumber ??
      source.latest_build_number ??
      DEFAULT_APP_UPDATE_POLICY.latestBuildNumber,
  );

  return {
    minBuildNumber:
      Number.isFinite(minBuildNumber) && minBuildNumber >= 1
        ? Math.trunc(minBuildNumber)
        : DEFAULT_APP_UPDATE_POLICY.minBuildNumber,
    minVersionName:
      String(
        source.minVersionName ??
          source.min_version_name ??
          DEFAULT_APP_UPDATE_POLICY.minVersionName,
      ).trim() || DEFAULT_APP_UPDATE_POLICY.minVersionName,
    forceUpdateEnabled:
      source.forceUpdateEnabled === true || source.force_update_enabled === true,
    latestBuildNumber:
      Number.isFinite(latestBuildNumber) && latestBuildNumber >= 0
        ? Math.trunc(latestBuildNumber)
        : DEFAULT_APP_UPDATE_POLICY.latestBuildNumber,
    latestVersionName: String(
      source.latestVersionName ??
        source.latest_version_name ??
        DEFAULT_APP_UPDATE_POLICY.latestVersionName,
    ).trim(),
    publishedLatestBuildNumber: (() => {
      const raw = Number(
        source.publishedLatestBuildNumber ??
          source.published_latest_build_number ??
          source.latestBuildNumber ??
          source.latest_build_number ??
          0,
      );
      return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
    })(),
    publishedLatestVersionName: String(
      source.publishedLatestVersionName ??
        source.published_latest_version_name ??
        source.latestVersionName ??
        source.latest_version_name ??
        '',
    ).trim(),
    messageAr:
      String(
        source.messageAr ?? source.message_ar ?? DEFAULT_APP_UPDATE_POLICY.messageAr,
      ).trim() || DEFAULT_APP_UPDATE_POLICY.messageAr,
    optionalUpdateMessageAr:
      String(
        source.optionalUpdateMessageAr ??
          source.optional_update_message_ar ??
          DEFAULT_APP_UPDATE_POLICY.optionalUpdateMessageAr,
      ).trim() || DEFAULT_APP_UPDATE_POLICY.optionalUpdateMessageAr,
    androidStoreUrl:
      String(
        source.androidStoreUrl ??
          source.android_store_url ??
          DEFAULT_APP_UPDATE_POLICY.androidStoreUrl,
      ).trim() || DEFAULT_APP_UPDATE_POLICY.androidStoreUrl,
    iosStoreUrl:
      String(
        source.iosStoreUrl ??
          source.ios_store_url ??
          DEFAULT_APP_UPDATE_POLICY.iosStoreUrl,
      ).trim() || DEFAULT_APP_UPDATE_POLICY.iosStoreUrl,
  };
}

async function getHomeCategoriesConfig() {
  const state = await getPlatformSettingsState();
  const stored = normalizeObject(
    state.homeCategories || state.home_category_overrides || {},
  );
  const overrides = normalizeHomeCategoryOverrides(stored.overrides || stored);
  const updatedAt =
    stored.updatedAt ||
    stored.updated_at ||
    state.homeCategoriesUpdatedAt ||
    null;
  return { overrides, updatedAt };
}

async function saveAdminHomeCategoriesConfig(phone, overrides) {
  await assertAdminAccess(phone);
  const normalized = normalizeHomeCategoryOverrides(overrides);
  const updatedAt = nowIso();
  await savePlatformSettingsState({
    homeCategories: {
      overrides: normalized,
      updatedAt,
    },
    homeCategoriesUpdatedAt: updatedAt,
  });
  try {
    const { invalidateCache } = require('../lib/response_cache');
    if (typeof invalidateCache === 'function') invalidateCache('app:home-categories');
  } catch (_) {}
  try {
    const { scheduleEdgeSnapshotPublish } = require('../lib/edge_snapshots');
    scheduleEdgeSnapshotPublish();
  } catch (_) {}
  return { overrides: normalized, updatedAt };
}

async function getAppUpdatePolicy() {
  const state = await getPlatformSettingsState();
  const stored = normalizeObject(
    state.appUpdatePolicy || state.app_update_policy || {},
  );
  const { updatedAt, updated_at: updatedAtSnake, ...policyFields } = stored;
  const policy = normalizeAppUpdatePolicy({
    ...DEFAULT_APP_UPDATE_POLICY,
    ...policyFields,
  });
  return {
    ...policy,
    updatedAt:
      updatedAt ||
      updatedAtSnake ||
      state.appUpdatePolicyUpdatedAt ||
      null,
  };
}

async function saveAdminAppUpdatePolicy(phone, patch = {}) {
  await assertAdminAccess(phone);
  const current = await getAppUpdatePolicy();
  const { updatedAt: _ignored, ...currentPolicy } = current;
  const policy = normalizeAppUpdatePolicy({ ...currentPolicy, ...patch });
  const updatedAt = nowIso();
  await savePlatformSettingsState({
    appUpdatePolicy: {
      ...policy,
      updatedAt,
    },
    appUpdatePolicyUpdatedAt: updatedAt,
  });
  return { ...policy, updatedAt };
}

async function getLiveStoreVersionsForAdmin() {
  const { fetchStoreVersions } = require('../lib/store_version_lookup');
  return fetchStoreVersions();
}

async function publishAppUpdateFromStore(phone, body = {}) {
  await assertAdminAccess(phone);
  const platform = String(body.platform || 'android').trim().toLowerCase();
  const { fetchStoreVersions } = require('../lib/store_version_lookup');
  const live = await fetchStoreVersions();
  const picked =
    platform === 'ios'
      ? live.ios
      : platform === 'android'
        ? live.android
        : live.android || live.ios;
  if (!picked?.version) {
    throw new Error('تعذّر قراءة الإصدار من المتجر. تأكد أن التحديث مُتاح للمستخدمين بعد موافقة المتجر.');
  }

  const buildNumber = Number(body.buildNumber ?? body.build_number ?? 0);
  const patch = {
    publishedLatestVersionName: picked.version,
    latestVersionName: picked.version,
  };
  if (Number.isFinite(buildNumber) && buildNumber > 0) {
    patch.publishedLatestBuildNumber = Math.trunc(buildNumber);
    patch.latestBuildNumber = Math.trunc(buildNumber);
  }

  const policy = await saveAdminAppUpdatePolicy(phone, patch);
  return {
    policy,
    store: picked,
  };
}

const DEFAULT_MAINTENANCE_POLICY = Object.freeze({
  enabled: false,
  targetPlatform: 'all',
  messageAr:
    'المنصة قيد الصيانة حالياً. نعمل على تحسين الخدمة ونعود قريباً. شكراً لصبركم.',
  messageEn: 'The platform is under maintenance. We will be back soon.',
  allowAdminBypass: true,
});

function normalizeMaintenanceTargetPlatform(raw) {
  const value = String(raw ?? 'all').trim().toLowerCase();
  if (value === 'android' || value === 'ios') return value;
  return 'all';
}

function normalizeMaintenancePolicy(raw = {}) {
  const source = normalizeObject(raw);
  return {
    enabled: source.enabled === true || source.enabled === 'true' || source.enabled === 1,
    targetPlatform: normalizeMaintenanceTargetPlatform(
      source.targetPlatform ?? source.target_platform
    ),
    messageAr: String(
      source.messageAr ?? source.message_ar ?? DEFAULT_MAINTENANCE_POLICY.messageAr,
    ).trim() || DEFAULT_MAINTENANCE_POLICY.messageAr,
    messageEn: String(
      source.messageEn ?? source.message_en ?? DEFAULT_MAINTENANCE_POLICY.messageEn,
    ).trim() || DEFAULT_MAINTENANCE_POLICY.messageEn,
    allowAdminBypass:
      source.allowAdminBypass !== false &&
      source.allow_admin_bypass !== false &&
      source.allowAdminBypass !== 'false' &&
      source.allow_admin_bypass !== 'false',
  };
}

async function getMaintenancePolicy() {
  const state = await getPlatformSettingsState();
  const stored = normalizeObject(
    state.maintenancePolicy || state.maintenance_policy || {},
  );
  const { updatedAt, updated_at: updatedAtSnake, ...policyFields } = stored;
  const policy = normalizeMaintenancePolicy({
    ...DEFAULT_MAINTENANCE_POLICY,
    ...policyFields,
  });
  return {
    ...policy,
    updatedAt:
      updatedAt ||
      updatedAtSnake ||
      state.maintenancePolicyUpdatedAt ||
      null,
  };
}

async function saveAdminMaintenancePolicy(phone, patch = {}) {
  await assertAdminAccess(phone);
  const current = await getMaintenancePolicy();
  const wasEnabled = current.enabled === true;
  const { updatedAt: _ignored, ...currentPolicy } = current;
  const policy = normalizeMaintenancePolicy({ ...currentPolicy, ...patch });
  const updatedAt = nowIso();
  await savePlatformSettingsState({
    maintenancePolicy: {
      ...policy,
      updatedAt,
    },
    maintenancePolicyUpdatedAt: updatedAt,
  });

  try {
    const { invalidateCache } = require('../lib/response_cache');
    if (typeof invalidateCache === 'function') {
      invalidateCache('app:maintenance-policy');
    }
  } catch (_) {
    /* ignore cache errors */
  }

  let notification = null;
  const enabledChanged = wasEnabled !== policy.enabled;
  if (enabledChanged) {
    try {
      const { broadcastAdminUserMessage } = require('./user_notifications');
      if (policy.enabled) {
        const notifyPlatform =
          policy.targetPlatform === 'android' || policy.targetPlatform === 'ios'
            ? policy.targetPlatform
            : 'all';
        notification = await broadcastAdminUserMessage(phone, {
          title: 'طلب — صيانة مؤقتة',
          body:
            String(policy.messageAr || '').trim() ||
            'التطبيق قيد الصيانة حالياً. نعمل على حل المشكلة ونعود قريباً.',
          audience: 'all',
          platform: notifyPlatform,
        });
      } else {
        notification = await broadcastAdminUserMessage(phone, {
          title: 'طلب — عودة الخدمة',
          body: 'التطبيق عاد للخدمة ويمكنكم استخدامه الآن. شكراً لصبركم.',
          audience: 'all',
          platform: 'all',
        });
      }
    } catch (notifyError) {
      console.error(
        'maintenance notify broadcast error:',
        notifyError?.message || notifyError,
      );
      notification = {
        error: String(notifyError?.message || notifyError || 'notify_failed'),
      };
    }
  }

  return { ...policy, updatedAt, notification, enabledChanged };
}

async function getPendingProductsForAdmin(adminPhone, filters = {}) {
  await assertAdminAccess(adminPhone);

  const categoryFilter = String(filters.category || '').trim();
  const products = await selectMany(
    'merchant_products',
    [],
    { column: 'created_at', ascending: false },
    3000
  );

  // ادمج إعلانات customer_listings المعلقة فوق كل merchant_products
  // دون استبعاد السيارات/المطاعم/التسوق (mergeListingRows مخصّص لكتالوج الزبون فقط).
  let merged = products;
  try {
    const { listPendingCustomerListings } = require('./customer_listings');
    const pendingListings = await listPendingCustomerListings(
      categoryFilter || null,
    );
    if (Array.isArray(pendingListings) && pendingListings.length > 0) {
      const byId = new Map();
      for (const row of products || []) {
        const id = String(row?.id || '').trim();
        if (id) byId.set(id, row);
      }
      for (const row of pendingListings) {
        const id = String(row?.id || '').trim();
        if (id) byId.set(id, row);
      }
      merged = [...byId.values()];
    }
  } catch (error) {
    console.warn('getPendingProductsForAdmin listings merge:', error?.message || error);
  }

  const pending = merged.filter((row) => productApprovalStatus(row) === 'pending');
  const scoped = categoryFilter
    ? pending.filter((row) => String(row.category || '').trim() === categoryFilter)
    : pending;

  const phones = [...new Set(scoped.map((row) => String(row.phone || '').trim()).filter(Boolean))];
  const profileByPhone = new Map();
  for (const phone of phones) {
    const profile = await getMerchantProfile(phone);
    if (profile) profileByPhone.set(phone, profile);
  }

  return scoped.map((row) => {
    const phone = String(row.phone || '').trim();
    const profile = profileByPhone.get(phone) || null;
    const serialized = serializeProductRowForClient(row);
    const sections = normalizeArray(
      profile?.product_sections ?? profile?.productSections,
    )
      .map((section) => ({
        id: String(section?.id ?? '').trim(),
        nameAr: String(section?.name_ar ?? section?.nameAr ?? '').trim(),
        sortOrder: Number(section?.sort_order ?? section?.sortOrder ?? 0) || 0,
      }))
      .filter((section) => section.id && section.nameAr);
    return {
      ...serialized,
      isApproved: isProductApproved(row),
      is_approved: isProductApproved(row),
      approvalStatus: productApprovalStatus(row),
      approval_status: productApprovalStatus(row),
      merchantPhone: phone,
      merchantStoreName: merchantProfileDisplayName(profile),
      merchantCategory: String(profile?.primary_service_id || profile?.primaryServiceId || '').trim(),
      rejectionMessageAr: String(row.rejection_message_ar || '').trim(),
      productSections: sections,
      sectionId: String(row.section_id || row.sectionId || '').trim(),
    };
  });
}

async function invalidateMarketplaceCatalogCaches() {
  try {
    const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
    await invalidateCachePrefix('marketplace:real-estate-listings:');
    invalidateCache('marketplace:offer-catalog-products');
    invalidateCache('marketplace:stats');
  } catch (_) {
    // ignore cache errors — approval/placement already persisted
  }
  try {
    const { scheduleEdgeSnapshotPublish } = require('../lib/edge_snapshots');
    scheduleEdgeSnapshotPublish();
  } catch (_) {
    // ignore missing R2 / snapshot config
  }
}

async function applyProductPlacementPatch(existing, placement = {}) {
  const patch = {};
  const hasPlacement =
    placement.category !== undefined ||
    placement.subCategory !== undefined ||
    placement.sub_category !== undefined ||
    placement.sectionId !== undefined ||
    placement.section_id !== undefined ||
    placement.listingMode !== undefined ||
    placement.listing_mode !== undefined;

  if (!hasPlacement) return patch;

  if (placement.category !== undefined) {
    const category = String(placement.category || '').trim();
    if (!category) {
      throw new Error('category is required when updating product placement.');
    }
    if (await hasColumn('merchant_products', 'category')) {
      patch.category = category;
    }
    if (await hasColumn('merchant_products', 'service_id')) {
      patch.service_id = category;
    }
  }

  if (
    placement.subCategory !== undefined ||
    placement.sub_category !== undefined
  ) {
    const subCategory = String(
      placement.subCategory ?? placement.sub_category ?? '',
    ).trim();
    if (await hasColumn('merchant_products', 'sub_category')) {
      patch.sub_category = subCategory || null;
    }
  }

  if (
    placement.sectionId !== undefined ||
    placement.section_id !== undefined
  ) {
    const sectionId = String(
      placement.sectionId ?? placement.section_id ?? '',
    ).trim();
    if (await hasColumn('merchant_products', 'section_id')) {
      patch.section_id = sectionId || null;
    }
  }

  if (
    placement.listingMode !== undefined ||
    placement.listing_mode !== undefined
  ) {
    const listingMode = String(
      placement.listingMode ?? placement.listing_mode ?? '',
    ).trim();
    if (await hasColumn('merchant_products', 'listing_mode')) {
      // لا تمسح listing_mode عند إرسال قيمة فارغة من واجهة الموافقة
      // (كانت تُسقط customer_car / customer_car_request فتختفي من الكتالوج).
      if (listingMode) {
        patch.listing_mode = listingMode;
      }
    }
  }

  if (await hasColumn('merchant_products', 'updated_at')) {
    patch.updated_at = nowIso();
  }

  return patch;
}

async function updateProductPlacement(
  adminPhone,
  merchantPhone,
  productId,
  placement = {},
) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(merchantPhone);
  const id = String(productId || '').trim();
  if (!id) throw new Error('productId is required.');

  const existing = await selectSingle('merchant_products', 'id', id);
  if (!existing) throw new Error('Product not found.');

  const existingPhone = String(existing.phone || '').trim();
  if (
    !phonesOverlap(existingPhone, phoneKey) &&
    !phonesOverlap(existingPhone, merchantPhone)
  ) {
    throw new Error('Product does not belong to this merchant.');
  }

  const patch = await applyProductPlacementPatch(existing, placement);
  if (Object.keys(patch).length === 0) {
    throw new Error('No placement fields provided.');
  }

  // Admin reclassification must not reset approval status.
  const saved = await updateRow('merchant_products', 'id', id, patch);
  if (!saved) throw new Error('Failed to update product placement.');
  await invalidateMarketplaceCatalogCaches();
  return serializeProductRowForClient(saved);
}

/** @deprecated Use updateProductPlacement — kept for older callers. */
async function updatePendingProductPlacement(
  adminPhone,
  merchantPhone,
  productId,
  placement = {},
) {
  return updateProductPlacement(adminPhone, merchantPhone, productId, placement);
}

async function toggleProductApprovalStatus(
  adminPhone,
  merchantPhone,
  productId,
  isApproved,
  rejectionMessageAr = '',
  placement = {},
) {
  await assertAdminAccess(adminPhone);

  const phoneKey = await resolvePhoneKey(merchantPhone);
  const id = String(productId || '').trim();
  if (!id) throw new Error('productId is required.');

  let existing = await selectSingle('merchant_products', 'id', id);
  let fromCustomerListings = false;
  if (!existing) {
    try {
      const { getCustomerListingById } = require('./customer_listings');
      const listing = await getCustomerListingById(id);
      if (listing) {
        existing = { ...listing, phone: listing.owner_phone || listing.phone };
        fromCustomerListings = true;
      }
    } catch (_) {}
  }
  if (!existing) throw new Error('Product not found.');

  const existingPhone = String(existing.phone || existing.owner_phone || '').trim();
  if (
    !phonesOverlap(existingPhone, phoneKey) &&
    !phonesOverlap(existingPhone, merchantPhone)
  ) {
    throw new Error('Product does not belong to this merchant.');
  }

  const approved = Boolean(isApproved);
  const patch = await applyProductPlacementPatch(existing, placement);

  if (await hasColumn('merchant_products', 'updated_at')) {
    patch.updated_at = nowIso();
  }
  if (await hasColumn('merchant_products', 'is_approved')) {
    patch.is_approved = approved;
  }
  if (await hasColumn('merchant_products', 'approval_status')) {
    patch.approval_status = approved ? 'approved' : 'rejected';
  }
  if (await hasColumn('merchant_products', 'rejection_message_ar')) {
    patch.rejection_message_ar = approved
      ? null
      : String(rejectionMessageAr || 'تم رفض المحتوى من الإدارة.').trim();
  }
  if (await hasColumn('merchant_products', 'rejected_at')) {
    patch.rejected_at = approved ? null : nowIso();
  }

  if (
    patch.is_approved === undefined &&
    patch.approval_status === undefined
  ) {
    throw new Error('Product approval columns are missing in the database.');
  }

  if (approved) {
    try {
      const { applyOfferApprovalWindow } = require('./customer_offers');
      await applyOfferApprovalWindow(existing, patch);
    } catch (error) {
      console.error('applyOfferApprovalWindow error:', error?.message || error);
    }
    try {
      const { applyUsedApprovalWindow } = require('./customer_used');
      await applyUsedApprovalWindow(existing, patch);
    } catch (error) {
      console.error('applyUsedApprovalWindow error:', error?.message || error);
    }
  }

  let saved = null;
  if (!fromCustomerListings) {
    saved = await updateRow('merchant_products', 'id', id, patch);
  }
  try {
    const { updateCustomerListingApproval } = require('./customer_listings');
    const listingSaved = await updateCustomerListingApproval(id, {
      is_approved: approved,
      approval_status: approved ? 'approved' : 'rejected',
      rejection_message_ar: approved
        ? null
        : String(rejectionMessageAr || 'تم رفض المحتوى من الإدارة.').trim(),
      rejected_at: approved ? null : nowIso(),
      available_until: patch.available_until,
      category: patch.category,
      sub_category: patch.sub_category,
      listing_mode: patch.listing_mode,
      updated_at: nowIso(),
    });
    if (listingSaved) saved = { ...existing, ...listingSaved, phone: existingPhone };
  } catch (error) {
    console.warn('updateCustomerListingApproval:', error?.message || error);
  }
  if (!saved) throw new Error('Failed to update product approval.');
  await invalidateMarketplaceCatalogCaches();
  const productName = String(existing.name_ar ?? existing.nameAr ?? '').trim();

  try {
    if (approved) {
      const { onProductApproved } = require('../push_events');
      await onProductApproved(phoneKey, productName);
    } else {
      const { onProductRejected } = require('../push_events');
      await onProductRejected(
        phoneKey,
        String(rejectionMessageAr || 'تم رفض المحتوى من الإدارة.').trim(),
        productName
      );
    }
  } catch (error) {
    console.error('push product approval error:', error?.message || error);
  }

  return {
    success: true,
    product: serializeProductRowForClient(saved),
  };
}

const ACCOUNT_APPROVAL_SERVICES = new Set([
  'professionals',
  'tourism',
  'beauty',
  'pharmacy',
]);

function merchantAccountApprovalRequiredSummary(merchant) {
  if (merchant?.accountApprovalRequired === false) return false;
  if (merchant?.accountApprovalRequired === true) return true;
  const primary = String(
    merchant?.primaryServiceId || merchant?.primary_service_id || ''
  ).trim();
  if (ACCOUNT_APPROVAL_SERVICES.has(primary)) return true;
  const serviceIds = merchant?.serviceIds || merchant?.service_ids || [];
  if (!Array.isArray(serviceIds)) return false;
  return serviceIds.some((id) =>
    ACCOUNT_APPROVAL_SERVICES.has(String(id || '').trim())
  );
}

function isMerchantAccountPendingSummary(merchant) {
  if (!merchantAccountApprovalRequiredSummary(merchant)) return false;
  const status = String(
    merchant?.approvalStatus || merchant?.approval_status || ''
  ).trim();
  const approved =
    merchant?.isApproved === true || merchant?.is_approved === true;
  return status === 'pending' || (!approved && status !== 'rejected');
}

function isHealthBeautyMerchantSummary(merchant) {
  const primary = String(
    merchant?.primaryServiceId || merchant?.primary_service_id || ''
  ).trim();
  if (primary === 'beauty' || primary === 'pharmacy') return true;
  const sub = String(
    merchant?.serviceSubCategory || merchant?.service_sub_category || ''
  ).trim();
  return ['صيدلية', 'أطباء وعيادات', 'مختبرات طبية', 'صالون رجالي', 'صالون نسائي'].includes(sub);
}

function isOperatorPendingSummary(row) {
  const status = String(row?.approvalStatus || row?.approval_status || '').trim();
  const approved = row?.isApproved === true || row?.is_approved === true;
  return status === 'pending' || (!approved && status !== 'rejected');
}

function buildEmptyModerationPendingSummary(extra = {}) {
  return {
    total: 0,
    counts: {
      products: 0,
      realEstate: 0,
      cars: 0,
      used: 0,
      accounts: 0,
      tourism: 0,
      healthBeauty: 0,
      professionals: 0,
      drivers: 0,
      couriers: 0,
    },
    signature: '',
    items: [],
    checkedAt: nowIso(),
    deferred: false,
    degraded: false,
    ...extra,
  };
}

/**
 * ملخص موافقات خفيف: عدّادات head + عيّنة منتجات معلّقة فقط.
 * لا يجلب كل التجار/السائقين/المناديب في كل استطلاع.
 */
async function loadModerationPendingSummaryLite() {
  const supabase = assertSupabaseAdmin();
  const softCount = async (label, build) => {
    try {
      const { count, error } = await Promise.race([
        build(supabase),
        new Promise((resolve) =>
          setTimeout(() => resolve({ count: 0, error: { message: 'mod_timeout' } }), 2500),
        ),
      ]);
      if (error) {
        console.warn(`moderation summary ${label}:`, error.message || error);
        return 0;
      }
      return Number(count) || 0;
    } catch (error) {
      console.warn(`moderation summary ${label}:`, error?.message || error);
      return 0;
    }
  };

  const softSelect = async (label, build) => {
    try {
      const { data, error } = await Promise.race([
        build(supabase),
        new Promise((resolve) =>
          setTimeout(() => resolve({ data: [], error: { message: 'mod_timeout' } }), 2500),
        ),
      ]);
      if (error) {
        console.warn(`moderation summary ${label}:`, error.message || error);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.warn(`moderation summary ${label}:`, error?.message || error);
      return [];
    }
  };

  const [
    pendingProducts,
    productsCount,
    realEstateCount,
    carsCount,
    usedCount,
    merchantPending,
    professionalPending,
    driverPending,
    courierPending,
  ] = await Promise.all([
    softSelect('pendingProducts', (sb) =>
      sb
        .from('merchant_products')
        .select('id,phone,name_ar,category,approval_status,is_approved,created_at')
        .eq('approval_status', 'pending')
        .order('created_at', { ascending: false })
        .limit(40),
    ),
    softCount('products', (sb) =>
      sb
        .from('merchant_products')
        .select('*', { count: 'exact', head: true })
        .eq('approval_status', 'pending'),
    ),
    softCount('realEstate', (sb) =>
      sb
        .from('merchant_products')
        .select('*', { count: 'exact', head: true })
        .eq('category', 'real_estate')
        .eq('approval_status', 'pending'),
    ),
    softCount('cars', (sb) =>
      sb
        .from('merchant_products')
        .select('*', { count: 'exact', head: true })
        .eq('category', 'cars')
        .eq('approval_status', 'pending'),
    ),
    softCount('used', (sb) =>
      sb
        .from('merchant_products')
        .select('*', { count: 'exact', head: true })
        .eq('category', 'used')
        .eq('approval_status', 'pending'),
    ),
    softCount('merchants', (sb) =>
      sb
        .from('merchant_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('approval_status', 'pending'),
    ),
    softCount('professionals', (sb) =>
      sb
        .from('merchant_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('primary_service_id', 'professionals')
        .eq('approval_status', 'pending'),
    ),
    softCount('drivers', (sb) =>
      sb
        .from('driver_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('approval_status', 'pending'),
    ),
    softCount('couriers', (sb) =>
      sb
        .from('courier_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('approval_status', 'pending'),
    ),
  ]);

  const items = [];
  for (const product of pendingProducts) {
    if (productApprovalStatus(product) !== 'pending') continue;
    const id = String(product.id || '').trim();
    if (!id) continue;
    const category = String(product.category || '').trim();
    let reviewPath = '/admin/moderation/products';
    if (category === 'real_estate') reviewPath = '/admin/moderation/real-estate';
    else if (category === 'cars') reviewPath = '/admin/moderation/cars';
    else if (category === 'used') reviewPath = '/admin/moderation/used';
    const name = String(product.name_ar || product.name || 'محتوى جديد').trim();
    items.push({
      key: `product:${id}`,
      type: 'product',
      label: name,
      reviewPath,
    });
  }

  const counts = {
    products: Math.max(
      0,
      productsCount - realEstateCount - carsCount - usedCount,
    ),
    realEstate: realEstateCount,
    cars: carsCount,
    used: usedCount,
    accounts: Math.max(0, merchantPending - professionalPending),
    tourism: 0,
    healthBeauty: 0,
    professionals: professionalPending,
    drivers: driverPending,
    couriers: courierPending,
  };

  const total =
    counts.products +
    counts.realEstate +
    counts.cars +
    counts.used +
    counts.accounts +
    counts.professionals +
    counts.drivers +
    counts.couriers;

  const signature = [
    `p${counts.products}`,
    `re${counts.realEstate}`,
    `c${counts.cars}`,
    `u${counts.used}`,
    `a${counts.accounts}`,
    `pro${counts.professionals}`,
    `d${counts.drivers}`,
    `co${counts.couriers}`,
    ...items.map((item) => item.key).sort(),
  ].join('|');

  return {
    total,
    counts,
    signature,
    items,
    checkedAt: nowIso(),
    deferred: false,
    degraded: false,
    lite: true,
  };
}

async function getModerationPendingSummary(adminPhone) {
  await assertAdminAccess(adminPhone);
  const { isDbCircuitOpen, beginAdminPriority } = require('../lib/db_circuit');
  const {
    getCached,
    getLastGood,
    rememberAdmin,
    DEFAULT_TTLS,
  } = require('../lib/response_cache');
  beginAdminPriority();

  const cacheKey = 'admin:moderation-pending-summary';
  if (isDbCircuitOpen()) {
    const cached = await getCached(cacheKey);
    if (cached?.value) {
      return { ...cached.value, cacheHit: true, deferred: false, degraded: true };
    }
    const lastGood = await getLastGood(cacheKey);
    if (lastGood?.value) {
      return {
        ...lastGood.value,
        cacheHit: true,
        stale: true,
        deferred: false,
        degraded: true,
      };
    }
    return buildEmptyModerationPendingSummary({
      deferred: true,
      degraded: true,
      reason: 'db_circuit_open',
    });
  }

  const result = await rememberAdmin(
    cacheKey,
    DEFAULT_TTLS.adminModerationSummary,
    loadModerationPendingSummaryLite,
  );
  return result.value;
}

module.exports = {
  getAdminReports,
  getAdminReportsLite,
  getAllMerchants,
  getAllProfessionals,
  getAllCouriers,
  getAllDrivers,
  getAdminMerchantDetails,
  getAdminProfessionalDetails,
  toggleBazaarMemberStatus,
  toggleCourierApprovalStatus,
  rejectCourierApplication,
  toggleMerchantApprovalStatus,
  rejectMerchantApplication,
  toggleMerchantFreezeStatus,
  updateAccountRole,
  isProtectedAdminAccount,
  toggleDriverApprovalStatus,
  rejectDriverApplication,
  resolveAccountApproval,
  classifyAdminAccountKind,
  accountDisplayName,
  resolveAccountSuspended,
  mapAdminAccountSummary,
  resolveRejectionMessage,
  getAllAdminAccounts,
  purgeAccountData,
  adminDeleteAccount,
  deleteDriverAccount,
  adminSuspendAccount,
  isPlatformAdminPhone,
  ensurePlatformAdminAccess,
  assertPlatformAdminAccess,
  preRegisterMerchantAccount,
  updateMerchantCategoryByAdmin,
  updateProfessionalCategoryByAdmin,
  preRegisterCustomerAccount,
  preRegisterDriverAccount,
  preRegisterCourierAccount,
  preRegisterProfessionalAccount,
  preRegisterBeautyAccount,
  updateMerchantProfileByAdmin,
  getProfessionalCategoriesConfig,
  saveAdminProfessionalCategoriesConfig,
  getHomeCategoriesConfig,
  saveAdminHomeCategoriesConfig,
  getAppUpdatePolicy,
  saveAdminAppUpdatePolicy,
  getLiveStoreVersionsForAdmin,
  publishAppUpdateFromStore,
  getMaintenancePolicy,
  saveAdminMaintenancePolicy,
  getPendingProductsForAdmin,
  updateProductPlacement,
  updatePendingProductPlacement,
  getModerationPendingSummary,
  toggleProductApprovalStatus,
  mapAdminProductRow,
};
