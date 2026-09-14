const {
  nowIso,
  assignIfDefined,
  normalizeArray,
  normalizeObject,
  parseOptionalBoolean,
  resolvePhoneKey,
  selectMany,
  selectManyColumns,
  hasColumn,
  assertSupabaseAdmin,
} = require('./common');

const TABLE = 'merchant_service_profiles';
let tableReady = null;

/** أعمدة قائمة العرض — بدون profile_image_base64 لتقليل Egress. */
const LISTING_SERVICE_PROFILE_SELECT = [
  'phone',
  'service_id',
  'service_sub_category',
  'store_name',
  'description',
  'address',
  'whatsapp',
  'open_time',
  'close_time',
  'cover_image_url',
  'logo_image_url',
  'profile_image_url',
  'latitude',
  'longitude',
  'is_open',
  'is_approved',
  'approval_status',
  'is_frozen',
  'restaurant_category',
  'updated_at',
  'created_at',
].join(',');

const LISTING_SERVICE_PROFILE_SELECT_FALLBACK = [
  'phone',
  'service_id',
  'service_sub_category',
  'store_name',
  'description',
  'cover_image_url',
  'logo_image_url',
  'updated_at',
].join(',');

async function serviceProfilesTableReady() {
  if (tableReady !== null) return tableReady;
  tableReady = await hasColumn(TABLE, 'phone');
  return tableReady;
}

function normalizeSubCategory(value) {
  return String(value ?? '').trim();
}

function resolveServiceSubCategoryFromData(data = {}, serviceId = '') {
  const direct = normalizeSubCategory(
    data.service_sub_category ?? data.serviceSubCategory ?? data.subCategoryId,
  );
  if (direct) return direct;
  if (String(serviceId).trim() !== 'beauty') return '';
  const info = normalizeObject(data.professional_info ?? data.professionalInfo);
  return normalizeSubCategory(info.serviceSubCategory ?? info.service_sub_category);
}

function resolveServiceSubCategoryFromProfile(profile = {}, serviceId = '') {
  const direct = normalizeSubCategory(profile.service_sub_category ?? profile.serviceSubCategory);
  if (direct) return direct;
  if (String(serviceId).trim() !== 'beauty') return '';
  const info = normalizeObject(profile.professional_info ?? profile.professionalInfo);
  return normalizeSubCategory(info.serviceSubCategory ?? info.service_sub_category);
}

function serviceProfileKey(serviceId, serviceSubCategory = '') {
  const id = String(serviceId || '').trim();
  const sub = normalizeSubCategory(serviceSubCategory);
  return sub ? `${id}::${sub}` : id;
}

function parseServiceProfileKey(key = '') {
  const raw = String(key || '').trim();
  const split = raw.split('::');
  if (split.length >= 2) {
    return {
      serviceId: split[0],
      serviceSubCategory: split.slice(1).join('::'),
    };
  }
  return { serviceId: raw, serviceSubCategory: '' };
}

async function listMerchantServiceProfiles(phone) {
  if (!(await serviceProfilesTableReady())) return [];
  const phoneKey = await resolvePhoneKey(phone);
  const rows = await selectMany(
    TABLE,
    [{ method: 'eq', column: 'phone', value: phoneKey }],
    { column: 'updated_at', ascending: false },
    50,
  );
  return rows;
}

async function getMerchantServiceProfile(phone, serviceId, serviceSubCategory = '') {
  if (!(await serviceProfilesTableReady())) return null;
  const phoneKey = await resolvePhoneKey(phone);
  const sid = String(serviceId || '').trim();
  if (!sid) return null;
  const sub = normalizeSubCategory(serviceSubCategory);
  const rows = await selectMany(
    TABLE,
    [
      { method: 'eq', column: 'phone', value: phoneKey },
      { method: 'eq', column: 'service_id', value: sid },
      { method: 'eq', column: 'service_sub_category', value: sub },
    ],
    null,
    1,
  );
  return rows[0] || null;
}

