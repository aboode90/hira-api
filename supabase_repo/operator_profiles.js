const {
  selectSingleByPhone,
  selectMany,
  resolvePhoneKey,
  saveRow,
  nowIso,
  normalizeObject,
  assertSupabaseAdmin,
  hasColumn,
  getPhoneVariants,
} = require('./common');
const { ensureAppUser, getAppUserId } = require('./users');
const { stripBase64Deep } = require('../services/image_refs');
const { withRedis } = require('../lib/redis_client');

async function readLegacyAppStateProfile(phoneKey, key) {
  const row = await selectSingleByPhone('app_state', phoneKey);
  const slice = row?.state?.[key];
  if (!slice || typeof slice !== 'object' || Array.isArray(slice)) return null;
  return stripBase64Deep({ ...slice });
}

function resolveApprovalStatus(profile) {
  if (profile?.isApproved === true || profile?.is_approved === true) {
    return 'approved';
  }
  const status = String(profile?.approvalStatus ?? profile?.approval_status ?? '').trim();
  if (status === 'rejected' || status === 'approved' || status === 'pending') {
    return status;
  }
  return 'pending';
}

function rowToDriverProfileMap(row) {
  if (!row) return null;
  const payload = normalizeObject(row.profile_payload);
  const approvalStatus = row.approval_status || resolveApprovalStatus(payload);
  return stripBase64Deep({
    ...payload,
    name: String(payload.name ?? row.display_name ?? '').trim(),
    phone: String(payload.phone ?? row.phone ?? '').trim(),
    type: String(row.driver_type ?? payload.type ?? 'taxi').trim() || 'taxi',
    isApproved: row.is_approved === true,
    is_approved: row.is_approved === true,
    approvalStatus,
    approval_status: approvalStatus,
    available: row.available !== false,
    isSuspended: row.is_suspended === true,
    is_suspended: row.is_suspended === true,
    latitude: row.latitude ?? payload.latitude ?? payload.lat,
    longitude: row.longitude ?? payload.longitude ?? payload.lng,
    lat: row.latitude ?? payload.latitude ?? payload.lat,
    lng: row.longitude ?? payload.longitude ?? payload.lng,
  });
}

function rowToCourierProfileMap(row) {
  if (!row) return null;
  const payload = normalizeObject(row.profile_payload);
  const approvalStatus = row.approval_status || resolveApprovalStatus(payload);
  return stripBase64Deep({
    ...payload,
    name: String(payload.name ?? row.display_name ?? '').trim(),
    phone: String(payload.phone ?? row.phone ?? '').trim(),
    isApproved: row.is_approved === true,
    is_approved: row.is_approved === true,
    approvalStatus,
    approval_status: approvalStatus,
    available: row.available !== false,
    isSuspended: row.is_suspended === true,
    is_suspended: row.is_suspended === true,
  });
}

async function attachUserIdIfRequired(table, phoneKey, row) {
  if (!(await hasColumn(table, 'user_id'))) return row;
  let userId = await getAppUserId(phoneKey);
  if (!userId) {
    // تأمين: إن كان app_users.id فارغاً (مستخدم قديم) نولّد له id بدل
    // إفشال حفظ الملف بالكامل — وإلا يبقى السائق "بانتظار الموافقة"
    // بينما لا يظهر أي طلب لدى الإدارة.
    try {
      await ensureAppUser(phoneKey);
      const supabase = assertSupabaseAdmin();
      await supabase
        .from('app_users')
        .update({ id: require('crypto').randomUUID() })
        .eq('phone', phoneKey);
      userId = await getAppUserId(phoneKey);
    } catch (_) {}
  }
  if (!userId) {
    throw new Error('تعذر ربط الملف بحساب المستخدم. تأكد من تسجيل الحساب أولاً.');
  }
  return { ...row, user_id: userId };
}

function buildDriverRow(phoneKey, merged) {
  const approvalStatus = resolveApprovalStatus(merged);
  const isApproved = approvalStatus === 'approved';
  return {
    phone: phoneKey,
    display_name: String(merged.name ?? '').trim() || null,
    driver_type: String(merged.type ?? 'taxi').trim() || 'taxi',
    approval_status: approvalStatus,
    is_approved: isApproved,
    available: merged.available !== false && merged.isSuspended !== true,
    is_suspended: merged.isSuspended === true,
    latitude:
      merged.latitude != null
        ? Number(merged.latitude)
        : merged.lat != null
          ? Number(merged.lat)
          : null,
    longitude:
      merged.longitude != null
        ? Number(merged.longitude)
        : merged.lng != null
          ? Number(merged.lng)
          : null,
    profile_payload: merged,
    updated_at: nowIso(),
  };
}

