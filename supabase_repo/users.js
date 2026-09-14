const {
  selectSingleByPhone,
  resolvePhoneKey,
  canonicalPhone,
  nowIso,
  assignIfDefined,
  saveRow,
  deleteRow,
  getPhoneVariants,
  assertSupabaseAdmin,
  PLATFORM_ADMIN_PHONES,
} = require('./common');
const { stripBase64Deep, pickRemoteImageUrl } = require('../services/image_refs');
const { stripForbiddenAppStateKeys, sanitizeAppState } = require('../services/app_state_policy');

async function getAppUser(phone) {
  return selectSingleByPhone('app_users', phone);
}

async function getAppUserId(phone) {
  const appUser = await getAppUser(phone);
  return appUser?.id ? String(appUser.id) : null;
}

async function ensureAppUser(phone, seed = {}) {
  const existing = await getAppUser(phone);
  if (existing) return existing;
  await saveAppUser(phone, seed);
  return getAppUser(phone);
}

async function saveAppUser(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const existing = await getAppUser(phoneKey);
  const incomingType = data.account_type ?? data.accountType;
  if (
    incomingType &&
    existing?.account_type &&
    existing.account_type !== incomingType
  ) {
    throw new Error('Account type is locked and cannot be changed.');
  }

  const payload = { phone: phoneKey, updated_at: nowIso() };
  // المستخدمون الجدد يحصلون على id فوراً — بدونه يفشل ربط driver_profiles
  // (user_id) ويظهر للسائق "بانتظار الموافقة" بينما لا يُحفظ شيء لدى الإدارة.
  if (!existing) {
    payload.id = require('crypto').randomUUID();
  }
  assignIfDefined(payload, 'full_name', data.fullName ?? data.full_name);
  assignIfDefined(payload, 'role', data.role);
  assignIfDefined(payload, 'account_type', incomingType);
  const avatarRef = pickRemoteImageUrl(
    data.avatar_url,
    data.avatarUrl,
    data.avatar_base64,
    data.avatarBase64
  );
  if (avatarRef) {
    assignIfDefined(payload, 'avatar_base64', avatarRef);
  }
  const customerAvatar = pickRemoteImageUrl(
    data.customer_avatar_base64,
    data.customerAvatarBase64,
    avatarRef
  );
  assignIfDefined(
    payload,
    'customer_avatar_base64',
    customerAvatar
  );
  return saveRow('app_users', payload, 'phone');
}

async function deleteAppUser(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();

  const phoneVariants = getPhoneVariants(phoneKey);
  if (phoneVariants.length > 0) {
    const { error: tokenError } = await supabase
      .from('device_tokens')
      .delete()
      .in('phone', phoneVariants);
    if (tokenError && !/does not exist/i.test(tokenError.message || '')) {
      throw new Error(tokenError.message);
    }

    const { error: inboxError } = await supabase
      .from('push_inbox_state')
      .delete()
      .in('phone', phoneVariants);
    if (inboxError && !/does not exist/i.test(inboxError.message || '')) {
      console.warn('deleteAppUser push_inbox_state cleanup:', inboxError.message);
    }

    for (const tableColumn of ['merchant_phone', 'customer_phone']) {
      const { error: reviewError } = await supabase
        .from('merchant_reviews')
        .delete()
        .in(tableColumn, phoneVariants);
      if (reviewError && !/does not exist/i.test(reviewError.message || '')) {
        console.warn(`deleteAppUser reviews cleanup (${tableColumn}):`, reviewError.message);
      }
    }
  }

  return deleteRow('app_users', 'phone', phoneKey);
}

async function getUserState(phone) {
  const row = await selectSingleByPhone('app_state', phone);
  if (!row?.state) return null;
  return sanitizeAppState(row.state);
}

async function saveUserState(phone, state = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  await ensureAppUser(phoneKey);
  const sanitized = sanitizeAppState(stripBase64Deep(state || {}));
  // استخدام دالة merge_app_state للدمج الذري بدلاً من الاستبدال الكامل
  // هذا يمنع فقدان بيانات driverProfile, courierProfile, merchantStore, إلخ.
  try {
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase.rpc('merge_app_state', {
      p_phone: phoneKey,
      p_state: sanitized,
    });
    if (error) {
      // fallback: اقرأ الحالة الحالية وادمجها يدوياً
      const current = await getUserState(phoneKey);
      const merged = stripBase64Deep({ ...(current || {}), ...sanitized });
      const payload = { phone: phoneKey, state: merged, updated_at: nowIso() };
      return saveRow('app_state', payload, 'phone');
    }
    return data;
  } catch (e) {
    // fallback نهائي: اقرأ الحالة الحالية وادمجها يدوياً
    try {
      const current = await getUserState(phoneKey);
      const merged = stripBase64Deep({ ...(current || {}), ...sanitized });
      const payload = { phone: phoneKey, state: merged, updated_at: nowIso() };
      return saveRow('app_state', payload, 'phone');
    } catch (_) {
      const payload = { phone: phoneKey, state: sanitized, updated_at: nowIso() };
      return saveRow('app_state', payload, 'phone');
    }
  }
}

async function deleteUserState(phone) {
  return deleteRow('app_state', 'phone', phone);
}

async function getConfiguredAdminPhones() {
  const envPhones = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const allPhones = [...envPhones, ...PLATFORM_ADMIN_PHONES];
  const expanded = new Set();
  for (const phone of allPhones) {
    for (const variant of getPhoneVariants(phone)) {
      expanded.add(variant);
    }
  }
  return expanded;
}

async function assertAdminAccess(phone) {
  // فحص سريع بدون DB لأرقام المنصة/ADMIN_PHONES قبل أي استعلام قد يُجهَض.
  const raw = String(phone || '').trim();
  const syncPhones = await getConfiguredAdminPhones();
  const rawVariants = getPhoneVariants(raw);
  if (rawVariants.some((item) => syncPhones.has(item))) {
    return canonicalPhone(raw) || raw;
  }

  const normalized = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(normalized);
  if (variants.some((item) => syncPhones.has(item))) {
    return normalized;
  }

  try {
    const appUser = await getAppUser(normalized);
    const appUserRole = String(appUser?.role ?? '').trim();
    if (appUserRole === 'admin') {
      return normalized;
    }
  } catch (error) {
    console.warn('assertAdminAccess getAppUser:', error?.message || error);
  }

  try {
    const supabase = assertSupabaseAdmin();
    const { data: adminRow } = await supabase
      .from('admin_roles')
      .select('phone, role')
      .eq('phone', normalized)
      .maybeSingle();
    if (adminRow?.role) {
      return normalized;
    }
  } catch (error) {
    console.warn('assertAdminAccess admin_roles:', error?.message || error);
  }

  throw new Error('Admin access required.');
}

module.exports = {
  getAppUser,
  getAppUserId,
  ensureAppUser,
  saveAppUser,
  deleteAppUser,
  getUserState,
  saveUserState,
  deleteUserState,
  getConfiguredAdminPhones,
  assertAdminAccess,
};