function buildServiceProfilePayload(phoneKey, serviceId, serviceSubCategory, data = {}, existing = {}) {
  const payload = {
    phone: phoneKey,
    service_id: serviceId,
    service_sub_category: normalizeSubCategory(serviceSubCategory),
    updated_at: nowIso(),
  };

  assignIfDefined(payload, 'store_name', data.store_name ?? data.storeName ?? existing.store_name);
  assignIfDefined(payload, 'description', data.description ?? existing.description);
  assignIfDefined(
    payload,
    'restaurant_category',
    data.restaurant_category ?? data.restaurantCategory ?? existing.restaurant_category,
  );
  assignIfDefined(
    payload,
    'professional_category_id',
    data.professional_category_id ??
      data.professionalCategoryId ??
      existing.professional_category_id,
  );

  const existingInfo = normalizeObject(existing.professional_info ?? existing.professionalInfo);
  const incomingInfo = normalizeObject(data.professional_info ?? data.professionalInfo);
  if (Object.keys(incomingInfo).length > 0 || Object.keys(existingInfo).length > 0) {
    payload.professional_info = { ...existingInfo, ...incomingInfo };
  }

  assignIfDefined(
    payload,
    'cover_image_url',
    data.cover_image_url ?? data.coverImageUrl ?? data.coverImageBase64 ?? existing.cover_image_url,
  );
  assignIfDefined(
    payload,
    'logo_image_url',
    data.logo_image_url ?? data.logoImageUrl ?? data.logoImageBase64 ?? existing.logo_image_url,
  );
  assignIfDefined(
    payload,
    'profile_image_url',
    data.profile_image_url ?? data.profileImageUrl ?? existing.profile_image_url,
  );
  assignIfDefined(
    payload,
    'profile_image_base64',
    data.profile_image_base64 ??
      data.profileImageBase64 ??
      data.profile_image_url ??
      data.profileImageUrl ??
      existing.profile_image_base64,
  );

  if (data.work_sample_images_base64 !== undefined || data.workSampleImagesBase64 !== undefined) {
    payload.work_sample_images_base64 = normalizeArray(
      data.work_sample_images_base64 ?? data.workSampleImagesBase64,
    );
  } else if (existing.work_sample_images_base64 !== undefined) {
    payload.work_sample_images_base64 = normalizeArray(existing.work_sample_images_base64);
  }

  assignIfDefined(payload, 'open_time', data.open_time ?? data.openTime ?? existing.open_time);
  assignIfDefined(payload, 'close_time', data.close_time ?? data.closeTime ?? existing.close_time);
  assignIfDefined(
    payload,
    'doctor_phone',
    data.doctor_phone ?? data.doctorPhone ?? existing.doctor_phone,
  );
  assignIfDefined(
    payload,
    'clinic_phone',
    data.clinic_phone ?? data.clinicPhone ?? existing.clinic_phone,
  );
  if (data.delivery_fee !== undefined || data.deliveryFee !== undefined) {
    payload.delivery_fee = Number.parseInt(data.delivery_fee ?? data.deliveryFee, 10) || 0;
  }
  if (data.rate_per_km !== undefined || data.ratePerKm !== undefined) {
    const raw = Number.parseInt(data.rate_per_km ?? data.ratePerKm, 10);
    payload.rate_per_km = Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  assignIfDefined(
    payload,
    'delivery_areas',
    data.delivery_areas ?? data.deliveryAreas ?? existing.delivery_areas,
  );

  if (data.product_sections !== undefined || data.productSections !== undefined) {
    payload.product_sections = normalizeArray(data.product_sections ?? data.productSections);
  } else if (existing.product_sections !== undefined) {
    payload.product_sections = normalizeArray(existing.product_sections);
  }

  const showPhone = parseOptionalBoolean(
    data.show_phone_to_customers ?? data.showPhoneToCustomers,
  );
  const showWhatsapp = parseOptionalBoolean(
    data.show_whatsapp_to_customers ?? data.showWhatsAppToCustomers,
  );
  if (showPhone !== undefined) payload.show_phone_to_customers = showPhone;
  if (showWhatsapp !== undefined) payload.show_whatsapp_to_customers = showWhatsapp;

  if (data.is_approved !== undefined || data.isApproved !== undefined) {
    payload.is_approved = Boolean(data.is_approved ?? data.isApproved);
  }
  assignIfDefined(
    payload,
    'approval_status',
    data.approval_status ?? data.approvalStatus ?? existing.approval_status,
  );
  if (data.is_open !== undefined || data.isOpen !== undefined) {
    payload.is_open = Boolean(data.is_open ?? data.isOpen);
  }

  return payload;
}

async function saveMerchantServiceProfile(phone, serviceId, data = {}, serviceSubCategory = '') {
  if (!(await serviceProfilesTableReady())) return null;
  const phoneKey = await resolvePhoneKey(phone);
  const sid = String(serviceId || '').trim();
  if (!sid) return null;
  const sub =
    normalizeSubCategory(serviceSubCategory) ||
    resolveServiceSubCategoryFromData(data, sid) ||
    '';
  const existing = (await getMerchantServiceProfile(phoneKey, sid, sub)) || {};
  const payload = buildServiceProfilePayload(phoneKey, sid, sub, data, existing);
  const supabase = assertSupabaseAdmin();
  const { data: saved, error } = await supabase
    .from(TABLE)
    .upsert(payload, {
      onConflict: 'phone,service_id,service_sub_category',
      ignoreDuplicates: false,
    })
    .select();
  if (error) throw new Error(error.message);
  return Array.isArray(saved) ? saved[0] || null : saved || null;
}

function mergeServiceProfileIntoMerchantShell(baseProfile = {}, serviceProfile = {}) {
  if (!serviceProfile || typeof serviceProfile !== 'object') return baseProfile;
  const merged = { ...baseProfile };
  const assign = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    merged[key] = value;
  };

  assign('store_name', serviceProfile.store_name);
  assign('description', serviceProfile.description);
  assign('restaurant_category', serviceProfile.restaurant_category);
  assign('professional_category_id', serviceProfile.professional_category_id);
  if (serviceProfile.professional_info && typeof serviceProfile.professional_info === 'object') {
    merged.professional_info = serviceProfile.professional_info;
  }
  assign('cover_image_url', serviceProfile.cover_image_url);
  assign('logo_image_url', serviceProfile.logo_image_url);
  assign('profile_image_url', serviceProfile.profile_image_url);
  assign('profile_image_base64', serviceProfile.profile_image_base64);
  if (serviceProfile.work_sample_images_base64 !== undefined) {
    merged.work_sample_images_base64 = serviceProfile.work_sample_images_base64;
  }
  assign('open_time', serviceProfile.open_time);
  assign('close_time', serviceProfile.close_time);
  assign('doctor_phone', serviceProfile.doctor_phone);
  assign('clinic_phone', serviceProfile.clinic_phone);
  if (serviceProfile.delivery_fee !== undefined) merged.delivery_fee = serviceProfile.delivery_fee;
  if (serviceProfile.rate_per_km !== undefined) merged.rate_per_km = serviceProfile.rate_per_km;
  assign('delivery_areas', serviceProfile.delivery_areas);
  if (serviceProfile.product_sections !== undefined) {
    merged.product_sections = serviceProfile.product_sections;
  }
  if (serviceProfile.service_sub_category) {
    merged.service_sub_category = serviceProfile.service_sub_category;
  }
  if (serviceProfile.show_phone_to_customers !== undefined) {
    merged.show_phone_to_customers = serviceProfile.show_phone_to_customers;
  }
  if (serviceProfile.show_whatsapp_to_customers !== undefined) {
    merged.show_whatsapp_to_customers = serviceProfile.show_whatsapp_to_customers;
  }
  if (serviceProfile.is_approved !== undefined) merged.is_approved = serviceProfile.is_approved;
  if (serviceProfile.approval_status) merged.approval_status = serviceProfile.approval_status;
  if (serviceProfile.is_open !== undefined) merged.is_open = serviceProfile.is_open;
  return merged;
}