function buildCourierRow(phoneKey, merged) {
  const approvalStatus = resolveApprovalStatus(merged);
  const isApproved = approvalStatus === 'approved';
  return {
    phone: phoneKey,
    display_name: String(merged.name ?? '').trim() || null,
    approval_status: approvalStatus,
    is_approved: isApproved,
    available: merged.available !== false && merged.isSuspended !== true,
    is_suspended: merged.isSuspended === true,
    profile_payload: merged,
    updated_at: nowIso(),
  };
}

// كاش قصير الأمد لملف السائق (30 ثانية) — يخفّض استعلامات القبول/التفاصيل
// المتكررة. يُبطَل فوراً عند الحفظ/الحذف/الموافقة عبر saveDriverProfile.
const DRIVER_PROFILE_CACHE_TTL_MS = 120_000;
const _driverProfileCache = new Map(); // phoneKey -> { at, value }

function driverProfileCacheKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function invalidateDriverProfileCache(phone) {
  const key = driverProfileCacheKey(phone);
  if (key) _driverProfileCache.delete(key);
}

async function getDriverProfile(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const cacheKey = driverProfileCacheKey(phoneKey);
  const cached = cacheKey ? _driverProfileCache.get(cacheKey) : null;
  if (cached && Date.now() - cached.at < DRIVER_PROFILE_CACHE_TTL_MS) {
    return cached.value;
  }
  const row = await selectSingleByPhone('driver_profiles', phoneKey);
  const value = row
    ? rowToDriverProfileMap(row)
    : await readLegacyAppStateProfile(phoneKey, 'driverProfile');
  if (cacheKey) {
    _driverProfileCache.set(cacheKey, { at: Date.now(), value });
    if (_driverProfileCache.size > 600) {
      const now = Date.now();
      for (const [key, entry] of _driverProfileCache) {
        if (now - entry.at > DRIVER_PROFILE_CACHE_TTL_MS) {
          _driverProfileCache.delete(key);
        }
      }
    }
  }
  return value;
}

async function saveDriverProfile(phone, patch = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  invalidateDriverProfileCache(phoneKey);
  await ensureAppUser(phoneKey);
  const existing = (await getDriverProfile(phoneKey)) || {};
  const merged = stripBase64Deep({ ...existing, ...normalizeObject(patch) });
  const row = await attachUserIdIfRequired(
    'driver_profiles',
    phoneKey,
    buildDriverRow(phoneKey, merged),
  );
  try {
    await saveRow('driver_profiles', row, 'phone');
  } catch (saveError) {
    const msg = String(saveError?.message || '');
    if (msg.includes('has no field "name"')) {
      // Bypass broken trigger: delete the row and retry
      await deleteDriverProfile(phoneKey);
      await saveRow('driver_profiles', row, 'phone');
    } else {
      throw saveError;
    }
  }
  // تأكد من تحديث دور المستخدم إلى 'driver'
  const { assertSupabaseAdmin } = require('./common');
  const supabase = assertSupabaseAdmin();
  await supabase.from('app_users').update({ role: 'driver', account_type: 'driver' }).eq('phone', phoneKey);
  return rowToDriverProfileMap(row);
}

async function deleteDriverProfile(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  invalidateDriverProfileCache(phoneKey);
  const supabase = assertSupabaseAdmin();
  const { error } = await supabase.from('driver_profiles').delete().eq('phone', phoneKey);
  if (error && !/does not exist/i.test(error.message || '')) {
    throw new Error(error.message);
  }
}

function phoneLocKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function saveCourierLiveLocation(phone, lat, lng) {
  const phoneKey = await resolvePhoneKey(phone);
  const a = Number(lat);
  const b = Number(lng);
  if (!phoneKey || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < 0.0001 || Math.abs(b) < 0.0001) {
    throw new Error('Valid location is required.');
  }
  const now = nowIso();
  const payload = { lat: a, lng: b, updatedAt: now };
  await withRedis((client) =>
    client.set(`courier:loc:${phoneLocKey(phoneKey)}`, JSON.stringify(payload), 'EX', 600),
  );

  const existing = (await getCourierProfile(phoneKey)) || {};
  const previousAt = Date.parse(String(existing.locationUpdatedAt || '')) || 0;
  if (Date.now() - previousAt < 90_000) {
    return { ok: true, ...payload, persisted: false };
  }
  await saveCourierProfile(phoneKey, {
    lastLat: a,
    lastLng: b,
    latitude: a,
    longitude: b,
    lat: a,
    lng: b,
    locationUpdatedAt: now,
  });
  return { ok: true, ...payload, persisted: true };
}

