const { v4: uuidv4 } = require('uuid');
const {
  nowIso,
  normalizeObject,
  getPhoneVariants,
  canonicalPhone,
  phonesOverlap,
  resolvePhoneKey,
  selectSingle,
  selectSingleByPhone,
  selectMany,
  hasColumn,
  saveRow,
  updateRow,
  assertSupabaseAdmin,
  PLATFORM_ADMIN_PHONES,
} = require('../../../supabase_repo/common');

function firstValidCoord(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && Math.abs(n) > 0.0001) return n;
  }
  return 0;
}

function isPlatformAdminCustomerPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return false;
  return PLATFORM_ADMIN_PHONES.some((adminPhone) => phonesOverlap(raw, adminPhone));
}
const { ensureAppUser, getUserState, getAppUser } = require('../../../supabase_repo/users');
const {
  calculateFare,
  normalizeTaxiType,
  isEconomicOnlyDistance,
  isAllowedOnLongDistance,
} = require('../../../services/taxi_pricing_service');
const driverLocations = require('./driver_locations');
const { acquireLock, releaseLock } = require('../../../lib/redis_client');
const {
  usesExpandingTaxiSearch,
  matchingWaveIndex,
  matchingRadiusKm,
} = require('../../../lib/expanding_search_radius');
const {
  PRIORITY_EXCLUSIVE_MS,
  getPriorityCaptainPhone,
  getPriorityCaptainPhones,
  isPriorityCaptainPhone,
  usesEconomicPriorityWindow,
  priorityExclusiveUntilIso,
  isInEconomicPriorityWindow,
} = require('../../../lib/taxi_priority_captain');

/**
 * نوع مركبة الكابتن من الملف — لا تخلط مع عمود driver_type='taxi' (نوع الخدمة).
 */
function resolveDriverVehicleTaxiType(row = {}, payloadOverride = null) {
  const payload =
    payloadOverride && typeof payloadOverride === 'object'
      ? payloadOverride
      : typeof row.profile_payload === 'object' && row.profile_payload
        ? row.profile_payload
        : {};
  const fromPayload = String(payload.taxiType || payload.taxi_type || '').trim();
  if (fromPayload) return normalizeTaxiType(fromPayload);

  const rawColumn = String(row.driver_type || row.taxi_type || '').trim().toLowerCase();
  // 'taxi' / 'delivery' = فئة خدمة وليست نوع مركبة.
  if (rawColumn && rawColumn !== 'taxi' && rawColumn !== 'delivery' && rawColumn !== 'courier') {
    return normalizeTaxiType(rawColumn);
  }
  return 'economic';
}