function serializeServiceProfilesForClient(rows = []) {
  const out = {};
  for (const row of rows) {
    const key = serviceProfileKey(row.service_id, row.service_sub_category);
    out[key] = {
      serviceId: row.service_id,
      serviceSubCategory: row.service_sub_category || '',
      storeName: row.store_name || '',
      description: row.description || '',
      restaurantCategory: row.restaurant_category || '',
      professionalCategoryId: row.professional_category_id || '',
      professionalInfo: row.professional_info || {},
      coverImageUrl: row.cover_image_url || '',
      logoImageUrl: row.logo_image_url || '',
      profileImageUrl: row.profile_image_url || row.profile_image_base64 || '',
      profileImageBase64: row.profile_image_base64 || row.profile_image_url || '',
      workSampleImagesBase64: normalizeArray(row.work_sample_images_base64),
      openTime: row.open_time || '',
      closeTime: row.close_time || '',
      doctorPhone: row.doctor_phone || '',
      clinicPhone: row.clinic_phone || '',
      deliveryFee: row.delivery_fee || 0,
      ratePerKm: row.rate_per_km ?? null,
      deliveryAreas: row.delivery_areas || '',
      productSections: normalizeArray(row.product_sections),
      showPhoneToCustomers: row.show_phone_to_customers,
      showWhatsAppToCustomers: row.show_whatsapp_to_customers,
      isApproved: row.is_approved,
      approvalStatus: row.approval_status || '',
      isOpen: row.is_open,
    };
  }
  return out;
}