async function readCourierLiveLocations(phones = []) {
  const list = Array.isArray(phones) ? phones.map((p) => String(p || '').trim()).filter(Boolean) : [];
  const byKey = new Map();
  const keys = [...new Set(list.map(phoneLocKey).filter(Boolean))];
  if (keys.length > 0) {
    const redisVals = await withRedis(async (client) => {
      const redisKeys = keys.map((key) => `courier:loc:${key}`);
      return client.mget(redisKeys);
    }, []);
    (redisVals || []).forEach((raw, index) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        const lat = Number(parsed.lat);
        const lng = Number(parsed.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        byKey.set(keys[index], {
          lat,
          lng,
          updatedAt: parsed.updatedAt || null,
        });
      } catch (_) {}
    });
  }

  try {
    const supabase = assertSupabaseAdmin();
    const variants = [...new Set(list.flatMap((phone) => getPhoneVariants(phone)))];
    if (variants.length > 0) {
      const { data, error } = await supabase
        .from('driver_locations')
        .select('phone, lat, lng, location_updated_at, updated_at')
        .in('phone', variants);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const key = phoneLocKey(row.phone);
          const lat = Number(row.lat);
          const lng = Number(row.lng);
          if (!key || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 0.0001) continue;
          const existing = byKey.get(key);
          const nextAt = Date.parse(String(row.location_updated_at || row.updated_at || '')) || 0;
          const prevAt = Date.parse(String(existing?.updatedAt || '')) || 0;
          if (!existing || nextAt >= prevAt) {
            byKey.set(key, {
              lat,
              lng,
              updatedAt: row.location_updated_at || row.updated_at || null,
            });
          }
        }
      }
    }
  } catch (_) {}

  return byKey;
}

async function getCourierProfile(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const row = await selectSingleByPhone('courier_profiles', phoneKey);
  if (row) return rowToCourierProfileMap(row);
  return readLegacyAppStateProfile(phoneKey, 'courierProfile');
}

async function saveCourierProfile(phone, patch = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  await ensureAppUser(phoneKey);
  const existing = (await getCourierProfile(phoneKey)) || {};
  const merged = stripBase64Deep({ ...existing, ...normalizeObject(patch) });
  const row = await attachUserIdIfRequired(
    'courier_profiles',
    phoneKey,
    buildCourierRow(phoneKey, merged),
  );
  await saveRow('courier_profiles', row, 'phone');
  return rowToCourierProfileMap(row);
}

async function deleteCourierProfile(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const { error } = await supabase.from('courier_profiles').delete().eq('phone', phoneKey);
  if (error && !/does not exist/i.test(error.message || '')) {
    throw new Error(error.message);
  }
}

async function getActiveOperatorPhones(table, role) {
  const profiles = await selectMany(
    table,
    [
      { method: 'eq', column: 'is_approved', value: true },
      { method: 'eq', column: 'available', value: true },
      { method: 'eq', column: 'is_suspended', value: false },
    ],
    { column: 'updated_at', ascending: false },
  );
  const profilePhones = [
    ...new Set(
      profiles
        .map((row) => String(row?.phone ?? '').trim())
        .filter(Boolean),
    ),
  ];
  if (!profilePhones.length) return [];

  // Only notify operators who are currently using that account role. This
  // avoids duplicate courier + driver alerts on multi-role phone numbers.
  const users = await selectMany(
    'app_users',
    [
      { method: 'in', column: 'phone', value: profilePhones },
      { method: 'eq', column: 'role', value: role },
    ],
    { column: 'updated_at', ascending: false },
  );
  return [
    ...new Set(
      users
        .map((row) => String(row?.phone ?? '').trim())
        .filter(Boolean),
    ),
  ];
}

async function getActiveCourierPhones() {
  return getActiveOperatorPhones('courier_profiles', 'delivery');
}

async function getActiveDriverPhones() {
  return getActiveOperatorPhones('driver_profiles', 'driver');
}

module.exports = {
  getDriverProfile,
  saveDriverProfile,
  deleteDriverProfile,
  invalidateDriverProfileCache,
  getCourierProfile,
  saveCourierProfile,
  saveCourierLiveLocation,
  readCourierLiveLocations,
  deleteCourierProfile,
  rowToDriverProfileMap,
  rowToCourierProfileMap,
  getActiveCourierPhones,
  getActiveDriverPhones,
};