/** اسم عام للكابتن: الاسم الأول + الأب فقط. */
function shortPublicCustomerName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1]}`;
}

async function resolveCustomerPublicIdentity(phone, fallbackName = '') {
  const fromFallback = shortPublicCustomerName(fallbackName);
  let name = fromFallback;
  let photo = null;
  try {
    const user = await getAppUser(phone);
    if (!name) {
      name = shortPublicCustomerName(user?.full_name);
    }
    photo = String(user?.avatar_url || user?.avatarUrl || '').trim() || null;
  } catch (_) {}
  return { name: name || '', photo };
}

// ── دوال مساعدة ──────────────────────────────────────────────────

/**
 * قراءة البيانات من request_payload
 */
function readTaxiMeta(row) {
  const payload = normalizeObject(row.request_payload);
  let statusKey = String(row.status_key ?? payload.statusKey ?? 'pending').trim();
  // تطبيع حالة قديمة كانت تترك الرحلة عالقة بلا زر إكمال.
  if (statusKey === 'in_progress') statusKey = 'picked_up';
  return {
    row,
    payload,
    id: String(row.id ?? payload.id ?? '').trim(),
    customerPhone: String(row.phone ?? payload.customerPhone ?? '').trim(),
    driverPhone: String(row.driver_phone ?? payload.driverPhone ?? '').trim(),
    statusKey,
    taxiType: String(payload.taxiType ?? 'economic').trim(),
    pickupAddress: String(payload.pickupAddress ?? '').trim(),
    dropoffAddress: String(payload.dropoffAddress ?? '').trim(),
    pickupLat: firstValidCoord(payload.pickupLat, payload.pickup_lat, row.pickup_lat),
    pickupLng: firstValidCoord(payload.pickupLng, payload.pickup_lng, row.pickup_lng),
    dropoffLat: firstValidCoord(payload.dropoffLat, payload.dropoff_lat, row.dropoff_lat),
    dropoffLng: firstValidCoord(payload.dropoffLng, payload.dropoff_lng, row.dropoff_lng),
    distanceKm: Number(payload.distanceKm ?? 0),
    fare: Number(payload.fare ?? 0),
    fareEconomic: Number(payload.fareEconomic ?? 0),
    fareSuper: Number(payload.fareSuper ?? 0),
    tripType: String(payload.tripType || 'one_way').trim(),
    waitingMinutes: payload.waitingMinutes ? Number(payload.waitingMinutes) : null,
    createdAt: row.created_at ?? payload.createdAt ?? null,
  };
}

function formatTaxiRequestForClient(row) {
  if (!row) return null;
  const meta = readTaxiMeta(row);
  // سجل إشعارات الكباتن للإدارة فقط — لا يُعاد للزبون/الكابتن.
  const { driverPushAudit: _driverPushAudit, ...payload } = meta.payload;
  const vehicleInfo = String(row.vehicle_info ?? payload.driverVehicleInfo ?? '').trim();
  let vehicleModel = String(payload.vehicleModel ?? '').trim();
  let plateNumber = String(payload.plateNumber ?? '').trim();
  if ((!vehicleModel || !plateNumber) && vehicleInfo.includes(' / ')) {
    const parts = vehicleInfo.split(' / ').map((p) => p.trim()).filter(Boolean);
    if (!vehicleModel && parts.length > 0) vehicleModel = parts[0];
    if (!plateNumber && parts.length > 1) plateNumber = parts[parts.length - 1];
  } else if (!vehicleModel && vehicleInfo) {
    vehicleModel = vehicleInfo;
  }

  return {
    ...payload,
    id: meta.id,
    statusKey: meta.statusKey,
    statusAr: payload.statusAr || 'بانتظار سائق',
    customerPhone: meta.customerPhone || payload.customerPhone || '',
    driverPhone: meta.driverPhone || payload.driverPhone || '',
    customerName: shortPublicCustomerName(
      payload.customerName || payload.customerFullName || ''
    ),
    customerPhoto: String(payload.customerPhoto || '').trim() || null,
    driverName: String(row.driver_name ?? payload.driverName ?? '').trim(),
    driverVehicleInfo: vehicleInfo || null,
    vehicleModel: vehicleModel || null,
    plateNumber: plateNumber || null,
    carImage: String(payload.carImage ?? '').trim() || null,
    taxiType: meta.taxiType || payload.taxiType || 'economic',
    fare: meta.fare || Number(row.fare ?? payload.fare ?? 0),
    fareEconomic: meta.fareEconomic || Number(row.fare_economic ?? payload.fareEconomic ?? 0),
    fareSuper: meta.fareSuper || Number(row.fare_super ?? payload.fareSuper ?? 0),
    pickupAddress: meta.pickupAddress || payload.pickupAddress || '',
    dropoffAddress: meta.dropoffAddress || payload.dropoffAddress || '',
    pickupLat: meta.pickupLat || payload.pickupLat || 0,
    pickupLng: meta.pickupLng || payload.pickupLng || 0,
    dropoffLat: meta.dropoffLat || payload.dropoffLat || 0,
    dropoffLng: meta.dropoffLng || payload.dropoffLng || 0,
    distanceKm: meta.distanceKm || payload.distanceKm || 0,
    driverLat: Number(payload.driverLat ?? 0) || null,
    driverLng: Number(payload.driverLng ?? 0) || null,
    requestNumber: String(row.request_number ?? payload.requestNumber ?? '').trim(),
    driverRating: Number(row.driver_rating ?? payload.driverRating ?? 0) || 0,
    cashCollected: Boolean(row.cash_collected ?? payload.cashCollected ?? false),
    acceptedAt: row.accepted_at ?? payload.acceptedAt ?? null,
    completedAt: row.completed_at ?? payload.completedAt ?? null,
    cancellationReason: row.cancellation_reason ?? payload.cancellationReason ?? null,
    cancelledBy: payload.cancelledBy ?? null,
    isPaid: Boolean(row.is_paid ?? payload.isPaid ?? false),
    ratingComment: String(payload.ratingComment ?? '').trim() || null,
    ratedAt: payload.ratedAt || null,
    complaintNote: String(payload.complaintNote ?? '').trim() || null,
    complaintAt: payload.complaintAt || null,
    waypoints: Array.isArray(payload.waypoints) ? payload.waypoints : [],
    liveEtaSeconds: Number(payload.liveEtaSeconds ?? 0) || null,
    liveEtaDistanceKm: Number(payload.liveEtaDistanceKm ?? 0) || null,
    adminReviewRequired: Boolean(payload.adminReviewRequired ?? false),
    cancelRequestReason: payload.cancelRequestReason ?? null,
    isRoundTrip: payload.tripType === 'round_trip' ||
      payload.tripType === 'bazaar_round_trip',
    tripType: String(payload.tripType || 'one_way').trim(),
    serviceKind: String(payload.serviceKind || '').trim(),
    waitingMinutes: payload.waitingMinutes ? Number(payload.waitingMinutes) : null,
    isAdminCustomer: Boolean(payload.isAdminCustomer ?? false),
    createdViaAdmin: Boolean(payload.createdViaAdmin ?? false),
    priorityCaptainPhone: String(payload.priorityCaptainPhone || '').trim() || null,
    priorityExclusiveUntil: payload.priorityExclusiveUntil || null,
    priorityRadarOpened: Boolean(payload.priorityRadarOpened ?? false),
    priorityExclusiveActive: isInEconomicPriorityWindow(
      payload,
      meta.taxiType || payload.taxiType,
      meta.createdAt || payload.createdAt,
    ),
    createdAt: meta.createdAt ?? null,
    matchingRadiusKm: usesExpandingTaxiSearch(meta.taxiType || payload.taxiType)
      ? matchingRadiusKm(meta.createdAt || payload.createdAt)
      : null,
    hurryBumpCount: Math.max(0, Number(payload.hurryBumpCount) || 0),
    hurryBumpTotal: Math.max(0, Number(payload.hurryBumpTotal) || 0),
    baseFareBeforeHurry:
      Number(payload.baseFareBeforeHurry) > 0
        ? Number(payload.baseFareBeforeHurry)
        : null,
    hurryBumpStep: 1000,
    maxHurryBumps: Math.max(1, Number(payload.maxHurryBumps) || 10),
  };
}

/** إخفاء رقم الزبون عن واجهة السائق — التواصل عبر التطبيق فقط */
function hideCustomerPhoneFromTaxiRequest(request) {
  if (!request) return null;
  return {
    ...request,
    customerPhone: '',
    phone: '',
  };
}

/** حالات يظهر فيها رقم الزبون للكابتن المعيَّن (اتصال خارجي). */
const DRIVER_VISIBLE_CUSTOMER_PHONE_STATUSES = new Set([
  'accepted',
  'on_way',
  'arrived',
  'picked_up',
  'cancel_requested',
  'return_waiting',
  'return_on_way',
  'return_arrived',
  'completed',
  'cancelled',
]);

function formatTaxiRequestForDriver(row) {
  const base = formatTaxiRequestForClient(row);
  if (!base) return null;
  const status = String(base.statusKey || '').trim();
  // الطلبات المعلّقة في الشبكة: لا يُكشف رقم الزبون لكل الكباتن.
  if (!DRIVER_VISIBLE_CUSTOMER_PHONE_STATUSES.has(status)) {
    return hideCustomerPhoneFromTaxiRequest(base);
  }
  return base;
}

/** تنسيق كامل للإدارة يشمل سجل إشعارات الكباتن. */
function formatTaxiRequestForAdmin(row) {
  const base = formatTaxiRequestForClient(row);
  if (!base) return null;
  const meta = readTaxiMeta(row);
  return {
    ...base,
    driverPushAudit: Array.isArray(meta.payload.driverPushAudit)
      ? meta.payload.driverPushAudit
      : [],
  };
}

/** In-process lock per request — fallback if RPC is unavailable (single instance). */
const pushAuditLocks = new Map();

async function withTaxiPushAuditLock(requestId, fn) {
  const key = String(requestId || '').trim();
  const prev = pushAuditLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  pushAuditLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pushAuditLocks.get(key) === chained) pushAuditLocks.delete(key);
  }
}

function buildDriverPushAuditEntry(wave = {}) {
  return {
    id: uuidv4(),
    trigger: String(wave.trigger || 'create').trim() || 'create',
    at: nowIso(),
    targetCount: Number(wave.targetCount || 0),
    targets: Array.isArray(wave.targets) ? wave.targets : [],
    fcmSent: Number(wave.fcmSent || 0),
    fcmFailed: Number(wave.fcmFailed || 0),
  };
}

function mapTaxiPushAuditRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    trigger: String(row.trigger || 'create').trim() || 'create',
    at: row.created_at || row.at || null,
    targetCount: Number(row.target_count ?? row.targetCount ?? 0),
    targets: Array.isArray(row.targets) ? row.targets : [],
    fcmSent: Number(row.fcm_sent ?? row.fcmSent ?? 0),
    fcmFailed: Number(row.fcm_failed ?? row.fcmFailed ?? 0),
  };
}

/**
 * Loads push audits from taxi_push_audit (preferred) keyed by request id.
 * Returns null if the table is missing / unreachable (caller keeps payload).
 */
async function loadTaxiPushAuditsByRequestIds(requestIds = []) {
  const ids = [
    ...new Set(
      (Array.isArray(requestIds) ? requestIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    ),
  ];
  if (!ids.length) return new Map();

  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase
      .from('taxi_push_audit')
      .select(
        'id, request_id, trigger, target_count, fcm_sent, fcm_failed, targets, created_at'
      )
      .in('request_id', ids)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const map = new Map();
    for (const row of data || []) {
      const rid = String(row.request_id || '').trim();
      if (!rid) continue;
      if (!map.has(rid)) map.set(rid, []);
      const mapped = mapTaxiPushAuditRow(row);
      if (mapped) map.get(rid).push(mapped);
    }
    return map;
  } catch (error) {
    const msg = String(error?.message || error || '');
    if (/taxi_push_audit|schema cache|does not exist/i.test(msg)) {
      return null;
    }
    console.error('taxi loadTaxiPushAuditsByRequestIds error:', msg);
    return null;
  }
}

/** Prefer dedicated audit table when it has rows; otherwise keep payload audit. */
async function attachTaxiPushAudits(trips) {
  const list = (Array.isArray(trips) ? trips : [trips]).filter(Boolean);
  if (!list.length) return trips;

  const map = await loadTaxiPushAuditsByRequestIds(list.map((t) => t.id));
  if (!map) return trips;

  for (const trip of list) {
    const fromTable = map.get(String(trip.id || '').trim());
    if (fromTable && fromTable.length) {
      trip.driverPushAudit = fromTable;
    }
  }
  return trips;
}

async function appendDriverPushAuditFallback(requestId, entry) {
  const supabase = assertSupabaseAdmin();
  try {
    const { error } = await supabase.from('taxi_push_audit').insert({
      id: entry.id,
      request_id: requestId,
      trigger: entry.trigger,
      target_count: entry.targetCount,
      fcm_sent: entry.fcmSent,
      fcm_failed: entry.fcmFailed,
      targets: entry.targets,
      created_at: entry.at,
    });
    if (error) throw error;
  } catch (error) {
    const msg = String(error?.message || error || '');
    if (!/taxi_push_audit|schema cache|does not exist/i.test(msg)) {
      console.error('taxi_push_audit insert fallback error:', msg);
    }
  }

  await withTaxiPushAuditLock(requestId, async () => {
    const row = await selectSingle('taxi_requests', 'id', requestId);
    if (!row) return;
    const meta = readTaxiMeta(row);
    const existing = Array.isArray(meta.payload.driverPushAudit)
      ? meta.payload.driverPushAudit
      : [];
    const nextPayload = {
      ...meta.payload,
      driverPushAudit: [...existing, entry].slice(-40),
    };
    await updateRow('taxi_requests', 'id', requestId, {
      request_payload: nextPayload,
      updated_at: nowIso(),
    });
  });
}

async function appendDriverPushAudit(requestId, wave = {}) {
  const id = String(requestId || '').trim();
  if (!id) return;
  const entry = buildDriverPushAuditEntry(wave);
  try {
    const supabase = assertSupabaseAdmin();
    const { error } = await supabase.rpc('append_taxi_request_push_audit', {
      p_request_id: id,
      p_wave: entry,
    });
    if (error) throw error;
  } catch (error) {
    const msg = String(error?.message || error || '');
    console.error(
      'taxi appendDriverPushAudit rpc error (using fallback):',
      msg
    );
    try {
      await appendDriverPushAuditFallback(id, entry);
    } catch (fallbackError) {
      console.error(
        'taxi appendDriverPushAudit fallback error:',
        fallbackError?.message || fallbackError
      );
    }
  }
}
async function enrichTaxiRequestForClient(row) {
  const base = formatTaxiRequestForClient(row);
  if (!base) return null;

  const meta = readTaxiMeta(row);
  const customerPhone = String(meta.customerPhone || base.customerPhone || '').trim();
  if (customerPhone && (!base.customerName || !base.customerPhoto)) {
    try {
      const identity = await resolveCustomerPublicIdentity(
        customerPhone,
        base.customerName
      );
      if (!base.customerName && identity.name) {
        base.customerName = identity.name;
      }
      if (!base.customerPhoto && identity.photo) {
        base.customerPhoto = identity.photo;
      }
    } catch (e) {
      console.error('taxi enrich customer identity error:', e?.message || e);
    }
  }

  const payload = meta.payload;
  const payloadDriverLat = Number(payload.driverLat ?? 0);
  const payloadDriverLng = Number(payload.driverLng ?? 0);
  const locationUpdatedAt = payload.driverLocationUpdatedAt;
  const locationFresh = locationUpdatedAt
    ? Date.now() - Date.parse(locationUpdatedAt) < 90 * 1000
    : false;

  const driverPhone = String(base.driverPhone || '').trim();

  if (payloadDriverLat && payloadDriverLng && locationFresh) {
    base.driverLat = payloadDriverLat;
    base.driverLng = payloadDriverLng;
  } else if (driverPhone) {
    try {
      // المصدر الأحدث: driver_locations (يُحدَّث كل 12 ثانية حتى لو فشل كتابة
      // payload الرحلة) — يُبقي خريطة الزبون تتحرك مع الكابتن.
      const { getFreshDriverLocation } = require('./driver_locations');
      const state = await getUserState(driverPhone).catch(() => null);
      const profile = state?.driverProfile || {};
      const live = await getFreshDriverLocation(driverPhone).catch(() => null);
      const lat = Number(profile.latitude ?? profile.lat ?? 0);
      const lng = Number(profile.longitude ?? profile.lng ?? 0);
      if (live && Number(live.lat) && Number(live.lng)) {
        base.driverLat = Number(live.lat);
        base.driverLng = Number(live.lng);
      } else if (lat && lng) {
        base.driverLat = lat;
        base.driverLng = lng;
      }
      if (!base.plateNumber) {
        base.plateNumber = String(profile.plateNumber ?? profile.plate ?? '').trim() || null;
      }
      if (!base.vehicleModel) {
        base.vehicleModel = String(
          profile.vehicleModel ?? profile.vehicle ?? profile.carModel ?? ''
        ).trim() || null;
      }
    } catch (e) {
      console.error('taxi enrich driver profile error:', e?.message || e);
    }
  }

  if (driverPhone) {
    const needsPhoto = !String(base.driverPhoto || '').trim();
    const needsCarImage = !String(base.carImage || '').trim();
    if (needsPhoto || needsCarImage || !base.driverRating) {
      try {
        const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
        const driverProfile = await getDriverProfile(driverPhone);
        if (needsPhoto && driverProfile?.profileImage) {
          base.driverPhoto = String(driverProfile.profileImage).trim();
        }
        if (needsCarImage) {
          const carImg = String(driverProfile?.carImage ?? driverProfile?.vehicleImage ?? '').trim();
          if (carImg) base.carImage = carImg;
        }
        if (driverProfile?.rating) {
          base.driverRating = Number(driverProfile.rating) || 0;
        }
        if (driverProfile?.ratingCount) {
          base.driverRatingCount = Number(driverProfile.ratingCount) || 0;
        }
      } catch (e) {
        try {
          const state = await getUserState(driverPhone);
          const profile = state?.driverProfile || {};
          if (needsPhoto) {
            const img = String(profile.profileImage ?? '').trim();
            if (img) base.driverPhoto = img;
          }
          if (needsCarImage) {
            const carImg = String(profile.carImage ?? profile.vehicleImage ?? '').trim();
            if (carImg) base.carImage = carImg;
          }
          if (profile.rating) base.driverRating = Number(profile.rating) || 0;
          if (profile.ratingCount) base.driverRatingCount = Number(profile.ratingCount) || 0;
        } catch (_) {}
      }
    }
  }

  const { attachLiveEtaToClientRequest } = require('../../../services/taxi_trip_service');
  return attachLiveEtaToClientRequest(base);
}

/**
 * توليد رقم طلب TX-XXXXXX
 */
function generateRequestNumber() {
  const chars = '0123456789';
  let result = 'TX-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** كود رحلة بازار من 3 أرقام — فريد بين الرحلات النشطة. */
async function generateUniqueBazaarTripCode() {
  const activeStatuses = [
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = String(Math.floor(100 + Math.random() * 900));
    const rows = await selectMany(
      'taxi_requests',
      [{ method: 'in', column: 'status_key', value: activeStatuses }],
      { column: 'created_at', ascending: false },
      200
    );
    const taken = (rows || []).some((row) => {
      const payload = normalizeObject(row.request_payload);
      return String(payload.tripCode || '').trim() === code;
    });
    if (!taken) return code;
  }
  return String(Math.floor(100 + Math.random() * 900));
}

/** أقرب 02:00 صباحاً بتوقيت بغداد (UTC+3) بعد الآن. */
function computeBazaarReturnExpiresAt(fromMs = Date.now()) {
  const baghdadOffsetMs = 3 * 60 * 60 * 1000;
  const baghdad = new Date(fromMs + baghdadOffsetMs);
  const y = baghdad.getUTCFullYear();
  const m = baghdad.getUTCMonth();
  const d = baghdad.getUTCDate();
  const h = baghdad.getUTCHours();
  let expireBaghdadUtcMs = Date.UTC(y, m, d, 2, 0, 0);
  if (h >= 2) {
    expireBaghdadUtcMs = Date.UTC(y, m, d + 1, 2, 0, 0);
  }
  return new Date(expireBaghdadUtcMs - baghdadOffsetMs).toISOString();
}

function isBazaarDeliveryPayload(payload = {}) {
  return String(payload.serviceKind || '').trim() === 'taxi_delivery';
}

// ── حساب المسافة (Haversine) ─────────────────────────────────────

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // نصف قطر الأرض بالكيلومتر
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ── إنشاء طلب جديد ───────────────────────────────────────────────

/**
 * @typedef {Object} TaxiRequest
 * @property {string} id
 * @property {string} requestNumber
 * @property {string} customerPhone
 * @property {string} pickupAddress
 * @property {string} dropoffAddress
 * @property {number} pickupLat
 * @property {number} pickupLng
 * @property {number} dropoffLat
 * @property {number} dropoffLng
 * @property {number} distanceKm
 * @property {string} taxiType
 * @property {number} fare
 * @property {number} fareEconomic
 * @property {number} fareSuper
 * @property {string} statusKey
 * @property {string} statusAr
 */

/**
 * @param {string} customerPhone
 * @param {Object} data
 * @param {string} [data.pickupAddress]
 * @param {string} [data.dropoffAddress]
 * @param {number} [data.pickupLat]
 * @param {number} [data.pickupLng]
 * @param {number} [data.dropoffLat]
 * @param {number} [data.dropoffLng]
 * @param {number} [data.distanceKm]
 * @param {string} [data.taxiType]
 * @returns {Promise<TaxiRequest>}
 */
async function createTaxiRequest(customerPhone, data = {}) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  await ensureAppUser(normalizedPhone, data);

  const existingActive = await getCustomerActiveRequest(normalizedPhone);
  if (existingActive) {
    throw new Error('لديك طلب تكسي نشط بالفعل. أكمله أو ألغِه أولاً.');
  }

  const requestId = uuidv4();
  const requestNumber = generateRequestNumber();
  let taxiType = normalizeTaxiType(data.taxiType);
  // التحقق من تفعيل نوع التكسي (تُدار من لوحة الإعدادات بدون تحديث التطبيق)
  const { isTaxiTypeEnabled } = require('../../../services/app_config_service');
  if (!(await isTaxiTypeEnabled(taxiType))) {
    const typeName = {
      tuktuk: 'التكتك',
      wazz: 'الواز',
      economic: 'التكسي',
      starx11: 'ستاركس 11 راكب',
    }[taxiType] || taxiType;
    throw new Error(`خدمة ${typeName} غير متاحة حالياً. اختر نوعاً آخر.`);
  }
  const tripType = String(data.tripType || 'one_way').trim();
  const serviceKindRaw = String(data.serviceKind || '').trim();
  // LEGACY — taxi_delivery / bazaar trips cannot be created; historical reads remain.
  if (
    serviceKindRaw === 'taxi_delivery' ||
    tripType === 'bazaar_round_trip' ||
    tripType === 'bazaar_return_only'
  ) {
    const err = new Error('خدمة تكسي البازار أُزيلت من التطبيق ولم تعد متاحة لطلبات جديدة.');
    err.code = 'TAXI_DELIVERY_REMOVED';
    err.statusCode = 410;
    throw err;
  }
  const serviceKind =
    serviceKindRaw === 'taxi_delivery'
      ? 'taxi_delivery'
      : serviceKindRaw === 'open_trip'
        ? 'open_trip'
        : '';
  // رحلة مفتوحة (عداد): بدون وجهة — الأجرة بالمسافة + الوقت.
  const tripMode =
    String(data.tripMode || '').trim() === 'open' || serviceKind === 'open_trip'
      ? 'open'
      : '';
  const {
    normalizeStopWaitMinutes,
    stopWaitFee,
  } = require('../../../services/taxi_stop_wait_service');
  const waitingMinutes = (tripMode === 'open' || serviceKind === 'taxi_delivery')
    ? null
    : normalizeStopWaitMinutes(data.waitingMinutes);

  let pickupAddress = String(data.pickupAddress || '').trim();
  let dropoffAddress = String(data.dropoffAddress || '').trim();
  let pickupLat = Number(data.pickupLat) || 0;
  let pickupLng = Number(data.pickupLng) || 0;
  let dropoffLat = Number(data.dropoffLat) || 0;
  let dropoffLng = Number(data.dropoffLng) || 0;

  if (serviceKind === 'taxi_delivery') {
    const {
      getTaxiDeliveryConfig,
    } = require('../../../services/app_config_service');
    const deliveryCfg = await getTaxiDeliveryConfig();
    if (!deliveryCfg.enabled) {
      throw new Error('خدمة تكسي البازار غير مفعّلة حالياً.');
    }
    dropoffLat = Number(deliveryCfg.destinationLat) || 0;
    dropoffLng = Number(deliveryCfg.destinationLng) || 0;
    dropoffAddress = String(deliveryCfg.destinationNameAr || 'بازار ومطاعم طلب').trim();
    taxiType = 'economic';
    if (!pickupLat || !pickupLng) {
      throw new Error('يرجى تحديد نقطة الانطلاق.');
    }
  }

  if (tripMode === 'open') {
    // رحلة مفتوحة: تكسي اقتصادي، بدون وجهة، والسعر يعمل بالعداد.
    taxiType = 'economic';
    dropoffAddress = String(data.dropoffAddress || '').trim() || 'رحلة مفتوحة';
    dropoffLat = 0;
    dropoffLng = 0;
    if (!pickupLat || !pickupLng) {
      throw new Error('يرجى تحديد نقطة الانطلاق.');
    }
  }

  const waypoints = (serviceKind === 'taxi_delivery' || tripMode === 'open')
    ? []
    : Array.isArray(data.waypoints)
      ? data.waypoints
          .map((wp) => ({
            address: String(wp?.address ?? wp?.addressAr ?? '').trim(),
            lat: Number(wp?.lat ?? wp?.latitude ?? 0),
            lng: Number(wp?.lng ?? wp?.longitude ?? 0),
          }))
          .filter((wp) => wp.address && wp.lat && wp.lng)
          .slice(0, 3)
      : [];

  const { sumWaypointDistanceKm, haversineDistance, MIN_TRIP_DISTANCE_KM } = require('../../../services/taxi_trip_service');

  // نُفضّل distanceKm المُرسلة من Flutter (محسوبة عبر Mapbox على الطرق الفعلية)
  // ونستخدم Haversine كبديل فقط عند عدم وجودها
  const clientDistanceKm = tripMode === 'open' ? 0 : Number(data.distanceKm) || 0;
  const haversineDistanceKm = tripMode === 'open'
    ? 0
    : sumWaypointDistanceKm([
        {
          lat: pickupLat,
          lng: pickupLng,
        },
        ...waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng })),
        {
          lat: dropoffLat,
          lng: dropoffLng,
        },
      ]);
  const straightPickupDropoffKm = tripMode === 'open'
    ? 0
    : haversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
  const distanceKm = Math.max(
    clientDistanceKm > 0 ? clientDistanceKm : haversineDistanceKm,
    0
  );

  // منع المسافة الصفرية والرحلات الأقصر من 100 متر (ما عدا الرحلة المفتوحة).
  // نعتمد المسافة الجغرافية بين النقاط حتى لا يُتجاوز الحد بمسافة مُرسلة من العميل.
  if (tripMode !== 'open') {
    const geoKm = Math.max(
      Number.isFinite(haversineDistanceKm) ? haversineDistanceKm : 0,
      Number.isFinite(straightPickupDropoffKm) ? straightPickupDropoffKm : 0
    );
    if (!Number.isFinite(geoKm) || geoKm <= 0) {
      const err = new Error(
        'نقطة الوصول مطابقة لنقطة الانطلاق أو المسافة صفر. حدّد وجهة مختلفة.'
      );
      err.statusCode = 400;
      err.code = 'ZERO_DISTANCE';
      throw err;
    }
    if (geoKm < MIN_TRIP_DISTANCE_KM) {
      const err = new Error(
        'المسافة قصيرة جداً (أقل من 100 متر). حدّد نقطة وصول أبعد.'
      );
      err.statusCode = 400;
      err.code = 'DISTANCE_TOO_SHORT';
      throw err;
    }
  }
  const economicOnlyTrip = isEconomicOnlyDistance(distanceKm);
  if (serviceKind === 'taxi_delivery') {
    taxiType = 'economic';
  } else if (economicOnlyTrip && !isAllowedOnLongDistance(taxiType)) {
    taxiType = 'economic';
  }

  const fareOptions = {
    pickupAddress,
    dropoffAddress,
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
  };
  if (data.insideCityTrip !== undefined && data.insideCityTrip !== null) {
    fareOptions.insideCityTrip = Boolean(data.insideCityTrip);
  }

  // ── الحل الجذري: نستخدم السعر الذي رآه المستخدم وأكده (confirmedFare) ──
  // هذا يضمن أن السعر المعروض = السعر المخزّن في قاعدة البيانات تماماً.
  // في حال عدم إرسال confirmedFare (طلبات قديمة/API خارجي)، نحسبه من الـ Backend.
  const clientFare = Number(data.confirmedFare) || 0;
  let fareEconomic, fareSuper, fare;
  if (tripMode === 'open') {
    // الرحلة المفتوحة: الأجرة بادئتها 1,500 د.ع (العداد) — لا سعر مسبق ثابت.
    const { OPEN_TRIP_PRICING } = require('../../../services/taxi_open_trip_service');
    fare = clientFare > 0 ? clientFare : OPEN_TRIP_PRICING.base;
    fareEconomic = fare;
    fareSuper = fare;
  } else if (serviceKind === 'taxi_delivery') {
    // أجرة ذهاب عادية مثل طلب تكسي اقتصادي — العودة مجانية.
    if (clientFare > 0) {
      fare = clientFare;
      fareEconomic = clientFare;
      fareSuper = clientFare;
    } else {
      const calculated = await calculateFare(distanceKm, 'economic', 'one_way', fareOptions);
      fare = calculated.fare;
      fareEconomic = calculated.fareEconomic;
      fareSuper = calculated.fareSuper;
    }
  } else if (clientFare > 0 && !economicOnlyTrip) {
    // السعر المؤكد من Flutter — يُستخدم مباشرة (هو ما رآه المستخدم وأكده)
    fare = clientFare;
    fareSuper = clientFare;
    const ecoCalc = await calculateFare(distanceKm, 'economic', tripType, fareOptions);
    fareEconomic = ecoCalc.fare;
  } else {
    // الرحلات فوق 10 كم تُفرض كاقتصادي بسعر السيرفر، حتى لو أرسل
    // عميل قديم سعراً مؤكداً خاصاً بالتكتك أو الواز.
    const calculated = await calculateFare(distanceKm, taxiType, tripType, fareOptions);
    fare = calculated.fare;
    fareEconomic = calculated.fareEconomic;
    fareSuper = calculated.fareSuper;
  }

  const waitFee = (tripMode === 'open' || serviceKind === 'taxi_delivery')
    ? 0
    : await stopWaitFee(waitingMinutes, distanceKm);
  if (waitFee > 0) {
    if (clientFare > 0 && !economicOnlyTrip) {
      fareEconomic += waitFee;
    } else {
      fare += waitFee;
      fareEconomic += waitFee;
      fareSuper += waitFee;
    }
  }
  console.log(`[TAXI_CREATE] distance=${distanceKm} type=${taxiType} trip=${tripType} fare=${fare} eco=${fareEconomic} clientFare=${clientFare} waitMin=${waitingMinutes || 0} waitFee=${waitFee} serviceKind=${serviceKind || 'standard'}`);

  const isAdminCustomer = isPlatformAdminCustomerPhone(normalizedPhone);
  const customerIdentity = await resolveCustomerPublicIdentity(
    normalizedPhone,
    data.customerName || data.fullName || data.full_name || ''
  );

  let bazaarExtras = {};
  if (serviceKind === 'taxi_delivery') {
    const tripCode = await generateUniqueBazaarTripCode();
    bazaarExtras = {
      tripCode,
      outboundFareDue: fare,
      returnFareDue: 0,
      freeReturn: true,
      originalPickupAddress: pickupAddress,
      originalPickupLat: pickupLat,
      originalPickupLng: pickupLng,
      originalDropoffAddress: dropoffAddress,
      originalDropoffLat: dropoffLat,
      originalDropoffLng: dropoffLng,
      deliveryDiscountPercent: 0,
    };
  }

  let openTripExtras = {};
  if (tripMode === 'open') {
    const { OPEN_TRIP_PRICING } = require('../../../services/taxi_open_trip_service');
    openTripExtras = {
      tripMode: 'open',
      tripMeterBase: OPEN_TRIP_PRICING.base,
      tripPerKm: OPEN_TRIP_PRICING.perKm,
      tripPerMin: OPEN_TRIP_PRICING.perMin,
      tripFreeKm: OPEN_TRIP_PRICING.freeKm,
      meterStartedAt: null,
      tripDistanceKm: 0,
      tripLastLat: null,
      tripLastLng: null,
      meterFare: fare,
    };
  }

  const createdAtIso = nowIso();
  const { getServiceFees } = require('../../../services/app_config_service');
  const taxiFees = await getServiceFees();
  const serviceFeeIqd = Number(taxiFees.taxiOrderIqd ?? 250) || 250;
  const requestPayload = {
    id: requestId,
    requestNumber,
    customerPhone: normalizedPhone,
    customerName: customerIdentity.name,
    customerPhoto: customerIdentity.photo,
    pickupAddress,
    dropoffAddress,
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
    distanceKm,
    taxiType,
    fareEconomic,
    fareSuper,
    fare,
    serviceFeeIqd,
    customerPayableIqd: fare,
    statusKey: 'pending',
    statusAr: 'بانتظار سائق',
    rejectedByDriverIds: [],
    waypoints,
    tripType: serviceKind === 'taxi_delivery' ? 'bazaar_round_trip' : tripType,
    waitingMinutes,
    isAdminCustomer,
    ...(serviceKind ? { serviceKind } : {}),
    ...bazaarExtras,
    ...openTripExtras,
    ...(data.createdViaAdmin || data.adminCreatedBy
      ? {
          createdViaAdmin: true,
          adminCreatedBy: String(data.adminCreatedBy || '').trim() || null,
          adminCreatedAt: createdAtIso,
        }
      : {}),
    ...(usesEconomicPriorityWindow(
      {
        serviceKind,
        createdViaAdmin: Boolean(data.createdViaAdmin || data.adminCreatedBy),
        taxiType,
      },
      taxiType,
    )
      ? {
          priorityCaptainPhone: getPriorityCaptainPhone(),
          priorityExclusiveUntil: priorityExclusiveUntilIso(createdAtIso),
          priorityRadarOpened: false,
        }
      : {
          // أولوية معطّلة مؤقتاً: علّم الرادار مفتوحاً حتى لا تخفي تطبيقات الكابتن القديمة الطلب 25 ثانية.
          priorityRadarOpened: true,
        }),
    createdAt: createdAtIso,
    updatedAt: createdAtIso,
  };

  const payload = {
    id: requestId,
    phone: normalizedPhone,
    request_number: requestNumber,
    status_key: 'pending',
    request_payload: requestPayload,
    pickup_lat: requestPayload.pickupLat,
    pickup_lng: requestPayload.pickupLng,
    dropoff_lat: requestPayload.dropoffLat,
    dropoff_lng: requestPayload.dropoffLng,
    distance_km: distanceKm,
    taxi_type: taxiType,
    fare_economic: fareEconomic,
    fare_super: fareSuper,
    fare,
    created_at: createdAtIso,
    updated_at: createdAtIso,
  };

  const savedRow = await saveRow('taxi_requests', payload, 'id');
  const saved = readTaxiMeta(savedRow);

  // بث لحظي أولاً — للأدمن فقط هنا؛ بث الكباتن في notify بعد استبعاد المشغولين.
  try {
    const { socketBroadcast, driverRoom, adminOpsRoom } = require('../../../lib/socket_broadcast');
    const formatted = formatTaxiRequestForClient(savedRow);
    const priorityExclusive = usesEconomicPriorityWindow(requestPayload, taxiType);
    if (priorityExclusive) {
      const room = driverRoom(getPriorityCaptainPhone());
      if (room) {
        void socketBroadcast({
          room,
          event: 'taxi:pool_new',
          payload: formatted,
        });
      }
    }
    // غير الحصرية: لا بث لغرفة النوع (تصل للكباتن المشغولين). يُبث لاحقاً للأحرار فقط.
    void socketBroadcast({
      room: adminOpsRoom(),
      event: 'live:ops',
      payload: {
        type: 'taxi_request',
        orderId: saved.id,
        requestNumber: saved.requestNumber,
        taxiType,
        pickupAddress: requestPayload.pickupAddress,
        dropoffAddress: requestPayload.dropoffAddress,
        fare: requestPayload.fare,
        distanceKm: requestPayload.distanceKm,
      },
    });
  } catch (socketError) {
    console.error('taxi socket broadcast pool_new error:', socketError?.message || socketError);
  }

  // صندوق إشعارات الأدمن (الجرس) — مستقل عن السوكت حتى يظهر الطلب حتى لو انقطع البث اللحظي.
  try {
    const { assertSupabaseAdmin } = require('../../../supabase_repo/common');
    const sb = assertSupabaseAdmin();
    const pickup = String(requestPayload.pickupAddress || '').trim();
    const dropoff = String(requestPayload.dropoffAddress || '').trim();
    const route =
      pickup || dropoff
        ? ` — ${[pickup, dropoff].filter(Boolean).join(' ← ')}`
        : '';
    await sb.from('admin_notifications').insert({
      type: 'taxi_request',
      title: 'طلب تكسي جديد',
      body: `طلب ${saved.requestNumber || saved.id}${route}`,
      data: {
        id: saved.id,
        requestNumber: saved.requestNumber,
        taxiType,
        href: `/admin/taxi?id=${encodeURIComponent(String(saved.id || ''))}`,
      },
      is_read: false,
    });
  } catch (notifError) {
    console.warn(
      'taxi admin_notifications insert skipped:',
      notifError?.message || notifError,
    );
  }

  // Push + بحث السائقين في الخلفية — الرد للزبون فوراً بعد الحفظ.
  scheduleNewTaxiRequestNotifications(saved, requestPayload, taxiType);

  const { recordRequestCreated } = require('../../../services/taxi_metrics_service');
  recordRequestCreated();

  return {
    id: requestId,
    requestId,
    requestNumber,
    statusKey: 'pending',
    statusAr: 'بانتظار سائق',
    pickupAddress: requestPayload.pickupAddress,
    dropoffAddress: requestPayload.dropoffAddress,
    pickupLat: requestPayload.pickupLat,
    pickupLng: requestPayload.pickupLng,
    dropoffLat: requestPayload.dropoffLat,
    dropoffLng: requestPayload.dropoffLng,
    distanceKm,
    taxiType,
    fare,
    fareEconomic,
    fareSuper,
    customerPhone: normalizedPhone,
    serviceKind: serviceKind || undefined,
    tripCode: requestPayload.tripCode || undefined,
    outboundFareDue: requestPayload.outboundFareDue,
    returnFareDue: requestPayload.returnFareDue,
    matchingRadiusKm: usesExpandingTaxiSearch(taxiType)
      ? matchingRadiusKm(requestPayload.createdAt)
      : undefined,
  };
}

// ── قبول السائق ──────────────────────────────────────────────────

async function getTaxiRequestForActor(actorPhone, requestId) {
  const normalizedPhone = await resolvePhoneKey(actorPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');
  const meta = readTaxiMeta(row);

  // الزبون صاحب الطلب
  if (phonesOverlap(normalizedPhone, meta.customerPhone)) {
    return formatTaxiRequestForClient(row);
  }
  // الكابتن المعيّن
  if (meta.driverPhone && phonesOverlap(normalizedPhone, meta.driverPhone)) {
    return formatTaxiRequestForClient(row);
  }
  // طلب pending — يظهر لأي كابتن بنفس النوع لم يرفضه (حالة الضغط من الإشعار)
  if (row.status_key === 'pending') {
    const rejectedIds = Array.isArray(meta.payload.rejectedByDriverIds)
      ? meta.payload.rejectedByDriverIds
      : [];
    const variants = getPhoneVariants(normalizedPhone);
    if (!rejectedIds.some((v) => variants.includes(v))) {
      return formatTaxiRequestForClient(row);
    }
  }
  throw new Error('لا يمكنك عرض هذا الطلب.');
}

/**
 * قبول الطلب عبر الدالة الذرّية في قاعدة البيانات (accept_taxi_request).
 * تعيد الصف المحدَّث، أو ترمي خطأً معروفاً برسالة واضحة.
 * إن كانت الدالة غير مثبتة بعد يُرمى خطأ "could not find the function"
 * ليتعامل معه المتصل بالرجوع إلى المسار القديم الآمن.
 */
function messageForUnavailableTaxiAccept(statusKey, row = null) {
  const status = String(statusKey || row?.status_key || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return 'ألغى الزبون الطلب.';
  }
  if (
    [
      'accepted',
      'on_way',
      'arrived',
      'picked_up',
      'cancel_requested',
      'return_waiting',
      'return_on_way',
      'return_arrived',
      'completed',
      'done',
      'finished',
    ].includes(status)
  ) {
    return 'قبله كابتن آخر.';
  }
  return 'لم يعد الطلب متاحاً.';
}

async function performAtomicTaxiAccept({
  id,
  driverPhone,
  driverName,
  vehicleInfo,
  payloadUpdates,
}) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase.rpc('accept_taxi_request', {
    p_request_id: id,
    p_driver_phone: driverPhone,
    p_driver_name: driverName,
    p_vehicle_info: vehicleInfo || null,
    p_payload_updates: payloadUpdates || {},
  });
  if (error) {
    const msg = String(error.message || '');
    if (msg.includes('REQUEST_NOT_FOUND')) {
      throw new Error('Request not found.');
    }
    if (msg.includes('REQUEST_CANCELLED_BY_CUSTOMER')) {
      throw new Error('ألغى الزبون الطلب.');
    }
    if (msg.includes('REQUEST_TAKEN_BY_OTHER_DRIVER')) {
      throw new Error('قبله كابتن آخر.');
    }
    if (msg.includes('REQUEST_NOT_AVAILABLE') || msg.includes('REQUEST_NOT_PENDING')) {
      // نسخة قديمة من الدالة أو حالة غير مصنّفة — نقرأ الحالة الفعلية للرسالة الدقيقة.
      try {
        const latest = await selectSingle('taxi_requests', 'id', id);
        throw new Error(messageForUnavailableTaxiAccept(latest?.status_key, latest));
      } catch (lookupError) {
        if (String(lookupError?.message || '').includes('ألغى') ||
            String(lookupError?.message || '').includes('قبله') ||
            String(lookupError?.message || '').includes('متاحاً')) {
          throw lookupError;
        }
        throw new Error('لم يعد الطلب متاحاً.');
      }
    }
    if (msg.includes('DRIVER_BUSY')) {
      throw new Error('لديك رحلة نشطة بالفعل. أكملها قبل قبول طلب جديد.');
    }
    throw error;
  }
  return data;
}

async function acceptTaxiRequest(driverPhone, requestId, data = {}) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  try {
    const {
      clearExpiredPenaltyFreeze,
      assertDriverNotPenaltyFrozen,
    } = require('../../../supabase_repo/taxi_driver_cancellations');
    await clearExpiredPenaltyFreeze(normalizedDriver);
    await assertDriverNotPenaltyFrozen(normalizedDriver);
  } catch (freezeError) {
    if (freezeError?.code === 'DRIVER_PENALTY_FROZEN' || String(freezeError?.message || '').includes('مجمّد')) {
      throw freezeError;
    }
  }

  const lock = await acquireLock(`taxi:accept:${id}`, 10_000);
  if (!lock.ok) {
    throw new Error('Request is being accepted. Try again.');
  }

  try {
  // تنفيذ الاستعلامات المستقلة بالتوازي لتسريع الرد.
  // (ملف السائق لا يُقرأ هنا — التطبيق يرسل الصور، ويُقرأ كاشياً فقط عند الحاجة.)
  const [row, driverActive, fastLocation] = await Promise.all([
    selectSingle('taxi_requests', 'id', id),
    getDriverActiveRequest(normalizedDriver).catch(() => null),
    driverLocations.getFreshDriverLocation(normalizedDriver).catch(() => null),
  ]);
  if (!row) throw new Error('Request not found.');

  if (row.status_key !== 'pending') {
    throw new Error(messageForUnavailableTaxiAccept(row.status_key, row));
  }

  if (driverActive && String(driverActive.id) !== id) {
    throw new Error('لديك رحلة نشطة بالفعل. أكملها قبل قبول طلب جديد.');
  }

  const driverName = String(data.driverName || '').trim() || 'سائق';
  const vehicleModel = String(data.vehicleModel || '').trim();
  const plateNumber = String(data.plateNumber || '').trim();
  const vehicleInfo = [vehicleModel, plateNumber].filter(Boolean).join(' / ');

  let driverPhoto = String(data.driverPhoto || '').trim();
  let carImage = String(data.carImage || '').trim();
  let captainTaxiType = '';
  // التطبيق يرسل صورة السائق والسيارة عادة — نقرأ الملف فقط عند نقص أحدهما
  // أو للتحقق من نوع المركبة مقابل الطلب.
  try {
    const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
    const driverProfile = await getDriverProfile(normalizedDriver);
    captainTaxiType = String(driverProfile?.taxiType || '').trim();
    if (!driverPhoto && driverProfile?.profileImage) {
      driverPhoto = String(driverProfile.profileImage).trim();
    }
    if (!carImage) {
      carImage = String(driverProfile?.carImage ?? driverProfile?.vehicleImage ?? '').trim();
    }
  } catch (_) {}

  const meta = readTaxiMeta(row);
  if (isBazaarDeliveryPayload(meta.payload)) {
    await assertDesignatedBazaarDriver(normalizedDriver);
  }

  // أثناء نافذة الأولوية: لا يقبل الطلب إلا الكابتن المخصص.
  if (
    isInEconomicPriorityWindow(
      meta.payload,
      meta.taxiType || row.taxi_type,
      meta.createdAt || meta.payload?.createdAt,
    ) &&
    !isPriorityCaptainPhone(normalizedDriver)
  ) {
    throw new Error(
      'هذا الطلب محجوز حالياً لكابتن معيّن — انتظر قليلاً أو اختر طلباً آخر.',
    );
  }

  const requestType = normalizeTaxiType(
    row.taxi_type || meta.taxiType || meta.payload?.taxiType
  );
  const captainType = normalizeTaxiType(captainTaxiType || 'economic');
  if (captainType !== requestType) {
    throw new Error(
      requestType === 'starx11'
        ? 'هذا الطلب لستاركس 11 — متاح فقط للكباتن المسجّلين كسائق ستاركس.'
        : 'نوع مركبتك لا يطابق نوع هذا الطلب.',
    );
  }

  const acceptedAt = nowIso();

  const { chargeTaxiOrderFee } = require('../../../supabase_repo/provider_wallet');
  await chargeTaxiOrderFee(normalizedDriver, id);

  let driverLatAtAccept = 0;
  let driverLngAtAccept = 0;
  let initialPickupEtaSeconds = 0;
  try {
    if (fastLocation) {
      driverLatAtAccept = Number(fastLocation.lat ?? 0);
      driverLngAtAccept = Number(fastLocation.lng ?? 0);
    } else {
      const state = await getUserState(normalizedDriver);
      const profile = state?.driverProfile || {};
      driverLatAtAccept = Number(profile.latitude ?? profile.lat ?? 0);
      driverLngAtAccept = Number(profile.longitude ?? profile.lng ?? 0);
    }
    if (driverLatAtAccept && driverLngAtAccept && meta.pickupLat && meta.pickupLng) {
      const { computeLiveEta } = require('../../../services/taxi_trip_service');
      const live = computeLiveEta(
        driverLatAtAccept,
        driverLngAtAccept,
        meta.pickupLat,
        meta.pickupLng
      );
      initialPickupEtaSeconds = Number(live.etaSeconds ?? 0) || 0;
    }
  } catch (_) {}

  const nextPayload = {
    ...meta.payload,
    statusKey: 'accepted',
    statusAr: 'تم القبول',
    driverId: normalizedDriver,
    driverName,
    driverPhone: normalizedDriver,
    driverPhoto: driverPhoto || null,
    carImage: carImage || null,
    driverVehicleInfo: vehicleInfo || null,
    vehicleModel: vehicleModel || null,
    plateNumber: plateNumber || null,
    driverLat: driverLatAtAccept || meta.payload.driverLat || null,
    driverLng: driverLngAtAccept || meta.payload.driverLng || null,
    driverLocationUpdatedAt: acceptedAt,
    driverLatAtAccept: driverLatAtAccept || null,
    driverLngAtAccept: driverLngAtAccept || null,
    initialPickupEtaSeconds,
    acceptedAt,
    updatedAt: acceptedAt,
  };

  let updated;
  try {
    // التحديث الشرطي الذرّي داخل قاعدة البيانات (دالة accept_taxi_request):
    // يتحقق من pending + بلا رحلة نشطة + يحدّث في عملية واحدة، ويُعاد الصف المحدَّث.
    updated = await performAtomicTaxiAccept({
      id,
      driverPhone: normalizedDriver,
      driverName,
      vehicleInfo,
      payloadUpdates: nextPayload,
    });
  } catch (acceptError) {
    const msg = String(acceptError?.message || '');
    // الدالة غير مثبتة بعد في Supabase — الرجوع للمسار القديم (تحديث شرطي).
    if (!/could not find the function/i.test(msg)) throw acceptError;
    updated = null;
  }

  if (!updated) {
    const supabase = assertSupabaseAdmin();
    const { data: legacyUpdated, error } = await supabase
      .from('taxi_requests')
      .update({
        driver_phone: normalizedDriver,
        driver_name: driverName,
        vehicle_info: vehicleInfo || null,
        status_key: 'accepted',
        request_payload: nextPayload,
        accepted_at: acceptedAt,
        updated_at: acceptedAt,
      })
      .eq('id', id)
      .eq('status_key', 'pending')
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!legacyUpdated) {
      const latest = await selectSingle('taxi_requests', 'id', id).catch(() => null);
      throw new Error(messageForUnavailableTaxiAccept(latest?.status_key, latest));
    }
    updated = legacyUpdated;
  }

  // إشعار للزبون
  try {
    const { notifyDriverAccepted } = require('../../../push/taxi_push_events');
    notifyDriverAccepted(meta.customerPhone, driverName, vehicleInfo, id).catch((e) => {
      console.error('taxi accept push error:', e?.message || e);
    });
  } catch (e) {
    console.error('taxi accept push error:', e?.message || e);
  }

  // أثناء الرحلة النشطة: لا يستقبل كابتن مطابقة طلبات جديدة.
  try {
    await driverLocations.upsertDriverLocation(normalizedDriver, {
      isOnline: true,
      available: false,
    });
  } catch (e) {
    console.error('taxi accept mark unavailable error:', e?.message || e);
  }

  const { recordRequestAccepted, recordDriverAccepted } = require('../../../services/taxi_metrics_service');
  recordRequestAccepted(id, row.created_at);
  recordDriverAccepted(normalizedDriver);

  // بث لحظي للزبون المتصل: تم قبول طلبك.
  try {
    const { socketBroadcast, customerRoom } = require('../../../lib/socket_broadcast');
    void socketBroadcast({
      room: customerRoom(meta.customerPhone),
      event: 'taxi:status',
      payload: formatTaxiRequestForClient(updated),
    });
  } catch (socketError) {
    console.error('taxi socket broadcast accept error:', socketError?.message || socketError);
  }

  return formatTaxiRequestForClient(updated);
  } finally {
    await releaseLock(`taxi:accept:${id}`, lock.token);
  }
}

// ── رفض السائق ───────────────────────────────────────────────────

async function rejectTaxiRequest(driverPhone, requestId) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const lock = await acquireLock(`taxi:reject:${id}`, 5_000);
  if (!lock.ok) {
    throw new Error('Request is being processed. Try again.');
  }

  try {
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  if (row.status_key !== 'pending') {
    throw new Error('Request is not available for rejection.');
  }

  const meta = readTaxiMeta(row);
  const rejectedIds = Array.isArray(meta.payload.rejectedByDriverIds)
    ? meta.payload.rejectedByDriverIds
    : [];
  const variants = getPhoneVariants(normalizedDriver);
  const alreadyRejected = variants.some((v) => rejectedIds.includes(v));
  if (!alreadyRejected) {
    rejectedIds.push(normalizedDriver);
  }

  const nextPayload = {
    ...meta.payload,
    rejectedByDriverIds: rejectedIds,
    updatedAt: nowIso(),
  };

  const updatedRow = await updateRow('taxi_requests', 'id', id, {
    request_payload: nextPayload,
    updated_at: nowIso(),
  });

  // لا إعادة إشعار عند الرفض — الإشعار كان مرة واحدة عند إنشاء الطلب.
  // الطلب يبقى ظاهراً للكباتن الآخرين عبر القائمة/السوكت بدون FCM مكرر.

  return formatTaxiRequestForClient(updatedRow);
  } finally {
    await releaseLock(`taxi:reject:${id}`, lock.token);
  }
}

const TRANSFERABLE_STATUSES = new Set(['accepted', 'on_way', 'arrived']);

/**
 * تحويل الرحلة بعد القبول: إعادة الطلب للـ pool مع استبعاد السائق الحالي.
 */
async function transferTaxiRequest(driverPhone, requestId, data = {}) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const lock = await acquireLock(`taxi:transfer:${id}`, 10_000);
  if (!lock.ok) {
    throw new Error('Request is being processed. Try again.');
  }

  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row) throw new Error('Request not found.');

    const meta = readTaxiMeta(row);
    if (!phonesOverlap(normalizedDriver, meta.driverPhone)) {
      throw new Error('هذه الرحلة غير معيّنة لك.');
    }
    if (!TRANSFERABLE_STATUSES.has(meta.statusKey)) {
      throw new Error('لا يمكن تحويل الرحلة في حالتها الحالية.');
    }

    const rejectedIds = Array.isArray(meta.payload.rejectedByDriverIds)
      ? [...meta.payload.rejectedByDriverIds]
      : [];
    const variants = getPhoneVariants(normalizedDriver);
    const alreadyExcluded = variants.some((v) => rejectedIds.includes(v));
    if (!alreadyExcluded) {
      rejectedIds.push(normalizedDriver);
    }

    const transferredAt = nowIso();
    const reason = String(data.reason || '').trim();
    const nextPayload = {
      ...meta.payload,
      statusKey: 'pending',
      statusAr: 'تم تحويل الرحلة — بانتظار كابتن آخر',
      rejectedByDriverIds: rejectedIds,
      driverId: null,
      driverName: null,
      driverPhone: null,
      driverVehicleInfo: null,
      vehicleModel: null,
      plateNumber: null,
      driverLat: null,
      driverLng: null,
      driverLocationUpdatedAt: null,
      driverLatAtAccept: null,
      driverLngAtAccept: null,
      initialPickupEtaSeconds: null,
      acceptedAt: null,
      onWayAt: null,
      arrivedAt: null,
      transferredAt,
      transferredByDriverPhone: normalizedDriver,
      transferReason: reason || null,
      transferCount: Number(meta.payload.transferCount || 0) + 1,
      updatedAt: transferredAt,
    };

    const supabase = assertSupabaseAdmin();
    const { data: updated, error } = await supabase
      .from('taxi_requests')
      .update({
        driver_phone: null,
        driver_name: null,
        vehicle_info: null,
        status_key: 'pending',
        request_payload: nextPayload,
        accepted_at: null,
        updated_at: transferredAt,
      })
      .eq('id', id)
      .eq('driver_phone', row.driver_phone)
      .in('status_key', [...TRANSFERABLE_STATUSES])
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!updated) {
      throw new Error('تعذّر تحويل الرحلة. حدّث الحالة وحاول مجدداً.');
    }

    const formatted = formatTaxiRequestForClient(updated);
    const { recordRequestTransferred } = require('../../../services/taxi_metrics_service');
    recordRequestTransferred();

    try {
      const { notifyTripTransferredToPool } = require('../../../push/taxi_push_events');
      notifyTripTransferredToPool(meta.customerPhone, id).catch((e) => {
        console.error('taxi transfer customer push error:', e?.message || e);
      });
    } catch (e) {
      console.error('taxi transfer customer push error:', e?.message || e);
    }

    try {
      notifyDriversForNewRequest(formatted, nextPayload, meta.taxiType, 'transfer').catch((e) => {
        console.error('taxi transfer rebroadcast error:', e?.message || e);
      });
    } catch (e) {
      console.error('taxi transfer rebroadcast error:', e?.message || e);
    }

    return formatted;
  } finally {
    await releaseLock(`taxi:transfer:${id}`, lock.token);
  }
}

// ── تحديث حالة الرحلة ────────────────────────────────────────────

async function updateTaxiRequestStatus(actorPhone, requestId, statusKey, options = {}) {
  const normalizedPhone = await resolvePhoneKey(actorPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');
  if (!statusKey) throw new Error('Status key is required.');

  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = readTaxiMeta(row);

  // تحقق من الصلاحية
  let isCustomer = phonesOverlap(normalizedPhone, meta.customerPhone);
  let isDriver = phonesOverlap(normalizedPhone, meta.driverPhone);

  // Fallback: مقارن آخر 10 أرقام لضمان التطابق التام وتجنب أي فروقات في الصيغ (+964 أو 07 أو غيرها)
  if (!isCustomer && !isDriver) {
    const cleanActor = normalizedPhone.replace(/\D/g, '').slice(-10);
    const cleanCustomer = meta.customerPhone.replace(/\D/g, '').slice(-10);
    const cleanDriver = meta.driverPhone.replace(/\D/g, '').slice(-10);
    if (cleanActor && cleanCustomer && cleanActor === cleanCustomer) {
      isCustomer = true;
    }
    if (cleanActor && cleanDriver && cleanActor === cleanDriver) {
      isDriver = true;
    }
  }

  if (!isCustomer && !isDriver) {
    throw new Error('You are not authorized to update this request.');
  }

  // التحقق من التسلسل الصحيح للحالات
  const allowedStatuses = [
    'on_way', 'arrived', 'picked_up', 'completed', 'cancelled', 'accepted',
    'cancel_requested', 'return_waiting', 'return_on_way', 'return_arrived',
  ];
  if (!allowedStatuses.includes(statusKey)) {
    throw new Error(`Invalid status key: ${statusKey}.`);
  }

  const { canActorSetTaxiStatus } = require('../../../lib/db_auth_policy');
  const actorRole = isDriver ? 'driver' : 'customer';
  if (!canActorSetTaxiStatus(statusKey, actorRole)) {
    throw new Error(`Role ${actorRole} cannot set status ${statusKey}.`);
  }

  const currentStatusRaw = String(row.status_key || meta.statusKey || '').trim();
  // رحلات قديمة عالقة بحالة in_progress تُعامل كـ picked_up لاسترداد الإكمال/الإلغاء.
  const currentStatus =
    currentStatusRaw === 'in_progress' ? 'picked_up' : currentStatusRaw;
  const isRoundTrip = meta.payload?.tripType === 'round_trip';
  const isBazaarDelivery = isBazaarDeliveryPayload(meta.payload);
  const { isOpenTrip: _isOpenTrip, computeOpenTripFare: _computeOpenFare, openTripMinutesSince: _openTripMinutesSince, finalizeOpenTripFare: _finalizeOpenFare } =
    require('../../../services/taxi_open_trip_service');
  const isOpen = _isOpenTrip(meta.payload);

  const validTransitions = {
    accepted: ['on_way', 'arrived', 'cancelled', 'cancel_requested'],
    arrived: ['picked_up', 'cancelled', 'cancel_requested'],
    // بعد الاستلام: إكمال، أو إلغاء استرداد إن تعطّل الكابتن.
    // تكسي البازار: من الاستلام → بانتظار العودة (دفع النصف عند البازار).
    // ذهاب وعودة عادية: بعد الوصول للوجهة → مراحل العودة لنقطة الانطلاق (لا إكمال مباشر).
    picked_up: isBazaarDelivery
      ? ['return_waiting', 'cancelled']
      : isRoundTrip
        ? ['return_waiting', 'cancelled']
        : ['completed', 'cancelled'],
    pending: ['cancelled'],
    cancel_requested: ['cancelled', 'accepted'],
    on_way: ['arrived', 'cancelled', 'cancel_requested'],
    return_waiting: ['return_on_way', 'cancelled', 'completed'],
    return_on_way: ['return_arrived', 'cancelled'],
    return_arrived: ['completed', 'cancelled'],
  };
  const allowedNext = validTransitions[currentStatus] || [];

  if (!allowedNext.includes(statusKey)) {
    throw new Error(`Cannot transition from ${currentStatusRaw} to ${statusKey}.`);
  }

  // الزبون يبدأ العداد فقط في الرحلة المفتوحة وبعد وصول الكابتن.
  if (isCustomer && !isDriver && statusKey === 'picked_up') {
    if (!isOpen) {
      throw new Error('بدء العداد متاح للزبون في الرحلة المفتوحة فقط.');
    }
    if (currentStatus !== 'arrived') {
      throw new Error('لا يمكن بدء العداد إلا بعد وصول الكابتن.');
    }
  }

  // الزبون لا يُنهي إلا من مرحلة الاستلام (أو العودة المكتملة).
  // ذهاب وعودة: الإنهاء فقط بعد العودة لنقطة الانطلاق.
  if (isCustomer && !isDriver && statusKey === 'completed') {
    const customerCompletable = isBazaarDelivery
      ? new Set(['return_arrived', 'return_waiting'])
      : isRoundTrip
        ? new Set(['return_arrived'])
        : new Set(['picked_up', 'return_arrived', 'in_progress']);
    if (!customerCompletable.has(currentStatusRaw) && currentStatus !== 'picked_up') {
      throw new Error('لا يمكن إنهاء الرحلة إلا بعد استلام الزبون.');
    }
    if (isRoundTrip && !isBazaarDelivery && currentStatus !== 'return_arrived') {
      throw new Error('لا يمكن إنهاء رحلة الذهاب والعودة إلا بعد العودة لنقطة الانطلاق.');
    }
  }

  // انتهاء نافذة العودة للبازار: completed من return_waiting فقط عبر النظام/انتهاء الصلاحية أو السائق بعد 2ص
  if (
    isBazaarDelivery &&
    statusKey === 'completed' &&
    currentStatus === 'return_waiting' &&
    isDriver
  ) {
    const expiresAt = Date.parse(String(meta.payload.returnExpiresAt || ''));
    if (!Number.isFinite(expiresAt) || Date.now() < expiresAt) {
      throw new Error('لا يمكن إنهاء رحلة البازار قبل العودة أو قبل الساعة 2 صباحاً.');
    }
  }

  const nextPayload = {
    ...meta.payload,
    statusKey,
    updatedAt: nowIso(),
  };

  const dbUpdate = {
    status_key: statusKey,
    request_payload: nextPayload,
    updated_at: nowIso(),
  };

  if (statusKey === 'completed') {
    const completedAt = nowIso();
    const collectedFareRaw =
      options.collectedFare ?? options.fare ?? options.fareCollectedAmount;
    const parsedCollectedFare = Number(collectedFareRaw);
    const hasCollectedFare =
      Number.isFinite(parsedCollectedFare) && parsedCollectedFare >= 0;

    nextPayload.completedAt = completedAt;
    if (
      isBazaarDelivery &&
      (currentStatus === 'return_waiting' || nextPayload.returnSkipped)
    ) {
      nextPayload.returnSkipped = true;
      nextPayload.cashCollected = true;
      nextPayload.fareCollectedAmount = Number(nextPayload.outboundFareDue || 0);
      nextPayload.statusAr = 'اكتملت بدون عودة (انتهت نافذة العودة)';
    } else if (isBazaarDelivery) {
      nextPayload.returnPaidAt = completedAt;
      nextPayload.returnPaidAmount = 0;
      nextPayload.cashCollected = true;
      nextPayload.fareCollectedAmount = Number(
        nextPayload.outboundFareDue || nextPayload.fare || 0
      );
      nextPayload.statusAr = 'اكتملت الرحلة (ذهاب + عودة مجانية)';
    } else if (isOpen) {
      // الرحلة المفتوحة: تثبيت الأجرة النهائية مع تقريب للأقرب (نفس خطوة طلب التكسي).
      const meterStart = nextPayload.meterStartedAt || nextPayload.pickedUpAt;
      const minutes = _openTripMinutesSince(meterStart);
      let roundingStep = 250;
      try {
        const { getTaxiPricing } = require('../../../services/app_config_service');
        const pricing = await getTaxiPricing();
        const step = Number(pricing?.roundingStep);
        if (Number.isFinite(step) && step > 0) roundingStep = step;
      } catch (_) {
        // استخدم الافتراضي 250
      }
      const { roundFareToNearestStep } = require('../../../services/taxi_pricing_service');
      let finalFare;
      if (isDriver && hasCollectedFare) {
        // حتى لو أرسل الكابتن رقم العداد الحي، يُقرَّب دائماً لأقرب خطوة.
        finalFare = roundFareToNearestStep(parsedCollectedFare, roundingStep);
      } else {
        finalFare = _finalizeOpenFare({
          km: Number(nextPayload.tripDistanceKm) || 0,
          minutes,
          pricing: nextPayload,
          roundingStep,
        });
      }
      // طبقة أمان أخيرة — لا تُحفظ أجرة مفتوحة بدون تقريب.
      finalFare = roundFareToNearestStep(finalFare, roundingStep);
      nextPayload.meterFare = finalFare;
      nextPayload.fare = finalFare;
      nextPayload.fareEconomic = finalFare;
      nextPayload.fareSuper = finalFare;
      nextPayload.cashCollected = true;
      nextPayload.fareCollectedAmount = finalFare;
      nextPayload.statusAr = 'اكتملت الرحلة';
      dbUpdate.fare = finalFare;
      dbUpdate.fare_economic = finalFare;
      dbUpdate.fare_super = finalFare;
    } else {
      if (isDriver) {
        if (!hasCollectedFare) {
          throw new Error('يجب إدخال الأجرة المحصّلة من الزبون.');
        }
        const finalFare = Math.round(parsedCollectedFare);
        if (finalFare < 0) {
          throw new Error('يجب إدخال الأجرة المحصّلة من الزبون.');
        }
        if (finalFare === 0 && currentStatus !== 'return_arrived') {
          throw new Error('يجب إدخال الأجرة المحصّلة من الزبون.');
        }
        if (finalFare > 0) {
          nextPayload.fare = finalFare;
          nextPayload.fareEconomic = finalFare;
          nextPayload.fareSuper = finalFare;
          nextPayload.fareCollectedAmount = finalFare;
          dbUpdate.fare = finalFare;
          dbUpdate.fare_economic = finalFare;
          dbUpdate.fare_super = finalFare;
        } else {
          nextPayload.fareCollectedAmount = 0;
        }
      }
      nextPayload.cashCollected = true;
      nextPayload.statusAr = 'اكتملت الرحلة';
    }
    dbUpdate.completed_at = completedAt;
    dbUpdate.cash_collected = true;
  }

  if (statusKey === 'on_way') {
    nextPayload.statusAr = 'الكابتن في الطريق إليك';
    nextPayload.onWayAt = nextPayload.onWayAt || nowIso();
  }

  if (statusKey === 'arrived') {
    nextPayload.arrivedAt = nowIso();
    nextPayload.statusAr = 'وصل الكابتن إلى موقعك';
  }

  if (statusKey === 'picked_up') {
    nextPayload.pickedUpAt = nowIso();
    if (isOpen) {
      // بدء عداد الرحلة المفتوحة فقط لحظة «صعد زبون» — ليس عند القبول أو الوصول.
      const { computeOpenTripFare } =
        require('../../../services/taxi_open_trip_service');
      nextPayload.meterStartedAt = nowIso();
      nextPayload.tripDistanceKm = 0;
      nextPayload.tripLastLat = Number(nextPayload.driverLat) || null;
      nextPayload.tripLastLng = Number(nextPayload.driverLng) || null;
      nextPayload.meterFare = computeOpenTripFare({
        km: 0,
        minutes: 0,
        pricing: nextPayload,
      });
    }
    nextPayload.statusAr = isBazaarDelivery
      ? 'في الطريق إلى البازار'
      : isOpen
        ? 'في الرحلة — العداد يعمل'
        : 'أنت في الرحلة';
  }

  if (statusKey === 'cancelled') {
    nextPayload.cancellationReason = row.status_key === 'pending'
      ? 'ألغى الزبون الطلب'
      : nextPayload.cancellationReason || 'ملغي';
    nextPayload.statusAr = 'ملغي';
    if (!nextPayload.cancelledBy) {
      nextPayload.cancelledBy = isDriver
        ? 'driver'
        : isCustomer
          ? 'customer'
          : 'system';
    }
    dbUpdate.cancellation_reason = nextPayload.cancellationReason;
  }

  if (statusKey === 'cancel_requested') {
    nextPayload.statusAr = 'بانتظار موافقة السائق على الإلغاء';
    nextPayload.cancelRequestedAt = nowIso();
  }

  if (statusKey === 'return_waiting') {
    if (isBazaarDelivery) {
      const code = String(nextPayload.tripCode || '').trim();
      const due = Number(
        nextPayload.outboundFareDue || nextPayload.fare || 0
      );
      nextPayload.outboundPaidAt = nowIso();
      nextPayload.outboundPaidAmount = due;
      nextPayload.returnExpiresAt =
        nextPayload.returnExpiresAt || computeBazaarReturnExpiresAt();
      nextPayload.statusAr = code
        ? `وصلت للبازار — ادفع ${due} د.ع. احفظ الكود ${code} للعودة المجانية حتى 2 صباحاً`
        : 'وصلت للبازار — بانتظار العودة المجانية حتى 2 صباحاً';
    } else if (isRoundTrip) {
      nextPayload.statusAr = 'وصلت للوجهة — بانتظار بدء العودة لنقطة الانطلاق';
    } else {
      nextPayload.statusAr = 'بانتظار الزبون للعودة';
    }
    nextPayload.returnWaitingAt = nowIso();
  }
  if (statusKey === 'return_on_way') {
    nextPayload.statusAr = isBazaarDelivery
      ? 'الكابتن في طريق العودة المجانية من البازار'
      : isRoundTrip
        ? 'في طريق العودة إلى نقطة انطلاق الزبون'
        : 'في طريق العودة';
    nextPayload.returnStartedAt = nowIso();
  }
  if (statusKey === 'return_arrived') {
    nextPayload.statusAr = isBazaarDelivery
      ? 'وصل الكابتن لموقعك — العودة مجانية'
      : isRoundTrip
        ? 'وصلت لنقطة انطلاق الزبون — أنهِ الرحلة'
        : 'وصل لنقطة الانطلاق للعودة';
    nextPayload.returnArrivedAt = nowIso();
  }

  dbUpdate.request_payload = nextPayload;

  // تحديث شرطي على الحالة الحالية لتفادي السباقات التي تترك الرحلة عالقة.
  const supabase = assertSupabaseAdmin();
  let statusQuery = supabase
    .from('taxi_requests')
    .update(dbUpdate)
    .eq('id', id);
  if (currentStatusRaw === 'in_progress') {
    statusQuery = statusQuery.in('status_key', ['in_progress', 'picked_up']);
  } else if (currentStatusRaw) {
    statusQuery = statusQuery.eq('status_key', currentStatusRaw);
  }
  const { data: updatedRows, error: statusUpdateError } = await statusQuery.select();
  if (statusUpdateError) throw new Error(statusUpdateError.message);
  const updatedRow = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
  if (!updatedRow) {
    throw new Error('تعذر تحديث حالة الرحلة لأنها تغيّرت. حدّث الصفحة وحاول مجدداً.');
  }

  // إشعارات
  try {
    const { recordRequestCompleted, recordRequestCancelled } = require('../../../services/taxi_metrics_service');
    if (statusKey === 'completed') recordRequestCompleted();
    else if (statusKey === 'cancelled') recordRequestCancelled();

    const push = require('../../../push/taxi_push_events');
    if (statusKey === 'arrived') {
      push.notifyDriverArrived(meta.customerPhone, id).catch((e) => console.error('taxi status push error arrived:', e));
      try {
        const { appendTaxiArrivedSystemMessage } = require('../../../supabase_repo/chat');
        appendTaxiArrivedSystemMessage({
          requestId: id,
          driverPhone: meta.driverPhone,
          customerPhone: meta.customerPhone,
          driverName: meta.driverName || nextPayload.driverName,
        }).catch((e) => console.error('taxi arrived chat message error:', e?.message || e));
      } catch (chatErr) {
        console.error('taxi arrived chat message error:', chatErr?.message || chatErr);
      }
    } else if (statusKey === 'completed') {
      push.notifyTripCompleted(
        meta.customerPhone,
        meta.driverPhone,
        Number(nextPayload.meterFare) > 0 ? Number(nextPayload.meterFare) : meta.fare,
        id,
      ).catch((e) => console.error('taxi status push error completed:', e));
      try {
        const { onTaxiTripCompleted } = require('../../../services/loyalty/loyalty_hooks');
        onTaxiTripCompleted({
          customerPhone: meta.customerPhone,
          requestId: id,
        });
      } catch (loyaltyErr) {
        console.error('loyalty taxi completed error:', loyaltyErr?.message || loyaltyErr);
      }
    } else if (statusKey === 'cancel_requested' && isCustomer) {
      push.notifyCancelRequested(meta.driverPhone, meta.customerPhone).catch((e) => console.error('taxi status push error cancel_requested:', e));
    } else if (statusKey === 'cancelled') {
      if (row.status_key === 'cancel_requested') {
        push.notifyCancellationApproved(meta.customerPhone).catch((e) => console.error('taxi status push error cancel_approved:', e));
      } else {
        push.notifyTripCancelled(
          meta.customerPhone,
          meta.driverPhone,
          nextPayload.cancellationReason || 'تم إلغاء طلب التكسي',
          id,
        ).catch((e) => console.error('taxi status push error trip_cancelled:', e));
      }
    } else if (statusKey === 'accepted' && row.status_key === 'cancel_requested') {
      push.notifyCancellationRejected(meta.customerPhone).catch((e) => console.error('taxi status push error cancel_rejected:', e));
    } else if (statusKey === 'return_waiting') {
      push.notifyReturnWaiting(meta.customerPhone, meta.driverPhone, meta.waitingMinutes).catch((e) => console.error('taxi status push error return_waiting:', e));
    } else if (statusKey === 'return_on_way') {
      push.notifyReturnOnWay(meta.customerPhone, meta.driverPhone).catch((e) => console.error('taxi status push error return_on_way:', e));
    } else if (statusKey === 'return_arrived') {
      push.notifyReturnArrived(meta.customerPhone, meta.driverPhone).catch((e) => console.error('taxi status push error return_arrived:', e));
    }
  } catch (e) {
    console.error('taxi status push error:', e?.message || e);
  }

  // بعد إنهاء/إلغاء الرحلة: أعد الكابتن متاحاً للمطابقة إن كان ما زال متصلاً.
  if (
    (statusKey === 'completed' || statusKey === 'cancelled') &&
    meta.driverPhone
  ) {
    try {
      const stillBusy = await require('../../../lib/taxi_driver_busy').isDriverOnActiveTrip(
        meta.driverPhone,
      );
      if (!stillBusy) {
        await driverLocations.upsertDriverLocation(meta.driverPhone, {
          available: true,
        });
      }
    } catch (e) {
      console.error('taxi free driver after trip end error:', e?.message || e);
    }
  }

  // بث لحظي للزبون (وللكابتن) عند أي تغيير حالة عبر Socket.io.
  try {
    const { socketBroadcast, customerRoom, tripRoom, driverTypeRoom } = require('../../../lib/socket_broadcast');
    const statusPayload = formatTaxiRequestForClient(updatedRow);
    void socketBroadcast({
      room: customerRoom(meta.customerPhone),
      event: 'taxi:status',
      payload: statusPayload,
    });
    void socketBroadcast({
      room: tripRoom(id),
      event: 'taxi:status',
      payload: statusPayload,
    });
    // عند الإلغاء: أبلغ كباتن النوع الفوري حتى يزيلوا الطلب من قوائمهم
    // لحظياً (بدل انتظار إشعار أو دورة استطلاع).
    if (statusKey === 'cancelled') {
      void socketBroadcast({
        room: driverTypeRoom(meta.taxiType),
        event: 'taxi:cancelled',
        payload: { id, requestId: id, statusKey: 'cancelled' },
      });
    }
  } catch (socketError) {
    console.error('taxi socket broadcast status error:', socketError?.message || socketError);
  }

  return formatTaxiRequestForClient(updatedRow);
}

// ── إلغاء من الزبون ──────────────────────────────────────────────

async function cancelTaxiRequest(customerPhone, requestId, reason) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const trimmedReason = String(reason || '').trim().slice(0, 300);
  if (trimmedReason.length < 3) {
    throw new Error('يرجى كتابة سبب الإلغاء.');
  }

  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = readTaxiMeta(row);
  if (!phonesOverlap(normalizedPhone, meta.customerPhone)) {
    throw new Error('You are not authorized to cancel this request.');
  }

  const currentStatus = String(meta.statusKey || row.status_key || '').trim();

  if (currentStatus === 'completed' || currentStatus === 'cancelled') {
    throw new Error('لا يمكن إلغاء هذا الطلب.');
  }

  // يشمل picked_up و in_progress لاسترداد الرحلات العالقة بعد الركوب.
  const allowedStatuses = [
    'pending',
    'accepted',
    'on_way',
    'arrived',
    'picked_up',
    'in_progress',
    'cancel_requested',
    'return_waiting',
    'return_on_way',
    'return_arrived',
  ];

  const cancelledAt = nowIso();
  const nextPayload = {
    ...meta.payload,
    statusKey: 'cancelled',
    statusAr: 'ملغي',
    cancellationReason: trimmedReason,
    cancelledBy: 'customer',
    cancelledAt,
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
    .in('status_key', allowedStatuses)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!updated) throw new Error('لا يمكن إلغاء هذا الطلب حالياً.');

  const cancelReason = trimmedReason;

  if (meta.driverPhone) {
    try {
      const stillBusy = await require('../../../lib/taxi_driver_busy').isDriverOnActiveTrip(
        meta.driverPhone,
      );
      if (!stillBusy) {
        await driverLocations.upsertDriverLocation(meta.driverPhone, {
          available: true,
        });
      }
    } catch (e) {
      console.error('taxi free driver after cancel error:', e?.message || e);
    }
  }

  try {
    const { socketBroadcast, customerRoom, tripRoom, driverTypeRoom } =
      require('../../../lib/socket_broadcast');
    const cancelledOut = formatTaxiRequestForClient(updated);
    void socketBroadcast({
      room: customerRoom(meta.customerPhone),
      event: 'taxi:status',
      payload: cancelledOut,
    });
    void socketBroadcast({
      room: tripRoom(id),
      event: 'taxi:status',
      payload: cancelledOut,
    });
    // بث صامت لكباتن النوع لإزالة الطلب من قوائم الوارد (بدون Push).
    void socketBroadcast({
      room: driverTypeRoom(meta.taxiType),
      event: 'taxi:cancelled',
      payload: {
        id,
        requestId: id,
        statusKey: 'cancelled',
        cancelledBy: 'customer',
      },
    });
  } catch (socketError) {
    console.error(
      'taxi cancel socket broadcast error:',
      socketError?.message || socketError,
    );
  }

  try {
    // إشعار الإلغاء يصل فقط للكابتن الذي وافق على الرحلة (إن وُجد)،
    // وليس لكل سائقي النوع. إزالة الطلب من قوائم الـ pending تتم عبر
    // بث السوكيت taxi:cancelled أعلاه بدون إشعار Push جماعي.
    const { notifyTripCancelled } = require('../../../push/taxi_push_events');
    notifyTripCancelled(
      meta.customerPhone,
      meta.driverPhone,
      cancelReason,
      id,
    ).catch((e) => {
      console.error('taxi cancel push error:', e?.message || e);
    });
  } catch (_) {}

  return formatTaxiRequestForClient(updated);
}

/**
 * «أنا مستعجل»: رفع أجرة الطلب المعلّق بمقدار ثابت (افتراضي 500 د.ع) لكل ضغطة.
 */
async function bumpCustomerTaxiFare(customerPhone, requestId) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const lock = await acquireLock(`taxi:bump-fare:${id}`, 8_000);
  if (!lock.ok) {
    throw new Error('الطلب قيد المعالجة. حاول مرة أخرى.');
  }

  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row) throw new Error('Request not found.');

    const meta = readTaxiMeta(row);
    if (!phonesOverlap(normalizedPhone, meta.customerPhone)) {
      throw new Error('You are not authorized to update this request.');
    }

    if (String(meta.statusKey || '').trim() !== 'pending') {
      const err = new Error('يمكن رفع الأجرة فقط أثناء انتظار كابتن.');
      err.code = 'NOT_PENDING';
      throw err;
    }

    const serviceKind = String(meta.payload.serviceKind || '').trim();
    const tripMode = String(meta.payload.tripMode || '').trim();
    if (serviceKind === 'open_trip' || tripMode === 'open') {
      const err = new Error('لا يمكن رفع أجرة الرحلة المفتوحة.');
      err.code = 'OPEN_TRIP';
      throw err;
    }
    if (serviceKind === 'taxi_delivery') {
      const err = new Error('لا يمكن رفع أجرة توصيل البازار من هنا.');
      err.code = 'BAZAAR';
      throw err;
    }

    let bumpStep = 1000;
    let maxBumps = 10;
    try {
      const { getTaxiConfig } = require('../../../services/app_config_service');
      const cfg = await getTaxiConfig();
      const step = Number(cfg.hurryBumpStep);
      const max = Number(cfg.maxHurryBumps);
      if (Number.isFinite(step) && step > 0) bumpStep = Math.round(step);
      if (Number.isFinite(max) && max > 0) maxBumps = Math.round(max);
    } catch (_) {}

    const prevCount = Math.max(0, Number(meta.payload.hurryBumpCount) || 0);
    if (prevCount >= maxBumps) {
      const err = new Error(
        `وصلت للحد الأقصى لرفع الأجرة (${maxBumps} مرات).`,
      );
      err.code = 'MAX_BUMPS';
      throw err;
    }

    const currentFare = Math.max(0, Math.round(Number(meta.fare) || 0));
    const baseBefore =
      Number(meta.payload.baseFareBeforeHurry) > 0
        ? Math.round(Number(meta.payload.baseFareBeforeHurry))
        : currentFare;
    const nextCount = prevCount + 1;
    const nextTotal =
      Math.max(0, Number(meta.payload.hurryBumpTotal) || 0) + bumpStep;
    const nextFare = currentFare + bumpStep;
    const bumpedAt = nowIso();

    const nextPayload = {
      ...meta.payload,
      fare: nextFare,
      confirmedFare: nextFare,
      baseFareBeforeHurry: baseBefore,
      hurryBumpCount: nextCount,
      hurryBumpTotal: nextTotal,
      hurryBumpStep: bumpStep,
      maxHurryBumps: maxBumps,
      hurryBumpedAt: bumpedAt,
      updatedAt: bumpedAt,
      statusKey: 'pending',
      statusAr: meta.payload.statusAr || 'بانتظار سائق',
    };

    const patch = {
      request_payload: nextPayload,
      updated_at: bumpedAt,
    };
    if (await hasColumn('taxi_requests', 'fare')) {
      patch.fare = nextFare;
    }

    const updated = await updateRow('taxi_requests', 'id', id, patch);
    if (!updated) throw new Error('تعذّر تحديث الأجرة.');

    const formatted = formatTaxiRequestForClient(updated);

    try {
      const { socketBroadcast, customerRoom, tripRoom } =
        require('../../../lib/socket_broadcast');
      void socketBroadcast({
        room: customerRoom(meta.customerPhone),
        event: 'taxi:status',
        payload: formatted,
      });
      void socketBroadcast({
        room: tripRoom(id),
        event: 'taxi:status',
        payload: formatted,
      });
    } catch (socketError) {
      console.error(
        'taxi bump-fare socket error:',
        socketError?.message || socketError,
      );
    }

    void notifyDriversForNewRequest(
      updated,
      { ...nextPayload, id, hurryBump: true },
      meta.taxiType || 'economic',
      'hurry_bump',
    ).catch((e) =>
      console.error('taxi bump-fare notify error:', e?.message || e),
    );

    return formatted;
  } finally {
    await releaseLock(`taxi:bump-fare:${id}`, lock.token);
  }
}

async function requestTripCancellation(customerPhone, requestId, reason) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = readTaxiMeta(row);
  if (!phonesOverlap(normalizedPhone, meta.customerPhone)) {
    throw new Error('You are not authorized to cancel this request.');
  }

  const cancellable = ['accepted', 'on_way', 'arrived'];
  if (!cancellable.includes(meta.statusKey)) {
    throw new Error('لا يمكن طلب الإلغاء في هذه المرحلة.');
  }

  const trimmedReason = String(reason || '').trim().slice(0, 300);
  if (trimmedReason.length < 3) {
    throw new Error('يرجى كتابة سبب الإلغاء.');
  }
  const nextPayload = {
    ...meta.payload,
    statusKey: 'cancel_requested',
    statusAr: 'بانتظار موافقة السائق على الإلغاء',
    cancelRequestReason: trimmedReason,
    cancelRequestedAt: nowIso(),
    updatedAt: nowIso(),
  };

  const updatedRow = await updateRow('taxi_requests', 'id', id, {
    status_key: 'cancel_requested',
    request_payload: nextPayload,
    updated_at: nowIso(),
  });

  try {
    const { notifyCancelRequested } = require('../../../push/taxi_push_events');
    notifyCancelRequested(meta.driverPhone, meta.customerPhone).catch((e) => {
      console.error('taxi cancel request push error:', e?.message || e);
    });
  } catch (e) {
    console.error('taxi cancel request push error:', e?.message || e);
  }

  return formatTaxiRequestForClient(updatedRow);
}

async function updateDriverTripLocation(driverPhone, requestId, lat, lng) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const id = String(requestId || '').trim();
  const driverLat = Number(lat);
  const driverLng = Number(lng);
  if (!id) throw new Error('Request id is required.');
  if (!driverLat || !driverLng) throw new Error('Valid coordinates are required.');

  await driverLocations.upsertDriverLocation(normalizedDriver, {
    lat: driverLat,
    lng: driverLng,
    isOnline: true,
    available: false,
  }).catch((error) => {
    console.error('driver location fast upsert error:', error?.message || error);
  });

  const broadcastTripLocation = (customerPhone, extras = {}) => {
    try {
      const {
        socketBroadcast,
        customerRoom,
        tripRoom,
      } = require('../../../lib/socket_broadcast');
      const payload = {
        id,
        driverLat,
        driverLng,
        updatedAt: extras.updatedAt || nowIso(),
        liveEtaSeconds: extras.liveEtaSeconds ?? null,
        liveEtaDistanceKm: extras.liveEtaDistanceKm ?? null,
      };
      const customer = String(customerPhone || '').trim();
      if (customer) {
        void socketBroadcast({
          room: customerRoom(customer),
          event: 'taxi:location',
          payload,
        });
      }
      void socketBroadcast({
        room: tripRoom(id),
        event: 'taxi:location',
        payload,
      });
    } catch (error) {
      console.warn('taxi location socket broadcast:', error?.message || error);
    }
  };

  // قفل قصير يمنع سباق تحديثات الموقع من إعادة إشعار التأخر عدة مرات.
  const lock = await acquireLock(`taxi:location:${id}`, 5_000);
  if (!lock.ok) {
    const existing = await selectSingle('taxi_requests', 'id', id);
    if (!existing) throw new Error('Request not found.');
    const meta = readTaxiMeta(existing);
    // حتى مع القفل: نبث الإحداثيات الأخيرة للخريطة الفورية.
    broadcastTripLocation(meta.customerPhone, {
      liveEtaSeconds: meta.payload?.liveEtaSeconds,
      liveEtaDistanceKm: meta.payload?.liveEtaDistanceKm,
    });
    return formatTaxiRequestForClient(existing);
  }

  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row) throw new Error('Request not found.');

    const meta = readTaxiMeta(row);
    if (!phonesOverlap(normalizedDriver, meta.driverPhone)) {
      throw new Error('You are not authorized to update this trip location.');
    }

    const activeStatuses = ['accepted', 'on_way', 'arrived', 'picked_up'];
    if (!activeStatuses.includes(meta.statusKey)) {
      throw new Error('Trip is not active.');
    }

    const updatedAt = nowIso();
    let nextPayload = {
      ...meta.payload,
      driverLat,
      driverLng,
      driverLocationUpdatedAt: updatedAt,
      updatedAt,
    };

    const { maybeNotifyProximityAndDelay, attachLiveEtaToClientRequest } = require('../../../services/taxi_trip_service');
    nextPayload = await maybeNotifyProximityAndDelay(row, meta, nextPayload);

    const liveBase = attachLiveEtaToClientRequest({
      ...formatTaxiRequestForClient(row),
      driverLat,
      driverLng,
      statusKey: meta.statusKey,
      pickupLat: meta.pickupLat,
      pickupLng: meta.pickupLng,
      dropoffLat: meta.dropoffLat,
      dropoffLng: meta.dropoffLng,
    });
    nextPayload.liveEtaSeconds = liveBase.liveEtaSeconds;
    nextPayload.liveEtaDistanceKm = liveBase.liveEtaDistanceKm;

    // الرحلة المفتوحة: تجميع المسافة المقطوعة أثناء الرحلة (بعد صعود الزبون).
    if (meta.statusKey === 'picked_up') {
      const { isOpenTrip, accumulateOpenTripMeter } =
        require('../../../services/taxi_open_trip_service');
      if (isOpenTrip(meta.payload)) {
        nextPayload = accumulateOpenTripMeter(nextPayload, driverLat, driverLng);
      }
    }

    await updateRow('taxi_requests', 'id', id, {
      request_payload: nextPayload,
      updated_at: updatedAt,
    });

    broadcastTripLocation(meta.customerPhone, {
      updatedAt,
      liveEtaSeconds: nextPayload.liveEtaSeconds,
      liveEtaDistanceKm: nextPayload.liveEtaDistanceKm,
    });

    return formatTaxiRequestForClient(await selectSingle('taxi_requests', 'id', id));
  } finally {
    await releaseLock(`taxi:location:${id}`, lock.token);
  }
}

const _lastProfileLocationWrite = new Map();
const PROFILE_LOCATION_WRITE_INTERVAL_MS = 60_000;
/** كاش خفيف لبيانات السائق بين نبضات الموقع — يقلل getDriverProfile/selectSingleByPhone. */
const _presenceMetaCache = new Map();
const PRESENCE_META_TTL_MS = 5 * 60_000;

async function updateDriverPresenceLocation(driverPhone, data = {}) {
  const normalizedDriver =
    canonicalPhone(driverPhone) || String(driverPhone || '').trim();
  const lat = Number(data.lat ?? data.latitude ?? 0);
  const lng = Number(data.lng ?? data.longitude ?? 0);
  if (!normalizedDriver || !lat || !lng) {
    throw new Error('Valid coordinates are required.');
  }

  const nowMs = Date.now();
  let meta = _presenceMetaCache.get(normalizedDriver);
  if (!meta || nowMs - meta.at >= PRESENCE_META_TTL_MS) {
    let profile = {};
    try {
      const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
      profile =
        (await Promise.race([
          getDriverProfile(normalizedDriver),
          new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
        ])) || {};
    } catch (error) {
      console.warn(
        'presence profile soft-fail:',
        error?.message || error,
      );
      profile = {};
    }
    meta = {
      at: nowMs,
      available: profile.available !== false,
      taxiType: profile.taxiType || data.taxiType || 'economic',
      driverName: profile.name,
      vehicleModel: profile.vehicleModel,
      plateNumber: profile.plateNumber,
      color: profile.color,
      governorate: profile.governorate,
      city: profile.city ?? profile.area,
      rating: profile.rating,
      totalTrips: profile.totalTrips,
      isApproved: profile.isApproved !== false,
    };
    _presenceMetaCache.set(normalizedDriver, meta);
    if (_presenceMetaCache.size > 800) {
      for (const [phone, entry] of _presenceMetaCache) {
        if (nowMs - entry.at >= PRESENCE_META_TTL_MS) {
          _presenceMetaCache.delete(phone);
        }
      }
    }
  }

  const supabase = assertSupabaseAdmin();
  // تحديث driver_profiles مرة كل 60 ثانية فقط — بيانات الموقع اللحظية
  // محفوظة في driver_locations، فلا حاجة لكتابتها كل نبضة.
  const lastProfileWrite = _lastProfileLocationWrite.get(normalizedDriver) || 0;
  if (nowMs - lastProfileWrite >= PROFILE_LOCATION_WRITE_INTERVAL_MS) {
    _lastProfileLocationWrite.set(normalizedDriver, nowMs);
    if (_lastProfileLocationWrite.size > 500) {
      for (const [phone, at] of _lastProfileLocationWrite) {
        if (nowMs - at >= PROFILE_LOCATION_WRITE_INTERVAL_MS) {
          _lastProfileLocationWrite.delete(phone);
        }
      }
    }
    void supabase
      .from('driver_profiles')
      .update({ latitude: lat, longitude: lng, updated_at: nowIso() })
      .eq('phone', normalizedDriver)
      .then(({ error }) => {
        if (error) console.error('driver_profiles location update error:', error.message);
      })
      .catch(() => {});
  }

  let result = null;
  try {
    result = await driverLocations.upsertDriverLocation(normalizedDriver, {
      lat,
      lng,
      isOnline: true,
      available:
        data.available !== undefined
          ? data.available === true
          : meta.available !== false,
      taxiType: data.taxiType || meta.taxiType || 'economic',
      driverName: meta.driverName,
      vehicleModel: meta.vehicleModel,
      plateNumber: meta.plateNumber,
      color: meta.color,
      governorate: meta.governorate,
      city: meta.city,
      rating: meta.rating,
      totalTrips: meta.totalTrips,
      isApproved: meta.isApproved !== false,
    });
  } catch (error) {
    // لا نُسقط نبضة الموقع بالكامل إن تعثّر upsert — نعيد نجاحاً خفيفاً.
    console.warn(
      'presence upsert soft-fail:',
      error?.message || error,
    );
    return { success: true, phone: normalizedDriver, softFail: true };
  }

  schedulePendingRequestRecovery(
    normalizedDriver,
    data.taxiType || meta.taxiType || 'economic',
    lat,
    lng,
  );
  return result || { success: true, phone: normalizedDriver };
}

const _lastPendingRecovery = new Map();
const PENDING_RECOVERY_THROTTLE_MS = 5_000;

/**
 * استرجاع إشعارات الطلبات المعلقة عند الحضور — مُعطّل (إشعار واحد عند الإنشاء فقط).
 */
async function recoverPendingRequestPushes(_normalizedDriver, _taxiType, _lat, _lng) {
  // مُعطّل: كان يعيد إرسال FCM لكل طلب معلّق عند كل تحديث حضور/موقع.
  // الإشعار يُرسل مرة واحدة عند إنشاء الطلب فقط.
  return;
}

function schedulePendingRequestRecovery(normalizedDriver, taxiType, lat, lng) {
  void recoverPendingRequestPushes(
    normalizedDriver,
    taxiType || 'economic',
    lat,
    lng,
  ).catch(() => {});
}

async function expireStalePendingTaxiRequests() {
  const { PENDING_AUTO_CANCEL_MS } = require('../../../services/taxi_trip_service');
  const cutoff = new Date(Date.now() - PENDING_AUTO_CANCEL_MS).toISOString();
  const rows = await selectMany(
    'taxi_requests',
    [
      { method: 'eq', column: 'status_key', value: 'pending' },
      { method: 'lt', column: 'created_at', value: cutoff },
    ],
    { column: 'created_at', ascending: true },
    50
  );

  let count = 0;
  for (const row of rows || []) {
    const meta = readTaxiMeta(row);
    const cancelledAt = nowIso();
    const nextPayload = {
      ...meta.payload,
      statusKey: 'cancelled',
      statusAr: 'ملغي تلقائياً',
      cancellationReason: 'لم يقبل أي سائق خلال المهلة المحددة',
      cancelledBy: 'system',
      cancelledAt,
      autoCancelled: true,
      updatedAt: cancelledAt,
    };
    await updateRow('taxi_requests', 'id', meta.id, {
      status_key: 'cancelled',
      request_payload: nextPayload,
      cancellation_reason: nextPayload.cancellationReason,
      updated_at: cancelledAt,
    });
    const { recordRequestMissed } = require('../../../services/taxi_metrics_service');
    recordRequestMissed();
    try {
      const { sendPushToPhone } = require('../../../push_events');
      await sendPushToPhone(meta.customerPhone, {
        title: 'انتهت مهلة البحث',
        body: 'لم يقبل أي سائق الطلب خلال المهلة المحددة.',
        data: {
          category: 'taxi',
          eventKey: 'taxi:timeout',
          requestId: meta.id,
        },
      }, { immediate: true });
    } catch (_) {}
    count += 1;
  }
  return count;
}

const COMPLETION_REMINDER_MS = 30 * 60 * 1000; // بعد 30 دقيقة من الموافقة
const COMPLETION_REMINDER_ACTIVE_STATUSES = [
  'accepted',
  'on_way',
  'arrived',
  'picked_up',
  'in_progress',
  'return_waiting',
  'return_on_way',
  'return_arrived',
];

/**
 * يذكّر الكابتن بإنهاء الرحلة إذا مضى 30 دقيقة على قبولها ولم تُنهَ بعد.
 * يُرسل مرة واحدة فقط لكل رحلة (يُعلَّم في الحمولة completionReminderSentAt).
 */
async function remindDriversToCompleteTrips() {
  const cutoff = new Date(Date.now() - COMPLETION_REMINDER_MS).toISOString();
  const supabase = assertSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('taxi_requests')
    .select('*')
    .in('status_key', COMPLETION_REMINDER_ACTIVE_STATUSES)
    .lt('accepted_at', cutoff)
    .limit(50);
  if (error) {
    console.error('taxi complete reminder query error:', error.message);
    return 0;
  }

  let sent = 0;
  for (const row of rows || []) {
    const meta = readTaxiMeta(row);
    if (meta.payload?.completionReminderSentAt) continue;
    const driverPhone = meta.driverPhone;
    if (!driverPhone) continue;

    try {
      const { sendPushToPhone, buildPushPayload } = require('../../../push_events');
      await sendPushToPhone(
        driverPhone,
        buildPushPayload({
          title: 'هل أنهيت الرحلة؟',
          body: 'مضى وقت على قبول الرحلة. إن كنت أكملتها اضغط «إنهاء الرحلة».',
          audience: 'driver',
          orderId: meta.id,
          eventKey: `taxi:${meta.id}:complete_reminder`,
          category: 'taxi',
        }),
        { immediate: true }
      );
    } catch (pushError) {
      console.error('taxi complete reminder push error:', pushError?.message || pushError);
    }

    const sentAt = nowIso();
    await updateRow('taxi_requests', 'id', meta.id, {
      request_payload: { ...meta.payload, completionReminderSentAt: sentAt },
      updated_at: sentAt,
    }).catch((updateError) =>
      console.error('taxi complete reminder mark error:', updateError?.message || updateError)
    );
    sent += 1;
  }
  return sent;
}

async function getAdminTaxiTrips(adminPhone, { status, limit = 100 } = {}) {
  await ensureAppUser(adminPhone, {});
  const { assertAdminAccess } = require('../../../supabase_repo/users');
  await assertAdminAccess(adminPhone);

  const filters = [];
  const normalizedStatus = String(status || '').trim();
  if (normalizedStatus) {
    filters.push({ method: 'eq', column: 'status_key', value: normalizedStatus });
  }

  const rows = await selectMany(
    'taxi_requests',
    filters,
    { column: 'created_at', ascending: false },
    Math.min(Math.max(Number(limit) || 100, 1), 300)
  );
  return (rows || []).map((row) => formatTaxiRequestForClient(row));
}

async function getAdminTaxiComplaints(adminPhone, { limit = 100 } = {}) {
  await ensureAppUser(adminPhone, {});
  const { assertAdminAccess } = require('../../../supabase_repo/users');
  await assertAdminAccess(adminPhone);

  const rows = await selectMany(
    'taxi_requests',
    [{ method: 'eq', column: 'status_key', value: 'completed' }],
    { column: 'completed_at', ascending: false },
    Math.min(Math.max(Number(limit) || 100, 1), 300)
  );

  return (rows || [])
    .map((row) => formatTaxiRequestForClient(row))
    .filter((item) => {
      const rating = Number(item.driverRating ?? 0);
      return item.adminReviewRequired === true || (rating > 0 && rating <= 2);
    });
}

// ── إشعار السائقين (خلفية) ───────────────────────────────────────

async function listApprovedDriverTargetsByTaxiType(taxiType, excludeDriverIds = []) {
  const supabase = assertSupabaseAdmin();
  const requestedType = normalizeTaxiType(taxiType);
  const excludeSet = new Set(
    (excludeDriverIds || [])
      .flatMap((id) => getPhoneVariants(id))
      .map((p) => String(p || '').replace(/\D/g, '').slice(-10))
      .filter(Boolean),
  );

  const { data, error } = await supabase
    .from('driver_profiles')
    .select('phone, driver_type, is_approved, available, is_suspended, profile_payload')
    .eq('is_approved', true)
    .eq('available', true)
    .eq('is_suspended', false)
    .limit(500);
  if (error) throw new Error(error.message);

  const result = [];
  for (const row of data || []) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    const key = phone.replace(/\D/g, '').slice(-10);
    if (key && excludeSet.has(key)) continue;

    const payload = typeof row.profile_payload === 'object' && row.profile_payload
      ? row.profile_payload
      : {};
    const services = payload.services && typeof payload.services === 'object'
      ? payload.services
      : { taxi: true };
    if (services.taxi === false) continue;

    const driverType = resolveDriverVehicleTaxiType(row, payload);
    if (driverType !== requestedType) continue;
    result.push({ phone });
  }
  return result;
}

function scheduleNewTaxiRequestNotifications(saved, requestPayload, taxiType) {
  void notifyDriversForNewRequest(saved, requestPayload, taxiType).catch((error) => {
    console.error('taxi create push error:', error?.message || error);
  });

  // بعد 15 ثانية: إشعار لكل كباتن الاقتصادي دفعة واحدة (بدون رادار متوسّع).
  if (usesEconomicPriorityWindow(requestPayload, taxiType)) {
    const requestId = String(saved.id || requestPayload.id || '').trim();
    setTimeout(() => {
      void releaseEconomicPriorityWindow(requestId).catch((error) => {
        console.error('taxi priority release error:', error?.message || error);
      });
    }, PRIORITY_EXCLUSIVE_MS + 200);
  }
}

async function markPriorityRadarOpened(requestId) {
  const id = String(requestId || '').trim();
  if (!id) return null;
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row || row.status_key !== 'pending') return null;
  const payload = {
    ...(row.request_payload && typeof row.request_payload === 'object'
      ? row.request_payload
      : {}),
    priorityRadarOpened: true,
    priorityRadarOpenedAt: nowIso(),
    updatedAt: nowIso(),
  };
  const updated = await updateRow('taxi_requests', 'id', id, {
    request_payload: payload,
    updated_at: nowIso(),
  });
  return updated;
}

async function releaseEconomicPriorityWindow(requestId) {
  const id = String(requestId || '').trim();
  if (!id) return false;
  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row || row.status_key !== 'pending') return false;
  const meta = readTaxiMeta(row);
  if (!usesEconomicPriorityWindow(meta.payload, meta.taxiType)) return false;
  if (meta.payload?.priorityRadarOpened === true) return false;
  if (
    isInEconomicPriorityWindow(
      meta.payload,
      meta.taxiType,
      meta.createdAt || meta.payload?.createdAt,
    )
  ) {
    return false;
  }

  const updated = await markPriorityRadarOpened(id);
  if (!updated) return false;
  const nextMeta = readTaxiMeta(updated);
  await notifyDriversForNewRequest(
    nextMeta,
    { ...nextMeta.payload, id: nextMeta.id },
    nextMeta.taxiType,
    'priority_release',
  );

  // لا تبث لغرفة drivers:<type> — تصل للكباتن المشغولين.
  // notifyDriversForNewRequest يبث للأحرار فقط عبر الغرف الشخصية + FCM.
  return true;
}

async function notifyDriversForNewRequest(saved, requestPayloadInput, taxiType, trigger = 'create') {
  const { notifyNewTaxiRequest } = require('../../../push/taxi_push_events');
  let requestPayload =
    requestPayloadInput && typeof requestPayloadInput === 'object'
      ? { ...requestPayloadInput }
      : {};
  const rejectedIds = Array.isArray(requestPayload.rejectedByDriverIds)
    ? requestPayload.rejectedByDriverIds
    : [];
  const serviceKind = String(requestPayload.serviceKind || '').trim();
  const excludePhones = rejectedIds;
  const isBazaarDelivery = serviceKind === 'taxi_delivery';
  const createdAt = requestPayload.createdAt || saved.createdAt || saved.created_at;
  let inPriorityWindow = isInEconomicPriorityWindow(
    requestPayload,
    taxiType,
    createdAt,
  );

  let notifyOptions = {};
  let nearbyDrivers = [];

  if (trigger === 'hurry_bump' || requestPayload.hurryBump === true) {
    notifyOptions = { ...notifyOptions, hurryBump: true, trigger: 'hurry_bump' };
  }

  if (isBazaarDelivery) {
    // بازار: إشعار حصري للسائقين المعتمدين — بدون فلتر مسافة (يصل للإشعار دائماً).
    const { getTaxiDeliveryConfig, normalizePhoneLast10 } = require('../../../services/app_config_service');
    const deliveryCfg = await getTaxiDeliveryConfig();
    const rejectedSet = new Set(
      (rejectedIds || []).map((phone) => normalizePhoneLast10(phone)).filter(Boolean),
    );
    let designated = (deliveryCfg.designatedDriverPhones || []).filter((phone) => {
      const key = normalizePhoneLast10(phone);
      return key && !rejectedSet.has(key);
    });
    // لا نُوسّع لكبائن الأولوية — تكسي البازار حصري لمن أُضيفت أرقامهم في لوحة الإدارة فقط.
    if (designated.length === 0) {
      notifyOptions = { restrictToPhones: [] };
    } else {
      try {
        const { filterOutBusyDrivers } = require('../../../lib/taxi_driver_busy');
        designated = await filterOutBusyDrivers(designated);
      } catch (_) {}
      notifyOptions = { restrictToPhones: designated };
    }
  } else if (inPriorityWindow) {
    // تكسي اقتصادي: أول 25 ثانية للكابتن ذي الأولوية فقط.
    const { normalizePhoneLast10 } = require('../../../services/app_config_service');
    const rejectedSet = new Set(
      (rejectedIds || []).map((phone) => normalizePhoneLast10(phone)).filter(Boolean),
    );
    let priorityTargets = getPriorityCaptainPhones().filter((phone) => {
      const key = normalizePhoneLast10(phone);
      return key && !rejectedSet.has(key);
    });
    try {
      const { filterOutBusyDrivers } = require('../../../lib/taxi_driver_busy');
      priorityTargets = await filterOutBusyDrivers(priorityTargets);
    } catch (_) {}
    if (priorityTargets.length > 0) {
      notifyOptions = { restrictToPhones: priorityTargets };
    } else {
      // رفض كابتن الأولوية أثناء النافذة → إشعار للكل فوراً (بدون رادار متوسّع).
      inPriorityWindow = false;
      if (requestPayload.priorityRadarOpened !== true) {
        try {
          await markPriorityRadarOpened(saved.id || requestPayload.id);
          requestPayload = { ...requestPayload, priorityRadarOpened: true };
        } catch (_) {}
      }
    }
  }

  // اقتصادي بعد انتهاء حصرية كاظم: إشعار للكل دفعة واحدة بدون نطاق متوسّع.
  const broadcastAllEconomic =
    !isBazaarDelivery &&
    usesEconomicPriorityWindow(requestPayload, taxiType) &&
    (requestPayload.priorityRadarOpened === true ||
      trigger === 'priority_release');

  if (
    !isBazaarDelivery &&
    !inPriorityWindow &&
    !notifyOptions.restrictToPhones
  ) {
    // كل الكباتن المتصلين من نفس النوع + المعتمدون — بدون فلتر مسافة / رادار.
    try {
      nearbyDrivers = await driverLocations.getActiveDriversByTaxiType({
        taxiType,
        excludeDriverIds: rejectedIds,
        limit: 500,
      });
    } catch (error) {
      console.error('taxi active drivers by type error:', error?.message || error);
    }

    try {
      const approvedExtra = await listApprovedDriverTargetsByTaxiType(taxiType, rejectedIds);
      const seen = new Set(
        nearbyDrivers
          .map((d) => String(d.phone || d.driverPhone || '').replace(/\D/g, '').slice(-10))
          .filter(Boolean),
      );
      for (const extra of approvedExtra) {
        const key = String(extra.phone || '').replace(/\D/g, '').slice(-10);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        nearbyDrivers.push({
          phone: extra.phone,
          driverPhone: extra.phone,
          tier: 'approved_roster',
        });
      }
    } catch (error) {
      console.error('taxi approved roster merge error:', error?.message || error);
    }
  }

  // استبعاد من لديهم رحلة نشطة مقبولة — لا إشعار ولا بث لهم.
  try {
    const { filterOutBusyDrivers } = require('../../../lib/taxi_driver_busy');
    if (Array.isArray(notifyOptions.restrictToPhones)) {
      notifyOptions.restrictToPhones = await filterOutBusyDrivers(
        notifyOptions.restrictToPhones,
      );
    }
    nearbyDrivers = await filterOutBusyDrivers(nearbyDrivers);
  } catch (error) {
    console.error('taxi filter busy drivers error:', error?.message || error);
  }

  // بث Socket للكباتن الأحرار فقط (غرف شخصية) بدل غرفة النوع التي تصل للمشغولين.
  try {
    const { socketBroadcast, driverRoom } = require('../../../lib/socket_broadcast');
    const requestId = String(saved?.id || requestPayload.id || '').trim();
    const row = requestId
      ? await selectSingle('taxi_requests', 'id', requestId).catch(() => null)
      : null;
    const formatted = row ? formatTaxiRequestForClient(row) : null;
    if (formatted) {
      const targetPhones = Array.isArray(notifyOptions.restrictToPhones)
        ? notifyOptions.restrictToPhones
        : nearbyDrivers.map((d) => d.phone || d.driverPhone).filter(Boolean);
      const seen = new Set();
      for (const phone of targetPhones) {
        const key = String(phone || '').replace(/\D/g, '').slice(-10);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const room = driverRoom(phone);
        if (!room) continue;
        void socketBroadcast({
          room,
          event: 'taxi:pool_new',
          payload: formatted,
        });
      }
    }
  } catch (socketError) {
    console.error(
      'taxi socket personal pool_new error:',
      socketError?.message || socketError,
    );
  }

  const waveResult = await notifyNewTaxiRequest(
    {
      ...saved,
      taxiType,
      excludePhones,
      isAdminCustomer: Boolean(requestPayload.isAdminCustomer),
      pickupAddress: requestPayload.pickupAddress,
      dropoffAddress: requestPayload.dropoffAddress,
      fare: requestPayload.fare,
      distanceKm: requestPayload.distanceKm,
      serviceKind: isBazaarDelivery ? 'taxi_delivery' : serviceKind || undefined,
      matchingRadiusKm: notifyOptions.matchingRadiusKm,
      hurryBump: Boolean(notifyOptions.hurryBump),
      hurryBumpCount: requestPayload.hurryBumpCount,
    },
    nearbyDrivers,
    notifyOptions,
  );
  await appendDriverPushAudit(saved.id || requestPayload.id, {
    trigger,
    ...waveResult,
  });

  if (
    usesExpandingTaxiSearch(taxiType) &&
    !inPriorityWindow &&
    !broadcastAllEconomic
  ) {
    await markMatchingWave(
      saved.id || requestPayload.id,
      requestPayload,
      createdAt,
    );
  } else if (inPriorityWindow) {
    await markMatchingWave(
      saved.id || requestPayload.id,
      {
        ...requestPayload,
        priorityExclusiveActive: true,
      },
      createdAt,
    );
  }
}

async function markMatchingWave(requestId, requestPayload, createdAt) {
  const id = String(requestId || '').trim();
  if (!id) return;
  const wave = matchingWaveIndex(createdAt);
  const radius = matchingRadiusKm(createdAt);
  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row || row.status_key !== 'pending') return;
    const payload = {
      ...(row.request_payload && typeof row.request_payload === 'object'
        ? row.request_payload
        : {}),
      matchingWaveIndex: wave,
      matchingRadiusKm: radius,
      matchingWaveAt: nowIso(),
      updatedAt: nowIso(),
    };
    await updateRow('taxi_requests', 'id', id, {
      request_payload: payload,
      updated_at: nowIso(),
    });
  } catch (error) {
    console.error('markMatchingWave error:', error?.message || error);
  }
}

/**
 * موجات البحث المتوسّع — مُعطّلة.
 * الإشعار يُرسل مرة واحدة عند إنشاء الطلب فقط (بدون رادار كل 30ث).
 */
async function runExpandingSearchWaves() {
  return 0;
}

// ── البحث عن سائقين قريبين ────────────────────────────────────────

async function getNearbyDrivers(pickupLat, pickupLng, taxiType = 'economic', excludeDriverIds = [], radiusKm = 5) {
  try {
    const fastDrivers = await driverLocations.findNearbyDrivers({
      pickupLat,
      pickupLng,
      taxiType,
      excludeDriverIds,
      radiusKm,
    });
    if (Array.isArray(fastDrivers) && fastDrivers.length > 0) {
      return fastDrivers;
    }
  } catch (error) {
    console.error('taxi fast nearby drivers error:', error?.message || error);
  }

  const supabase = assertSupabaseAdmin();
  const requestedType = normalizeTaxiType(taxiType);

  const excludeSet = new Set(
    (excludeDriverIds || []).map((id) => String(id || '').trim()).filter(Boolean)
  );

  const { data: driverRows, error } = await supabase
    .from('driver_profiles')
    .select('phone, latitude, longitude, profile_payload, driver_type, is_approved, available, is_suspended')
    .eq('is_approved', true)
    .eq('available', true)
    .eq('is_suspended', false);
  if (error) throw new Error(error.message);

  const candidates = [];

  for (const row of driverRows || []) {
    const phone = String(row.phone || '').trim();
    if (!phone || excludeSet.has(phone)) continue;

    const payload = typeof row.profile_payload === 'object' ? row.profile_payload : {};
    const services = (payload.services || payload.services === false)
      ? payload.services
      : { taxi: true };
    if (services.taxi === false) continue;

    const driverType = resolveDriverVehicleTaxiType(row, payload);
    if (driverType !== requestedType) continue;

    const driverLat = Number(row.latitude ?? payload.latitude ?? payload.lat ?? 0);
    const driverLng = Number(row.longitude ?? payload.longitude ?? payload.lng ?? 0);
    if (!driverLat || !driverLng) continue;

    const distance = haversineDistance(pickupLat, pickupLng, driverLat, driverLng);
    if (distance > radiusKm) continue;

    candidates.push({
      phone,
      currentLat: driverLat,
      currentLng: driverLng,
      name: String(payload.name ?? row.display_name ?? '').trim(),
      taxiType: driverType,
      vehicleModel: String(payload.vehicleModel ?? payload.vehicle ?? '').trim(),
      plateNumber: String(payload.plateNumber ?? payload.plate ?? '').trim(),
      color: String(payload.color ?? '').trim(),
      area: String(payload.area ?? '').trim(),
      rating: Number(payload.rating ?? 0),
      totalTrips: 0,
      isAvailable: true,
      isOnline: true,
      isApproved: true,
      services,
      distanceKm: Math.round(distance * 100) / 100,
    });
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);

  return candidates;
}

// ── جلب الطلبات الواردة للسائق ──────────────────────────────────

async function getDriverIncomingRequests(driverPhone, lat, lng, taxiType, radiusKm = 15) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);

  try {
    const { isDriverOnActiveTrip } = require('../../../lib/taxi_driver_busy');
    if (await isDriverOnActiveTrip(normalizedDriver)) {
      return [];
    }
  } catch (_) {}

  try {
    const {
      clearExpiredPenaltyFreeze,
      isDriverPenaltyFrozen,
    } = require('../../../supabase_repo/taxi_driver_cancellations');
    const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
    await clearExpiredPenaltyFreeze(normalizedDriver);
    const profile = (await getDriverProfile(normalizedDriver)) || {};
    if (isDriverPenaltyFrozen(profile)) {
      return [];
    }
  } catch (_) {}

  const hasLocation = Number(lat) && Number(lng);
  const driverType = normalizeTaxiType(taxiType);

  let canReceiveBazaarRequests = false;
  try {
    const { getTaxiDeliveryConfig, isPhoneInDesignatedList } = require('../../../services/app_config_service');
    const deliveryCfg = await getTaxiDeliveryConfig();
    canReceiveBazaarRequests =
      deliveryCfg.enabled &&
      isPhoneInDesignatedList(normalizedDriver, deliveryCfg.designatedDriverPhones);
  } catch (_) {}

  // فلتر SQL بالنوع + حد أقصى 100 — بدل جلب كل الطلبات المعلقة (تأخير واضح).
  // طلبات تكسي البازار تظهر فقط للسائقين المضافين من لوحة «تكسي البازار».
  const rows = await selectMany(
    'taxi_requests',
    [
      { method: 'eq', column: 'status_key', value: 'pending' },
      { method: 'eq', column: 'taxi_type', value: normalizeTaxiType(driverType) },
    ],
    { column: 'created_at', ascending: false },
    100
  );

  if (!Array.isArray(rows) || rows.length === 0) return [];

  const normalizeType = (value) => normalizeTaxiType(value);

  const matchesType = (row, meta) => {
    const requestType = normalizeType(
      row.taxi_type || meta.taxiType || meta.payload?.taxiType
    );
    return requestType === normalizeType(driverType);
  };

  const buildCandidate = (row, meta, roundedDistance) => ({
    ...meta.payload,
    id: meta.id,
    statusKey: meta.statusKey,
    statusAr: meta.payload.statusAr || 'بانتظار سائق',
    distanceKm: roundedDistance,
    customerName: shortPublicCustomerName(meta.payload.customerName || ''),
    customerPhoto: String(meta.payload.customerPhoto || '').trim() || null,
    customerPhone: '',
    phone: '',
  });

  const withinRadius = [];
  const identityCache = new Map();

  for (const row of rows) {
    const meta = readTaxiMeta(row);

    if (!matchesType(row, meta)) {
      continue;
    }

    if (isBazaarDeliveryPayload(meta.payload) && !canReceiveBazaarRequests) {
      continue;
    }

    // تكسي اقتصادي: أول 25 ثانية تظهر فقط لكابتن الأولوية (ليس طلبات الأدمن).
    if (
      isInEconomicPriorityWindow(
        meta.payload,
        meta.taxiType || row.taxi_type,
        meta.createdAt || meta.payload?.createdAt,
      ) &&
      !isPriorityCaptainPhone(normalizedDriver)
    ) {
      continue;
    }

    const rejectedIds = Array.isArray(meta.payload.rejectedByDriverIds)
      ? meta.payload.rejectedByDriverIds
      : [];
    if (rejectedIds.length > 0) {
      const variants = getPhoneVariants(normalizedDriver);
      const alreadyRejected = variants.some((v) => rejectedIds.includes(v));
      if (alreadyRejected) continue;
    }

    // بدون فلتر مسافة: كل طلبات النوع تظهر للكابتن (المسافة للعرض فقط إن توفّر الموقع).
    let roundedDistance = 0;
    if (hasLocation && meta.pickupLat && meta.pickupLng) {
      const distance = haversineDistance(lat, lng, meta.pickupLat, meta.pickupLng);
      roundedDistance = Math.round(distance * 100) / 100;
    }

    withinRadius.push(buildCandidate(row, meta, roundedDistance));
  }

  withinRadius.sort((a, b) => a.distanceKm - b.distanceKm);

  for (const candidate of withinRadius) {
    if (candidate.customerName) continue;
    const phone = String(
      rows.find((r) => String(r.id) === String(candidate.id))?.phone || ''
    ).trim();
    if (!phone) continue;
    if (!identityCache.has(phone)) {
      identityCache.set(phone, await resolveCustomerPublicIdentity(phone, ''));
    }
    const identity = identityCache.get(phone);
    if (identity?.name) candidate.customerName = identity.name;
    if (!candidate.customerPhoto && identity?.photo) {
      candidate.customerPhoto = identity.photo;
    }
  }

  return withinRadius;
}

/** طلبات تكسي توصيل البازار الواردة — للسائقين المضافين من لوحة «تكسي البازار» فقط. */
async function getDriverBazaarIncomingRequests(driverPhone) {
  const designated = await isDesignatedBazaarDriver(driverPhone);
  if (!designated) return [];
  const normalizedDriver = await resolvePhoneKey(driverPhone);

  try {
    const { isDriverOnActiveTrip } = require('../../../lib/taxi_driver_busy');
    if (await isDriverOnActiveTrip(normalizedDriver)) {
      return [];
    }
  } catch (_) {}

  const rows = await selectMany(
    'taxi_requests',
    [{ method: 'eq', column: 'status_key', value: 'pending' }],
    { column: 'created_at', ascending: false }
  );

  const out = [];
  for (const row of rows || []) {
    const meta = readTaxiMeta(row);
    if (!isBazaarDeliveryPayload(meta.payload)) continue;
    const rejectedIds = Array.isArray(meta.payload.rejectedByDriverIds)
      ? meta.payload.rejectedByDriverIds
      : [];
    if (rejectedIds.length > 0) {
      const variants = getPhoneVariants(normalizedDriver);
      if (variants.some((v) => rejectedIds.includes(v))) continue;
    }
    out.push({
      ...meta.payload,
      id: meta.id,
      statusKey: meta.statusKey,
      statusAr: meta.payload.statusAr || 'بانتظار سائق',
      customerName: shortPublicCustomerName(meta.payload.customerName || ''),
      customerPhoto: String(meta.payload.customerPhoto || '').trim() || null,
      customerPhone: '',
      phone: '',
    });
  }
  return out;
}

async function assertDesignatedBazaarDriver(driverPhone) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const { getTaxiDeliveryConfig, isPhoneInDesignatedList } = require('../../../services/app_config_service');
  const deliveryCfg = await getTaxiDeliveryConfig();
  if (!deliveryCfg.enabled) {
    throw new Error('خدمة تكسي البازار غير مفعّلة حالياً.');
  }
  const designated = deliveryCfg.designatedDriverPhones || [];
  if (!isPhoneInDesignatedList(normalizedDriver, designated)) {
    throw new Error('هذا الحساب غير مخصّص لتكسي البازار.');
  }
  return normalizedDriver;
}

async function isDesignatedBazaarDriver(driverPhone) {
  try {
    await assertDesignatedBazaarDriver(driverPhone);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * إكمال رحلة الذهاب في تكسي البازار بشكل مستقل:
 * 1) يُكمل طلب الذهاب للكابتن الحالي (يحصل على أجرة الذهاب ويُحرَّر).
 * 2) يُنشئ طلب عودة جديداً بحالة return_waiting (أجرة 0) يُستلم حصرياً
 *    بكود الرحلة (3 أرقام) من أي كابتن بازار — لا يظهر في بركة الطلبات.
 */
async function completeBazaarOutbound(driverPhone, requestId, options = {}) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const lock = await acquireLock(`taxi:bazaar_outbound:${id}`, 10_000);
  if (!lock.ok) throw new Error('جاري معالجة الطلب... حاول مجدداً.');

  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row) throw new Error('Request not found.');
    const meta = readTaxiMeta(row);

    if (!isBazaarDeliveryPayload(meta.payload)) {
      throw new Error('هذا الطلب ليس من طلبات تكسي البازار.');
    }
    if (!phonesOverlap(normalizedDriver, meta.driverPhone)) {
      throw new Error('لا يمكنك إنهاء هذه الرحلة — أنت لست الكابتن المخصص لها.');
    }
    const currentStatus =
      String(row.status_key || '') === 'in_progress' ? 'picked_up' : String(row.status_key || '');
    if (currentStatus !== 'picked_up') {
      throw new Error('الرحلة ليست في مرحلة التحصيل عند البازار.');
    }

    const supabase = assertSupabaseAdmin();
    const completedAt = nowIso();
    const collectedFareRaw =
      options.collectedFare ?? options.fare ?? options.fareCollectedAmount;
    const parsedCollectedFare = Number(collectedFareRaw);
    const outboundDue = Number.isFinite(parsedCollectedFare) && parsedCollectedFare >= 0
      ? Math.round(parsedCollectedFare)
      : Number(meta.payload.outboundFareDue || meta.payload.fare || 0);
    const tripCode = String(meta.payload.tripCode || '').trim();
    const customerPhone = meta.customerPhone;

    // ── 1) إكمال طلب الذهاب ──
    const outboundPayload = {
      ...meta.payload,
      statusKey: 'completed',
      statusAr: 'اكتملت رحلة الذهاب — العودة عبر كود الرحلة',
      completedAt,
      outboundOnly: true,
      outboundPaidAt: completedAt,
      outboundPaidAmount: outboundDue,
      outboundCompletedAt: completedAt,
      outboundCompletedByDriverPhone: normalizedDriver,
      cashCollected: true,
      fareCollectedAmount: outboundDue,
      fare: outboundDue,
      fareEconomic: outboundDue,
      fareSuper: outboundDue,
      returnRequestId: null,
      updatedAt: completedAt,
    };
    const { data: completedRow, error: completeErr } = await supabase
      .from('taxi_requests')
      .update({
        status_key: 'completed',
        request_payload: outboundPayload,
        completed_at: completedAt,
        cash_collected: true,
        fare: outboundDue,
        fare_economic: outboundDue,
        fare_super: outboundDue,
        updated_at: completedAt,
      })
      .eq('id', id)
      .eq('status_key', 'picked_up')
      .select()
      .maybeSingle();
    if (completeErr) throw new Error(completeErr.message);
    if (!completedRow) {
      throw new Error('تعذر إكمال رحلة الذهاب — حاول مجدداً.');
    }

    // ── 2) إنشاء طلب العودة المستقل ──
    const returnId = uuidv4();
    const returnNumber = generateRequestNumber();
    const bazaarLat = Number(meta.payload.originalDropoffLat || meta.payload.dropoffLat || 0);
    const bazaarLng = Number(meta.payload.originalDropoffLng || meta.payload.dropoffLng || 0);
    const homeLat = Number(meta.payload.originalPickupLat || meta.payload.pickupLat || 0);
    const homeLng = Number(meta.payload.originalPickupLng || meta.payload.pickupLng || 0);
    const returnPayload = {
      id: returnId,
      requestNumber: returnNumber,
      customerPhone,
      customerName: meta.payload.customerName,
      customerPhoto: meta.payload.customerPhoto || null,
      pickupAddress: String(meta.payload.originalDropoffAddress || meta.payload.dropoffAddress || 'بازار ومطاعم طلب').trim(),
      pickupLat: bazaarLat,
      pickupLng: bazaarLng,
      dropoffAddress: String(meta.payload.originalPickupAddress || meta.payload.pickupAddress || '').trim(),
      dropoffLat: homeLat,
      dropoffLng: homeLng,
      originalPickupAddress: String(meta.payload.originalPickupAddress || meta.payload.pickupAddress || '').trim(),
      originalPickupLat: homeLat,
      originalPickupLng: homeLng,
      originalDropoffAddress: String(meta.payload.originalDropoffAddress || meta.payload.dropoffAddress || '').trim(),
      originalDropoffLat: bazaarLat,
      originalDropoffLng: bazaarLng,
      distanceKm: meta.distanceKm || 0,
      fare: 0,
      fareEconomic: 0,
      fareSuper: 0,
      freeReturn: true,
      tripCode,
      serviceKind: 'taxi_delivery',
      isReturnTrip: true,
      parentRequestId: id,
      returnExpiresAt: computeBazaarReturnExpiresAt(),
      outboundFareDue: 0,
      returnFareDue: 0,
      taxiType: 'economic',
      tripType: 'bazaar_return_only',
      statusKey: 'return_waiting',
      statusAr: tripCode
        ? `العودة مجانية — الكود ${tripCode} حتى 2 صباحاً`
        : 'بانتظار كابتن العودة',
      waypoints: [],
      isAdminCustomer: meta.payload.isAdminCustomer === true,
      createdAt: completedAt,
      updatedAt: completedAt,
    };

    const { error: returnErr } = await supabase
      .from('taxi_requests')
      .insert({
        id: returnId,
        phone: customerPhone,
        request_number: returnNumber,
        status_key: 'return_waiting',
        pickup_lat: bazaarLat,
        pickup_lng: bazaarLng,
        dropoff_lat: homeLat,
        dropoff_lng: homeLng,
        distance_km: meta.distanceKm || 0,
        taxi_type: 'economic',
        fare: 0,
        fare_economic: 0,
        fare_super: 0,
        request_payload: returnPayload,
        created_at: completedAt,
        updated_at: completedAt,
      });
    if (returnErr) throw new Error(returnErr.message);

    // ── 3) ربط معرّف طلب العودة في طلب الذهاب ──
    const { error: linkErr } = await supabase
      .from('taxi_requests')
      .update({
        request_payload: { ...outboundPayload, returnRequestId: returnId },
        updated_at: completedAt,
      })
      .eq('id', id);
    if (linkErr) {
      console.error('taxi bazaar link return request error:', linkErr.message);
    }

    return {
      success: true,
      completedRequestId: id,
      returnRequestId: returnId,
      tripCode,
      message: 'اكتملت رحلة الذهاب. سيستلم كابتن آخر العودة بكود الرحلة.',
    };
  } finally {
    await releaseLock(`taxi:bazaar_outbound:${id}`, lock.token);
  }
}

/**
 * التقاط عودة بازار عبر كود 3 أرقام — نفس السائق أو سائق مخصّص آخر.
 */
async function claimBazaarReturnByCode(driverPhone, tripCode, data = {}) {
  const normalizedDriver = await assertDesignatedBazaarDriver(driverPhone);
  const code = String(tripCode || '').trim();
  if (!/^\d{3}$/.test(code)) {
    throw new Error('أدخل كود الرحلة المكوّن من 3 أرقام.');
  }

  await expireDueBazaarReturnTrips();

  const rows = await selectMany(
    'taxi_requests',
    [{ method: 'eq', column: 'status_key', value: 'return_waiting' }],
    { column: 'created_at', ascending: false },
    100
  );

  const match = (rows || []).find((row) => {
    const payload = normalizeObject(row.request_payload);
    return (
      isBazaarDeliveryPayload(payload) &&
      String(payload.tripCode || '').trim() === code
    );
  });
  if (!match) {
    throw new Error('لا توجد رحلة عودة بهذا الكود، أو انتهت صلاحيتها.');
  }

  const meta = readTaxiMeta(match);
  const expiresAt = Date.parse(String(meta.payload.returnExpiresAt || ''));
  if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
    await expireBazaarReturnTrip(match);
    throw new Error('انتهت نافذة العودة لهذه الرحلة (بعد الساعة 2 صباحاً).');
  }

  const driverActive = await getDriverActiveRequest(normalizedDriver);
  if (driverActive && String(driverActive.id) !== String(meta.id)) {
    throw new Error('لديك رحلة نشطة بالفعل. أكملها قبل التقاط عودة أخرى.');
  }

  const driverName = String(data.driverName || '').trim() || 'سائق';
  const vehicleModel = String(data.vehicleModel || '').trim();
  const plateNumber = String(data.plateNumber || '').trim();
  const vehicleInfo = [vehicleModel, plateNumber].filter(Boolean).join(' / ');
  let driverPhoto = String(data.driverPhoto || '').trim();
  let carImage = String(data.carImage || '').trim();
  try {
    const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
    const driverProfile = await getDriverProfile(normalizedDriver);
    if (!driverPhoto && driverProfile?.profileImage) {
      driverPhoto = String(driverProfile.profileImage).trim();
    }
    if (!carImage) {
      carImage = String(driverProfile?.carImage ?? driverProfile?.vehicleImage ?? '').trim();
    }
  } catch (_) {}

  const claimedAt = nowIso();
  const nextPayload = {
    ...meta.payload,
    statusKey: 'return_waiting',
    statusAr: `تم ربط كابتن العودة — الكود ${code}`,
    driverId: normalizedDriver,
    driverName,
    driverPhone: normalizedDriver,
    driverPhoto: driverPhoto || null,
    carImage: carImage || null,
    driverVehicleInfo: vehicleInfo || null,
    vehicleModel: vehicleModel || null,
    plateNumber: plateNumber || null,
    returnClaimedAt: claimedAt,
    returnClaimedByDriverPhone: normalizedDriver,
    updatedAt: claimedAt,
  };

  const supabase = assertSupabaseAdmin();
  const { data: updated, error } = await supabase
    .from('taxi_requests')
    .update({
      driver_phone: normalizedDriver,
      driver_name: driverName,
      vehicle_info: vehicleInfo || null,
      status_key: 'return_waiting',
      request_payload: nextPayload,
      updated_at: claimedAt,
    })
    .eq('id', meta.id)
    .eq('status_key', 'return_waiting')
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!updated) throw new Error('تعذّر ربط العودة. حدّث وحاول مجدداً.');

  try {
    const { notifyReturnWaiting } = require('../../../push/taxi_push_events');
    notifyReturnWaiting(meta.customerPhone, normalizedDriver, null).catch(() => {});
  } catch (_) {}

  return formatTaxiRequestForClient(updated);
}

async function expireBazaarReturnTrip(row) {
  const meta = readTaxiMeta(row);
  if (!isBazaarDeliveryPayload(meta.payload)) return null;
  if (String(meta.statusKey || row.status_key) !== 'return_waiting') return null;

  const completedAt = nowIso();
  const nextPayload = {
    ...meta.payload,
    statusKey: 'completed',
    statusAr: 'اكتملت بدون عودة (انتهت نافذة العودة)',
    completedAt,
    returnSkipped: true,
    cashCollected: true,
    fareCollectedAmount: Number(meta.payload.outboundFareDue || 0),
    updatedAt: completedAt,
  };

  const supabase = assertSupabaseAdmin();
  const { data: updated, error } = await supabase
    .from('taxi_requests')
    .update({
      status_key: 'completed',
      request_payload: nextPayload,
      completed_at: completedAt,
      cash_collected: true,
      updated_at: completedAt,
    })
    .eq('id', meta.id)
    .eq('status_key', 'return_waiting')
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return updated || null;
}

async function expireDueBazaarReturnTrips() {
  const rows = await selectMany(
    'taxi_requests',
    [{ method: 'eq', column: 'status_key', value: 'return_waiting' }],
    { column: 'created_at', ascending: false },
    100
  );
  const now = Date.now();
  for (const row of rows || []) {
    const payload = normalizeObject(row.request_payload);
    if (!isBazaarDeliveryPayload(payload)) continue;
    const expiresAt = Date.parse(String(payload.returnExpiresAt || ''));
    if (Number.isFinite(expiresAt) && now >= expiresAt) {
      try {
        await expireBazaarReturnTrip(row);
      } catch (e) {
        console.error('expire bazaar return error:', e?.message || e);
      }
    }
  }
}

const BAZAAR_EXPIRE_THROTTLE_MS = 45_000;
let lastBazaarExpireAt = 0;
let bazaarExpireInFlight = null;

async function maybeExpireDueBazaarReturnTrips() {
  const now = Date.now();
  if (now - lastBazaarExpireAt < BAZAAR_EXPIRE_THROTTLE_MS) {
    return;
  }
  if (bazaarExpireInFlight) {
    return bazaarExpireInFlight;
  }
  lastBazaarExpireAt = now;
  bazaarExpireInFlight = expireDueBazaarReturnTrips()
    .catch((error) => {
      console.warn('expire bazaar return soft-fail:', error?.message || error);
    })
    .finally(() => {
      bazaarExpireInFlight = null;
    });
  return bazaarExpireInFlight;
}


// ── الحصول على السائقين النشيطين حسب النوع ───────────────────────

async function getActiveDriverPhonesByTaxiType(taxiType = 'economic') {
  try {
    const fastPhones = await driverLocations.getActiveDriverPhonesByTaxiType(taxiType);
    if (Array.isArray(fastPhones) && fastPhones.length > 0) {
      return fastPhones;
    }
  } catch (error) {
    console.error('taxi fast active drivers error:', error?.message || error);
  }

  const supabase = assertSupabaseAdmin();
  const requestedType = normalizeTaxiType(taxiType);

  const { data: driverRows, error } = await supabase
    .from('driver_profiles')
    .select('phone, driver_type, is_approved, available, is_suspended, profile_payload')
    .eq('is_approved', true)
    .eq('available', true)
    .eq('is_suspended', false);
  if (error) throw new Error(error.message);

  const result = [];

  for (const row of driverRows || []) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;

    const payload = typeof row.profile_payload === 'object' ? row.profile_payload : {};
    const services = (payload.services || payload.services === false)
      ? payload.services
      : { taxi: true };
    if (services.taxi === false) continue;

    const driverType = resolveDriverVehicleTaxiType(row, payload);
    if (driverType !== requestedType) continue;

    result.push(phone);
  }

  return result;
}

// ── استعلامات ─────────────────────────────────────────────────────

async function getCustomerActiveRequest(customerPhone) {
  void maybeExpireDueBazaarReturnTrips().catch(() => {});
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const variants = getPhoneVariants(normalizedPhone);
  if (variants.length === 0) return null;

  const activeStatuses = [
    'pending',
    'accepted',
    'arrived',
    'picked_up',
    'cancel_requested',
    'on_way',
    'return_waiting',
    'return_on_way',
    'return_arrived',
  ];
  const rows = await selectMany(
    'taxi_requests',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'in', column: 'status_key', value: activeStatuses },
    ],
    { column: 'created_at', ascending: false }
  );

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function getCustomerRecentRequest(customerPhone) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const variants = getPhoneVariants(normalizedPhone);
  if (variants.length === 0) return null;

  const rows = await selectMany(
    'taxi_requests',
    [{ method: 'in', column: 'phone', value: variants }],
    { column: 'created_at', ascending: false },
    5
  );

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function getDriverActiveRequest(driverPhone) {
  void maybeExpireDueBazaarReturnTrips().catch(() => {});
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const variants = getPhoneVariants(normalizedDriver);
  if (variants.length === 0) return null;

  const activeStatuses = [
    'accepted',
    'arrived',
    'picked_up',
    'cancel_requested',
    'on_way',
    'return_waiting',
    'return_on_way',
    'return_arrived',
  ];
  const rows = await selectMany(
    'taxi_requests',
    [
      { method: 'in', column: 'driver_phone', value: variants },
      { method: 'in', column: 'status_key', value: activeStatuses },
    ],
    { column: 'created_at', ascending: false }
  );

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function updateDriverRatingStats(driverPhone, newRating) {
  const phoneKey = await resolvePhoneKey(driverPhone);
  if (!phoneKey) return;

  const { saveUserState } = require('../../../supabase_repo/users');
  const state = (await getUserState(phoneKey)) || {};
  const profile = { ...(state.driverProfile || {}) };
  const prevRating = Number(profile.rating ?? 0);
  const prevCount = Number(profile.ratingCount ?? 0);
  const count = prevCount + 1;
  const avg = prevCount > 0
    ? Math.round(((prevRating * prevCount) + newRating) / count * 10) / 10
    : newRating;

  profile.rating = avg;
  profile.ratingCount = count;
  await saveUserState(phoneKey, { ...state, driverProfile: profile });
}

async function rateTaxiRequest(customerPhone, requestId, rating, comment) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  const stars = Number(rating);
  if (!id) throw new Error('Request id is required.');
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    throw new Error('Rating must be between 1 and 5.');
  }

  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = readTaxiMeta(row);
  if (!phonesOverlap(normalizedPhone, meta.customerPhone)) {
    throw new Error('You are not authorized to rate this request.');
  }
  if (meta.statusKey !== 'completed') {
    throw new Error('Only completed trips can be rated.');
  }

  const existingRating = Number(row.driver_rating ?? meta.payload.driverRating ?? 0);
  if (existingRating > 0) {
    throw new Error('This trip has already been rated.');
  }

  const trimmedComment = String(comment || '').trim().slice(0, 500);
  const adminReviewRequired = stars <= 2 || trimmedComment.length > 0;
  const nextPayload = {
    ...meta.payload,
    driverRating: stars,
    ratingComment: trimmedComment || undefined,
    adminReviewRequired,
    ratedAt: nowIso(),
    updatedAt: nowIso(),
  };

  const dbUpdate = {
    driver_rating: stars,
    request_payload: nextPayload,
    updated_at: nowIso(),
  };

  const updated = await updateRow('taxi_requests', 'id', id, dbUpdate);
  if (meta.driverPhone) {
    try {
      await updateDriverRatingStats(meta.driverPhone, stars);
    } catch (e) {
      console.error('taxi driver rating stats error:', e?.message || e);
    }
    try {
      await require('../../../push/taxi_push_events').notifyDriverRated(meta.driverPhone, id);
    } catch (e) {
      console.error('taxi driver rated push error:', e?.message || e);
    }
  }

  return formatTaxiRequestForClient(updated);
}

async function submitTaxiComplaint(customerPhone, requestId, note) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  const trimmed = String(note || '').trim().slice(0, 1000);
  if (!id) throw new Error('Request id is required.');
  if (trimmed.length < 5) {
    const err = new Error('Complaint note is too short.');
    err.statusCode = 400;
    throw err;
  }

  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = readTaxiMeta(row);
  if (!phonesOverlap(normalizedPhone, meta.customerPhone)) {
    throw new Error('You are not authorized to complain about this request.');
  }
  if (meta.statusKey !== 'completed') {
    const err = new Error('Only completed trips can receive a complaint.');
    err.statusCode = 400;
    throw err;
  }

  const existingComplaint = String(meta.payload.complaintNote || '').trim();
  if (existingComplaint) {
    const err = new Error('A complaint was already submitted for this trip.');
    err.statusCode = 409;
    throw err;
  }

  const nextPayload = {
    ...meta.payload,
    complaintNote: trimmed,
    complaintAt: nowIso(),
    adminReviewRequired: true,
    // يظهر في تبويب شكاوى الإدارة مع التقييمات
    ratingComment: String(meta.payload.ratingComment || '').trim() || trimmed,
    updatedAt: nowIso(),
  };

  const updated = await updateRow('taxi_requests', 'id', id, {
    request_payload: nextPayload,
    updated_at: nowIso(),
  });
  try {
    await require('../../../push_events').notifyAdminsTaxiComplaint(id);
  } catch (e) {
    console.error('taxi complaint admin push error:', e?.message || e);
  }
  return formatTaxiRequestForClient(updated);
}

function complaintRefNo(createdAtIso) {
  const base = createdAtIso ? Date.parse(createdAtIso) : Date.now();
  const seq = Number.isFinite(base) ? String(base).slice(-8) : String(Date.now()).slice(-8);
  return `GC-${seq}`;
}

function formatTaxiComplaintRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    requestId: String(row.request_id || '').trim(),
    customerPhone: String(row.customer_phone || '').trim(),
    driverPhone: String(row.driver_phone || '').trim(),
    note: String(row.note || '').trim(),
    rating: Number(row.rating || 0),
    status: String(row.status || 'open').trim(),
    refNo: String(row.ref_no || '').trim(),
    createdAt: row.created_at || null,
    resolvedAt: row.resolved_at || null,
    resolutionNote: String(row.resolution_note || '').trim(),
    resolvedBy: String(row.resolved_by || '').trim(),
  };
}

async function createTaxiComplaint(customerPhone, requestId, note, rating) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  const trimmed = String(note || '').trim().slice(0, 1000);
  if (!id) throw new Error('Request id is required.');
  if (trimmed.length < 5) {
    const err = new Error('Complaint note is too short.');
    err.statusCode = 400;
    throw err;
  }

  const row = await selectSingle('taxi_requests', 'id', id);
  if (!row) throw new Error('Request not found.');

  const meta = readTaxiMeta(row);
  if (!phonesOverlap(normalizedPhone, meta.customerPhone)) {
    throw new Error('You are not authorized to complain about this request.');
  }
  if (meta.statusKey !== 'completed') {
    const err = new Error('Only completed trips can receive a complaint.');
    err.statusCode = 400;
    throw err;
  }

  const existingComplaint = String(meta.payload.complaintNote || '').trim();
  if (existingComplaint) {
    const err = new Error('A complaint was already submitted for this trip.');
    err.statusCode = 409;
    throw err;
  }

  const createdIso = nowIso();
  const saved = await saveRow(
    'taxi_complaints',
    {
      id: uuidv4(),
      request_id: id,
      customer_phone: normalizedPhone,
      driver_phone: meta.driverPhone || null,
      note: trimmed,
      rating: Number.isFinite(Number(rating)) ? Number(rating) : null,
      status: 'open',
      ref_no: complaintRefNo(createdIso),
      created_at: createdIso,
      updated_at: createdIso,
    },
    'id'
  );

  // توافق مع الخلفية: يُسجَّل في payload الرحلة أيضاً حتى تظهر الشكوى
  // في الشاشات القديمة التي تقرأ complaintNote من taxi_requests.
  const nextPayload = {
    ...meta.payload,
    complaintNote: trimmed,
    complaintAt: createdIso,
    adminReviewRequired: true,
    ratingComment: String(meta.payload.ratingComment || '').trim() || trimmed,
    updatedAt: createdIso,
  };
  await updateRow('taxi_requests', 'id', id, {
    request_payload: nextPayload,
    updated_at: createdIso,
  });

  try {
    await require('../../../push_events').notifyAdminsTaxiComplaint(id);
  } catch (e) {
    console.error('taxi complaint admin push error:', e?.message || e);
  }

  try {
    const { socketBroadcast, adminOpsRoom } = require('../../../lib/socket_broadcast');
    void socketBroadcast({
      room: adminOpsRoom(),
      event: 'live:ops',
      payload: { type: 'taxi_complaint', orderId: id },
    });
  } catch (e) {
    console.warn('taxi complaint live broadcast error:', e?.message || e);
  }

  return formatTaxiComplaintRow(saved);
}

async function listTaxiComplaints(adminPhone, { page = 1, limit = 25 } = {}) {
  await ensureAppUser(adminPhone, {});
  const { assertAdminAccess } = require('../../../supabase_repo/users');
  await assertAdminAccess(adminPhone);

  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  const supabase = assertSupabaseAdmin();
  const { data, count, error } = await supabase
    .from('taxi_complaints')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);
  if (error) throw new Error(error.message);

  return {
    items: (data || []).map(formatTaxiComplaintRow).filter(Boolean),
    page: pageNum,
    limit: limitNum,
    total: Number(count || 0),
  };
}

async function resolveTaxiComplaint(adminPhone, complaintId, body = {}) {
  await ensureAppUser(adminPhone, {});
  const { assertAdminAccess } = require('../../../supabase_repo/users');
  await assertAdminAccess(adminPhone);

  const id = String(complaintId || '').trim();
  if (!id) throw new Error('Complaint id is required.');
  const note = String(body.note || body.resolutionNote || '').trim();
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('taxi_complaints')
    .update({
      status: 'resolved',
      resolved_at: nowIso(),
      resolution_note: note,
      resolved_by: String(adminPhone || '').trim(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Complaint not found.');

  // التوافق مع القديم: مسح علم مراجعة الشكوى من payload الرحلة.
  const requestId = String(data.request_id || '').trim();
  if (requestId) {
    const trip = await selectSingle('taxi_requests', 'id', requestId);
    if (trip) {
      const tripPayload = normalizeObject(trip.request_payload);
      await updateRow('taxi_requests', 'id', requestId, {
        request_payload: {
          ...tripPayload,
          adminReviewRequired: false,
          adminComplaintNote: note,
          adminResolvedAt: nowIso(),
          updatedAt: nowIso(),
        },
        updated_at: nowIso(),
      });
    }
  }

  // إشعار الزبون والكابتن بمعالجة الشكوى.
  try {
    const { sendPushToPhone } = require('../../../push_events');
    const targets = [data.customer_phone, data.driver_phone].filter(Boolean);
    for (const phone of targets) {
      await sendPushToPhone(
        phone,
        {
          title: 'تمت معالجة شكواك',
          body: 'قامت الإدارة بمعالجة شكواك — شكراً لتعاونك',
          data: {
            eventKey: 'taxi:complaint_resolved',
            orderId: requestId,
            requestId,
            category: 'taxi',
          },
        },
        { showSystemBanner: true, immediate: true }
      );
    }
  } catch (e) {
    console.error('taxi complaint resolved push error:', e?.message || e);
  }

  return formatTaxiComplaintRow(data);
}

async function getCustomerPendingRatingRequest(customerPhone) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const variants = getPhoneVariants(normalizedPhone);
  if (variants.length === 0) return null;

  const rows = await selectMany(
    'taxi_requests',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'status_key', value: 'completed' },
    ],
    { column: 'completed_at', ascending: false },
    10
  );

  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    const payload = normalizeObject(row.request_payload);
    const existingRating = Number(row.driver_rating ?? payload.driverRating ?? 0);
    if (existingRating > 0) continue;

    const completedAt = row.completed_at ?? payload.completedAt;
    if (completedAt) {
      const ts = Date.parse(completedAt);
      if (!Number.isNaN(ts) && ts < cutoffMs) continue;
    }

    return row;
  }

  return null;
}

async function getCustomerHistory(customerPhone, options = {}) {
  const normalizedPhone = await resolvePhoneKey(customerPhone);
  const variants = getPhoneVariants(normalizedPhone);
  if (variants.length === 0) {
    return { items: [], hasMore: false, limit: 10, offset: 0, stats: emptyCustomerHistoryStats() };
  }

  const limitRaw = Number(options.limit);
  const offsetRaw = Number(options.offset);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), 50)
    : 10;
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(Math.floor(offsetRaw), 0)
    : 0;

  // 180 يوماً — كان 7 أيام فيختفي السجل بسرعة لدى الزبون.
  const sinceIso = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const supabase = assertSupabaseAdmin();
  // نجلب limit+1 لمعرفة إن كان هناك المزيد دون count منفصل.
  const fetchCount = limit + 1;
  const { data, error } = await supabase
    .from('taxi_requests')
    .select('*')
    .in('phone', variants)
    .in('status_key', ['completed', 'cancelled'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .range(offset, offset + fetchCount - 1);
  if (error) throw new Error(error.message);

  const rows = Array.isArray(data) ? data : [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let stats = null;
  if (offset === 0) {
    stats = await computeCustomerHistoryStats(variants, sinceIso);
  }

  return {
    items: pageRows,
    hasMore,
    limit,
    offset,
    stats,
  };
}

function emptyCustomerHistoryStats() {
  return {
    tripCount: 0,
    totalDistanceKm: 0,
    totalHours: 0,
  };
}

function billedDistanceFromHistoryRow(row) {
  const payload = normalizeObject(row?.request_payload ?? row?.payload);
  const isOpen = String(payload.tripMode || '').trim() === 'open';
  if (isOpen) {
    const km = Number(payload.tripDistanceKm) || 0;
    return km > 0 ? km : 0;
  }
  const oneWay = Number(payload.distanceKm ?? row?.distance_km) || 0;
  const isRoundTrip = String(payload.tripType || '').trim() === 'round_trip';
  if (oneWay <= 0) return 0;
  return isRoundTrip ? oneWay * 2 : oneWay;
}

function completedTripDurationSecondsFromHistoryRow(row) {
  const payload = normalizeObject(row?.request_payload ?? row?.payload);
  const endRaw = row?.completed_at || payload.completedAt;
  const endMs = Date.parse(String(endRaw || ''));
  if (!Number.isFinite(endMs)) return 0;
  const startRaw =
    payload.meterStartedAt ||
    row?.accepted_at ||
    payload.acceptedAt ||
    row?.created_at ||
    payload.createdAt;
  const startMs = Date.parse(String(startRaw || ''));
  if (!Number.isFinite(startMs) || endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 1000);
}

async function computeCustomerHistoryStats(phoneVariants, sinceIso) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('taxi_requests')
    .select('request_payload, distance_km, accepted_at, completed_at, created_at, status_key')
    .in('phone', phoneVariants)
    .eq('status_key', 'completed')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);

  const rows = Array.isArray(data) ? data : [];
  let totalDistanceKm = 0;
  let totalSeconds = 0;
  for (const row of rows) {
    totalDistanceKm += billedDistanceFromHistoryRow(row);
    totalSeconds += completedTripDurationSecondsFromHistoryRow(row);
  }

  return {
    tripCount: rows.length,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalHours: totalSeconds > 0 ? Math.round(totalSeconds / 3600) : 0,
  };
}

async function getDriverHistory(driverPhone) {
  const normalizedDriver = await resolvePhoneKey(driverPhone);
  const variants = getPhoneVariants(normalizedDriver);
  if (variants.length === 0) return [];

  // آخر 31 يوماً يكفي لإحصاءات اليوم/الأسبوع/الشهر دون جلب كل السجل.
  const sinceIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await selectMany(
    'taxi_requests',
    [
      { method: 'in', column: 'driver_phone', value: variants },
      { method: 'in', column: 'status_key', value: ['completed', 'cancelled'] },
      { method: 'gte', column: 'created_at', value: sinceIso },
    ],
    { column: 'created_at', ascending: false },
    100
  );

  if (!Array.isArray(rows) || rows.length === 0) return [];

  // جلب هويات كل العملاء دفعة واحدة (استعلام واحد) بدل N+1 استعلام متسلسل
  // كان سبب بطء driver-history (5-12 ثانية) مع تراكم الرحلات.
  const customerPhones = [
    ...new Set(
      rows
        .map((row) => String(readTaxiMeta(row).customerPhone || '').trim())
        .filter(Boolean)
    ),
  ];
  const identityByName = new Map();
  if (customerPhones.length > 0) {
    try {
      // نفس مرونة selectSingleByPhone: نبحث بكل صيغ الهاتف (+964/964/07)
      // حتى لا تُفقد أسماء/صور العملاء في سجل الرحلات المكتملة.
      const identityLookup = [
        ...new Set(
          customerPhones
            .flatMap((p) => [...getPhoneVariants(p), canonicalPhone(p)].filter(Boolean))
            .filter(Boolean)
        ),
      ];
      const users = await selectMany('app_users', [
        { method: 'in', column: 'phone', value: identityLookup },
      ]);
      for (const user of users || []) {
        const phone = String(user.phone || user.phoneKey || '').trim();
        if (!phone) continue;
        const identity = {
          name: shortPublicCustomerName(user.full_name || user.fullName || ''),
          photo: String(user.avatar_url || user.avatarUrl || '').trim() || null,
        };
        identityByName.set(phone, identity);
        for (const variant of getPhoneVariants(phone)) {
          identityByName.set(variant, identity);
        }
      }
    } catch (e) {
      console.error('driver history identity batch error:', e?.message || e);
    }
  }

  const enriched = [];
  for (const row of rows) {
    const formatted = formatTaxiRequestForDriver(row);
    if (!formatted) continue;

    const customerPhone = String(readTaxiMeta(row).customerPhone || '').trim();
    const identity = customerPhone ? identityByName.get(customerPhone) : null;
    if (identity) {
      if (!formatted.customerName && identity.name) {
        formatted.customerName = identity.name;
      }
      if (!formatted.customerPhoto && identity.photo) {
        formatted.customerPhoto = identity.photo;
      }
    }
    enriched.push(formatted);
  }
  return enriched;
}

// ── حالة السائق (متصل/غير متصل) ─────────────────────────────────────

async function setDriverOnlineStatus(driverPhone, isOnline) {
  const phoneKey = await resolvePhoneKey(driverPhone);

  if (Boolean(isOnline)) {
    // إيقاف الإدارة: لا اتصال ولا طلبات ولا إشعارات pool.
    try {
      const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
      const { getUserState } = require('../../../supabase_repo/users');
      const profile = await getDriverProfile(phoneKey);
      const state = (await getUserState(phoneKey)) || {};
      if (profile?.isSuspended === true || state.accountSuspended === true) {
        const err = new Error(
          'حسابك موقوف من الإدارة. لن تستقبل طلبات حتى يُرفع الإيقاف.',
        );
        err.statusCode = 403;
        err.code = 'DRIVER_ADMIN_SUSPENDED';
        throw err;
      }
    } catch (suspendError) {
      if (suspendError?.code === 'DRIVER_ADMIN_SUSPENDED') throw suspendError;
      console.error(
        'driver admin suspend check error:',
        suspendError?.message || suspendError,
      );
    }

    try {
      const {
        clearExpiredPenaltyFreeze,
        assertDriverNotPenaltyFrozen,
      } = require('../../../supabase_repo/taxi_driver_cancellations');
      await clearExpiredPenaltyFreeze(phoneKey);
      await assertDriverNotPenaltyFrozen(phoneKey);
    } catch (freezeError) {
      if (freezeError?.code === 'DRIVER_PENALTY_FROZEN') throw freezeError;
      // لا نكسر الاتصال إن فشل فحص التجميد لسبب آخر غير التجميد.
      if (String(freezeError?.message || '').includes('مجمّد')) throw freezeError;
    }
  }

  // شرط إلزامي: لا اتصال بدون توكن FCM على الجهاز.
  if (Boolean(isOnline)) {
    const { getDeviceTokensForPhone } = require('../../../supabase_repo/push_notifications');
    const rows = await getDeviceTokensForPhone(phoneKey);
    const tokens = (rows || []).map((row) => String(row.token || '').trim()).filter(Boolean);
    if (tokens.length === 0) {
      const err = new Error(
        'لا يمكن الاتصال بدون تفعيل الإشعارات على الجهاز. افتح التطبيق واسمح بالإشعارات ثم أعد المحاولة.'
      );
      err.statusCode = 400;
      err.code = 'PUSH_TOKEN_REQUIRED';
      throw err;
    }
  }

  const supabase = assertSupabaseAdmin();
  const { getUserState, saveUserState } = require('../../../supabase_repo/users');

  const scheduleRecoveryIfOnline = async () => {
    if (!Boolean(isOnline)) return;
    // السماح باستعادة فورية عند الضغط على «متصل» حتى لو حدثت محاولة حضور مؤخراً.
    _lastPendingRecovery.delete(phoneKey);
    try {
      const state = (await getUserState(phoneKey)) || {};
      const profile = state.driverProfile || {};
      schedulePendingRequestRecovery(
        phoneKey,
        profile.taxiType || 'economic',
        profile.latitude ?? profile.lat,
        profile.longitude ?? profile.lng,
      );
    } catch (error) {
      console.error('taxi online pending recovery schedule error:', error?.message || error);
    }
  };

  // Try atomic RPC first
  try {
    const { data, error } = await supabase.rpc('atomic_set_driver_online', {
      p_phone: phoneKey,
      p_is_online: Boolean(isOnline),
    });
    if (!error) {
      await driverLocations.setDriverOnline(phoneKey, Boolean(isOnline)).catch((locationError) => {
        console.error('driver location status upsert error:', locationError?.message || locationError);
      });
      await scheduleRecoveryIfOnline();
      return { success: true, phone: phoneKey, isOnline: Boolean(isOnline) };
    }
    console.error('atomic_set_driver_online RPC error:', error?.message || error);
  } catch (rpcError) {
    console.error('atomic_set_driver_online RPC exception (falling back):', rpcError?.message || rpcError);
  }

  const state = (await getUserState(phoneKey)) || {};
  const profile = state.driverProfile || {};

  profile.available = Boolean(isOnline);
  profile.updatedAt = nowIso();

  await saveUserState(phoneKey, {
    ...state,
    driverProfile: profile,
  });

  await driverLocations.upsertDriverLocation(phoneKey, {
    isOnline: Boolean(isOnline),
    available: Boolean(isOnline),
    lat: profile.latitude ?? profile.lat,
    lng: profile.longitude ?? profile.lng,
    taxiType: profile.taxiType || 'economic',
    driverName: profile.name,
    vehicleModel: profile.vehicleModel,
    plateNumber: profile.plateNumber,
    color: profile.color,
    governorate: profile.governorate,
    city: profile.city ?? profile.area,
    rating: profile.rating,
    isApproved: profile.isApproved !== false,
  }).catch((locationError) => {
    console.error('driver location online upsert error:', locationError?.message || locationError);
  });

  if (await hasColumn('taxi_driver_status')) {
    const variants = getPhoneVariants(phoneKey);
    await supabase
      .from('taxi_driver_status')
      .upsert(
        {
          phone: phoneKey,
          is_online: Boolean(isOnline),
          updated_at: nowIso(),
        },
        { onConflict: 'phone' }
      );
  }

  await scheduleRecoveryIfOnline();
  return { success: true, phone: phoneKey, isOnline: Boolean(isOnline) };
}

const ADMIN_ASSIGNABLE_TAXI_STATUSES = new Set([
  'pending',
  'accepted',
  'on_way',
  'arrived',
  'picked_up',
  'in_progress',
  'return_waiting',
  'return_on_way',
  'return_arrived',
]);

async function resolveRegisteredTaxiCaptain(rawPhone) {
  const normalized = await resolvePhoneKey(rawPhone);
  if (!normalized) {
    throw new Error('رقم الكابتن غير صالح.');
  }

  const row = await selectSingleByPhone('driver_profiles', normalized);
  const { getDriverProfile } = require('../../../supabase_repo/operator_profiles');
  const profile = (await getDriverProfile(normalized)) || {};
  if (!row && (!profile || Object.keys(profile).length === 0)) {
    throw new Error('لا يوجد كابتن مسجّل بهذا الرقم. اختر من قائمة الكباتن.');
  }

  const isApproved = row ? row.is_approved !== false : profile.isApproved !== false;
  if (!isApproved) {
    throw new Error('هذا الكابتن غير معتمد بعد.');
  }

  const name =
    String(profile.name || row?.driver_name || '').trim() || 'كابتن طلب';
  const taxiType = normalizeTaxiType(profile.taxiType || row?.taxi_type || 'economic');
  const vehicleModel = String(profile.vehicleModel || profile.carModel || '').trim();
  const plateNumber = String(profile.plateNumber || profile.plate || '').trim();
  const vehicleInfo = [vehicleModel, plateNumber].filter(Boolean).join(' / ');
  const driverPhoto = String(profile.profileImage || profile.photo || '').trim();
  const carImage = String(profile.carImage || profile.vehicleImage || '').trim();

  return {
    phone: normalized,
    name,
    taxiType,
    vehicleModel,
    plateNumber,
    vehicleInfo,
    driverPhoto: driverPhoto || null,
    carImage: carImage || null,
  };
}

/**
 * تعيين/تحويل رحلة تكسي لكابتن مسجّل — من لوحة الإدارة.
 */
async function adminAssignTaxiRequest(requestId, targetDriverPhone, options = {}) {
  const captain = await resolveRegisteredTaxiCaptain(targetDriverPhone);
  const normalizedTarget = captain.phone;
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const lock = await acquireLock(`taxi:admin_assign:${id}`, 10_000);
  if (!lock.ok) {
    throw new Error('جاري معالجة الرحلة... حاول مجدداً.');
  }

  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row) throw new Error('Trip not found.');

    const meta = readTaxiMeta(row);
    if (!ADMIN_ASSIGNABLE_TAXI_STATUSES.has(meta.statusKey)) {
      throw new Error('لا يمكن تعيين كابتن لهذه الرحلة في حالتها الحالية.');
    }

    const requestType = normalizeTaxiType(
      row.taxi_type || meta.taxiType || meta.payload?.taxiType
    );
    if (requestType !== captain.taxiType) {
      throw new Error('نوع مركبة الكابتن لا يطابق نوع الرحلة.');
    }

    const previousDriver = String(row.driver_phone || meta.driverPhone || '').trim();
    if (phonesOverlap(previousDriver, normalizedTarget)) {
      throw new Error('هذا الكابتن معيّن للرحلة بالفعل.');
    }

    const targetActive = await getDriverActiveRequest(normalizedTarget);
    if (targetActive && String(targetActive.id) !== id) {
      throw new Error('الكابتن لديه رحلة نشطة أخرى.');
    }

    const wasPending = meta.statusKey === 'pending';
    const assignedAt = nowIso();
    const nextStatusKey = wasPending ? 'accepted' : meta.statusKey;
    const nextStatusAr = wasPending
      ? 'تم القبول'
      : String(meta.payload.statusAr || meta.statusAr || 'قيد التنفيذ').trim();

    let driverLatAtAccept = Number(meta.payload.driverLatAtAccept ?? meta.payload.driverLat ?? 0);
    let driverLngAtAccept = Number(meta.payload.driverLngAtAccept ?? meta.payload.driverLng ?? 0);
    if (!driverLatAtAccept || !driverLngAtAccept) {
      try {
        const state = await getUserState(normalizedTarget);
        const profile = state?.driverProfile || {};
        driverLatAtAccept = Number(profile.latitude ?? profile.lat ?? 0);
        driverLngAtAccept = Number(profile.longitude ?? profile.lng ?? 0);
      } catch (_) {}
    }

    const nextPayload = {
      ...meta.payload,
      statusKey: nextStatusKey,
      statusAr: nextStatusAr,
      driverId: normalizedTarget,
      driverName: captain.name,
      driverPhone: normalizedTarget,
      driverPhoto: captain.driverPhoto,
      carImage: captain.carImage,
      driverVehicleInfo: captain.vehicleInfo || null,
      vehicleModel: captain.vehicleModel || null,
      plateNumber: captain.plateNumber || null,
      driverLat: driverLatAtAccept || meta.payload.driverLat || null,
      driverLng: driverLngAtAccept || meta.payload.driverLng || null,
      driverLocationUpdatedAt: assignedAt,
      driverLatAtAccept: driverLatAtAccept || null,
      driverLngAtAccept: driverLngAtAccept || null,
      acceptedAt: wasPending ? assignedAt : meta.payload.acceptedAt || assignedAt,
      adminAssignedAt: assignedAt,
      adminAssignedBy: String(options.adminPhone || '').trim() || null,
      adminAssignedCaptainPhone: normalizedTarget,
      adminAssignedPreviousDriverPhone: previousDriver || null,
      assignedByAdmin: true,
      updatedAt: assignedAt,
    };

    const supabase = assertSupabaseAdmin();
    const { data: updated, error } = await supabase
      .from('taxi_requests')
      .update({
        driver_phone: normalizedTarget,
        driver_name: captain.name,
        vehicle_info: captain.vehicleInfo || null,
        status_key: nextStatusKey,
        request_payload: nextPayload,
        accepted_at: wasPending ? assignedAt : row.accepted_at || assignedAt,
        updated_at: assignedAt,
      })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!updated) throw new Error('تعذّر تعيين الكابتن. حدّث الحالة وحاول مجدداً.');

    const formatted = formatTaxiRequestForClient(updated);
    const customerPhone = String(row.phone ?? meta.customerPhone ?? '').trim();

    try {
      const {
        notifyDriverAdminAssigned,
        notifyDriverAccepted,
        notifyAdminReassignedCaptain,
      } = require('../../../push/taxi_push_events');
      const { sendPushToPhone } = require('../../../push_events');

      const wave = await notifyDriverAdminAssigned(
        {
          ...formatted,
          taxiType: requestType,
          serviceKind: meta.payload?.serviceKind,
        },
        normalizedTarget,
      );
      const auditTrigger =
        previousDriver && !phonesOverlap(previousDriver, normalizedTarget)
          ? 'admin_reassign'
          : 'admin_assign';
      await appendDriverPushAudit(id, { trigger: auditTrigger, ...wave });

      if (wasPending) {
        notifyDriverAccepted(customerPhone, captain.name, captain.vehicleInfo, id).catch(() => {});
      } else if (customerPhone) {
        notifyAdminReassignedCaptain(
          customerPhone,
          captain.name,
          captain.vehicleInfo,
          id,
        ).catch(() => {});
      }

      if (previousDriver && !phonesOverlap(previousDriver, normalizedTarget)) {
        await sendPushToPhone(
          previousDriver,
          {
            title: 'تم سحب الرحلة',
            body: 'أعادت الإدارة تعيين هذه الرحلة لكابتن آخر',
            data: {
              audience: 'driver',
              eventKey: 'taxi:admin_unassigned',
              requestId: id,
              orderId: id,
            },
          },
          { showSystemBanner: true, immediate: true },
        );
      }
    } catch (pushError) {
      console.error('taxi admin assign push error:', pushError?.message || pushError);
    }

    try {
      const { socketBroadcast, customerRoom, tripRoom } = require('../../../lib/socket_broadcast');
      void socketBroadcast({
        room: customerRoom(customerPhone),
        event: 'taxi:status',
        payload: formatted,
      });
      void socketBroadcast({
        room: tripRoom(id),
        event: 'taxi:status',
        payload: formatted,
      });
    } catch (socketError) {
      console.error('taxi admin assign socket error:', socketError?.message || socketError);
    }

    if (wasPending) {
      const { recordRequestAccepted, recordDriverAccepted } = require('../../../services/taxi_metrics_service');
      recordRequestAccepted(id, row.created_at);
      recordDriverAccepted(normalizedTarget);
    }

    return formatTaxiRequestForAdmin(updated);
  } finally {
    await releaseLock(`taxi:admin_assign:${id}`, lock.token);
  }
}

const ADMIN_REMATCHABLE_TAXI_STATUSES = new Set([
  'pending',
  'accepted',
  'on_way',
  'arrived',
]);

/**
 * إعادة الرحلة للـ pool من لوحة الإدارة وإعادة إرسال الطلب لباقي الكباتن.
 * يستبعد الكابتن الحالي (إن وُجد) من الموجة التالية.
 */
async function adminRematchTaxiRequest(requestId, options = {}) {
  const id = String(requestId || '').trim();
  if (!id) throw new Error('Request id is required.');

  const lock = await acquireLock(`taxi:admin_rematch:${id}`, 10_000);
  if (!lock.ok) {
    throw new Error('جاري معالجة الرحلة... حاول مجدداً.');
  }

  try {
    const row = await selectSingle('taxi_requests', 'id', id);
    if (!row) throw new Error('Trip not found.');

    const meta = readTaxiMeta(row);
    const statusKey =
      meta.statusKey === 'in_progress' ? 'picked_up' : meta.statusKey;
    if (!ADMIN_REMATCHABLE_TAXI_STATUSES.has(statusKey)) {
      throw new Error('لا يمكن إعادة إرسال هذه الرحلة في حالتها الحالية.');
    }

    const previousDriver = String(
      row.driver_phone || meta.driverPhone || meta.payload.driverPhone || '',
    ).trim();

    const rejectedIds = Array.isArray(meta.payload.rejectedByDriverIds)
      ? [...meta.payload.rejectedByDriverIds]
      : [];
    if (previousDriver) {
      const variants = getPhoneVariants(previousDriver);
      for (const v of variants) {
        if (!rejectedIds.includes(v)) rejectedIds.push(v);
      }
    }

    const rematchedAt = nowIso();
    const reason = String(options.reason || '').trim();
    const nextPayload = {
      ...meta.payload,
      statusKey: 'pending',
      statusAr: 'أعادت الإدارة البحث عن كابتن',
      rejectedByDriverIds: rejectedIds,
      driverId: null,
      driverName: null,
      driverPhone: null,
      driverPhoto: null,
      carImage: null,
      driverVehicleInfo: null,
      vehicleModel: null,
      plateNumber: null,
      driverLat: null,
      driverLng: null,
      driverLocationUpdatedAt: null,
      driverLatAtAccept: null,
      driverLngAtAccept: null,
      initialPickupEtaSeconds: null,
      acceptedAt: null,
      onWayAt: null,
      arrivedAt: null,
      assignedByAdmin: false,
      adminAssignedAt: null,
      adminAssignedCaptainPhone: null,
      adminAssignedPreviousDriverPhone: previousDriver || null,
      adminRematchedAt: rematchedAt,
      adminRematchedBy: String(options.adminPhone || '').trim() || null,
      adminRematchReason: reason || null,
      rematchCount: Number(meta.payload.rematchCount || 0) + 1,
      updatedAt: rematchedAt,
    };

    const supabase = assertSupabaseAdmin();
    const { data: updated, error } = await supabase
      .from('taxi_requests')
      .update({
        driver_phone: null,
        driver_name: null,
        vehicle_info: null,
        status_key: 'pending',
        request_payload: nextPayload,
        accepted_at: null,
        updated_at: rematchedAt,
      })
      .eq('id', id)
      .in('status_key', [...ADMIN_REMATCHABLE_TAXI_STATUSES])
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!updated) {
      throw new Error('تعذّر إعادة إرسال الرحلة. حدّث الحالة وحاول مجدداً.');
    }

    const formatted = formatTaxiRequestForClient(updated);
    const customerPhone = String(row.phone ?? meta.customerPhone ?? '').trim();

    try {
      const { notifyTripTransferredToPool } = require('../../../push/taxi_push_events');
      if (customerPhone) {
        notifyTripTransferredToPool(customerPhone, id).catch((e) => {
          console.error('taxi admin rematch customer push error:', e?.message || e);
        });
      }
    } catch (e) {
      console.error('taxi admin rematch customer push error:', e?.message || e);
    }

    try {
      notifyDriversForNewRequest(
        formatted,
        nextPayload,
        meta.taxiType,
        'admin_rematch',
      ).catch((e) => {
        console.error('taxi admin rematch broadcast error:', e?.message || e);
      });
    } catch (e) {
      console.error('taxi admin rematch broadcast error:', e?.message || e);
    }

    return formatTaxiRequestForAdmin(updated);
  } finally {
    await releaseLock(`taxi:admin_rematch:${id}`, lock.token);
  }
}

module.exports = {
  formatTaxiRequestForClient,
  formatTaxiRequestForDriver,
  formatTaxiRequestForAdmin,
  attachTaxiPushAudits,
  hideCustomerPhoneFromTaxiRequest,
  enrichTaxiRequestForClient,
  readTaxiMeta,
  generateRequestNumber,
  haversineDistance,
  createTaxiRequest,
  acceptTaxiRequest,
  rejectTaxiRequest,
  transferTaxiRequest,
  adminAssignTaxiRequest,
  adminRematchTaxiRequest,
  resolveRegisteredTaxiCaptain,
  updateTaxiRequestStatus,
  cancelTaxiRequest,
  bumpCustomerTaxiFare,
  requestTripCancellation,
  updateDriverTripLocation,
  updateDriverPresenceLocation,
  expireStalePendingTaxiRequests,
  runExpandingSearchWaves,
  remindDriversToCompleteTrips,
  maybeExpireDueBazaarReturnTrips,
  getAdminTaxiTrips,
  getAdminTaxiComplaints,
  getNearbyDrivers,
  getActiveDriverPhonesByTaxiType,
  getDriverIncomingRequests,
  getDriverBazaarIncomingRequests,
  getTaxiRequestForActor,
  completeBazaarOutbound,
  claimBazaarReturnByCode,
  isDesignatedBazaarDriver,
  expireDueBazaarReturnTrips,
  getCustomerActiveRequest,
  getCustomerRecentRequest,
  getDriverActiveRequest,
  getCustomerPendingRatingRequest,
  getCustomerHistory,
  getDriverHistory,
  rateTaxiRequest,
  submitTaxiComplaint,
  createTaxiComplaint,
  listTaxiComplaints,
  resolveTaxiComplaint,
  setDriverOnlineStatus,
};