function resolveActiveServiceContext(profile = {}, data = {}) {
  const activeServiceId = String(
    data.active_service_id ??
      data.activeServiceId ??
      profile.active_service_id ??
      profile.primary_service_id ??
      '',
  ).trim();
  const serviceSubCategory = resolveServiceSubCategoryFromData(
    { ...profile, ...data },
    activeServiceId,
  );
  return { activeServiceId, serviceSubCategory };
}

async function enrichMerchantProfileWithServiceProfiles(phone, profile) {
  if (!profile) return profile;
  if (!(await serviceProfilesTableReady())) return profile;

  await ensureLegacyServiceProfilesMigrated(phone, profile);

  const rows = await listMerchantServiceProfiles(phone);
  const serviceProfiles = serializeServiceProfilesForClient(rows);
  const { activeServiceId, serviceSubCategory } = resolveActiveServiceContext(profile);
  const activeRow =
    rows.find(
      (row) =>
        String(row.service_id) === activeServiceId &&
        normalizeSubCategory(row.service_sub_category) === serviceSubCategory,
    ) ||
    rows.find((row) => String(row.service_id) === activeServiceId) ||
    null;

  const merged = activeRow
    ? mergeServiceProfileIntoMerchantShell(profile, activeRow)
    : profile;

  return {
    ...merged,
    service_profiles: serviceProfiles,
    active_service_sub_category: serviceSubCategory,
  };
}

function parseProfileServiceIds(profile = {}) {
  const raw = profile.service_ids ?? profile.serviceIds;
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || '').trim()).filter(Boolean);
  }
  const primary = String(profile.primary_service_id || profile.category || '').trim();
  return primary ? [primary] : [];
}

async function ensureLegacyServiceProfilesMigrated(phone, shellProfile = {}) {
  if (!(await serviceProfilesTableReady())) return;
  const phoneKey = await resolvePhoneKey(phone);
  const storeName = String(shellProfile.store_name || '').trim();
  if (!storeName) return;

  const serviceIds = parseProfileServiceIds(shellProfile);
  if (serviceIds.length === 0) return;

  const rows = await listMerchantServiceProfiles(phoneKey);
  for (const sid of serviceIds) {
    const hasRow = rows.some((row) => String(row.service_id) === sid);
    if (hasRow) continue;
    await saveMerchantServiceProfile(phoneKey, sid, shellProfile, '');
  }
}

function resolveListingProfileFromRows(
  shellProfile,
  serviceId,
  subCategoryId = '',
  rows = [],
) {
  const sid = String(serviceId || '').trim();
  if (!sid) return shellProfile;

  const sub =
    normalizeSubCategory(subCategoryId) ||
    resolveServiceSubCategoryFromProfile(shellProfile, sid);

  let row =
    rows.find(
      (entry) =>
        String(entry.service_id) === sid &&
        normalizeSubCategory(entry.service_sub_category) === sub,
    ) || null;
  if (!row && sub) {
    row =
      rows.find(
        (entry) =>
          String(entry.service_id) === sid &&
          normalizeSubCategory(entry.service_sub_category) === '',
      ) || null;
  }
  if (!row) {
    row = rows.find((entry) => String(entry.service_id) === sid) || null;
  }
  if (row) {
    return mergeServiceProfileIntoMerchantShell(shellProfile, row);
  }

  const serviceIds = parseProfileServiceIds(shellProfile);
  const name = String(shellProfile.store_name || '').trim();
  if (!name) return null;

  if (serviceIds.includes(sid)) {
    return shellProfile;
  }
  return null;
}

async function loadServiceProfilesByPhone() {
  if (!(await serviceProfilesTableReady())) return new Map();
  let rows;
  try {
    rows = await selectManyColumns(
      TABLE,
      LISTING_SERVICE_PROFILE_SELECT,
      [],
      { column: 'updated_at', ascending: false },
      5000,
    );
  } catch (error) {
    const message = String(error?.message || error || '');
    if (!/column|does not exist|42703/i.test(message)) throw error;
    console.warn('service profile listing columns fallback:', message);
    rows = await selectManyColumns(
      TABLE,
      LISTING_SERVICE_PROFILE_SELECT_FALLBACK,
      [],
      { column: 'updated_at', ascending: false },
      5000,
    );
  }
  const map = new Map();
  for (const row of rows) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    if (!map.has(phone)) map.set(phone, []);
    map.get(phone).push(row);
  }
  return map;
}

async function deleteMerchantServiceProfile(phone, serviceId, serviceSubCategory = '') {
  if (!(await serviceProfilesTableReady())) return { deleted: false };
  const phoneKey = await resolvePhoneKey(phone);
  const sid = String(serviceId || '').trim();
  if (!sid) return { deleted: false };
  const sub = normalizeSubCategory(serviceSubCategory);
  const supabase = assertSupabaseAdmin();
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('phone', phoneKey)
    .eq('service_id', sid)
    .eq('service_sub_category', sub);
  if (error) throw new Error(error.message);
  return { deleted: true };
}

module.exports = {
  serviceProfilesTableReady,
  serviceProfileKey,
  parseServiceProfileKey,
  listMerchantServiceProfiles,
  getMerchantServiceProfile,
  saveMerchantServiceProfile,
  deleteMerchantServiceProfile,
  mergeServiceProfileIntoMerchantShell,
  serializeServiceProfilesForClient,
  resolveServiceSubCategoryFromData,
  resolveServiceSubCategoryFromProfile,
  resolveActiveServiceContext,
  enrichMerchantProfileWithServiceProfiles,
  ensureLegacyServiceProfilesMigrated,
  resolveListingProfileFromRows,
  loadServiceProfilesByPhone,
  parseProfileServiceIds,
};
