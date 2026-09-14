/**
 * ملفات المهني من الزبون — ملف مستقل لكل تخصص (merchant_service_profiles).
 * مفتاح التخزين: phone + service_id=professionals + service_sub_category=professionId
 */

const {
  nowIso,
  resolvePhoneKey,
  normalizeObject,
  normalizeArray,
  selectMany,
} = require('./common');
const { ensureAppUser } = require('./users');
const { getMerchantProfile, isMerchantFrozen, isMerchantApproved } = require('./merchants');
const { normalizeMerchantImageField } = require('../services/image_refs');
const {
  getMerchantServiceProfile,
  saveMerchantServiceProfile,
  listMerchantServiceProfiles,
} = require('./merchant_service_profiles');

const PROFESSIONALS_SERVICE_ID = 'professionals';

async function resolveProfessionalCategory(professionId) {
  const { getProfessionalCategoriesConfig } = require('./admin');
  const { normalizeProfessionalCategoryId } = require('../lib/professional_categories');
  const config = await getProfessionalCategoriesConfig();
  const id = normalizeProfessionalCategoryId(professionId);
  const match = config.items.find((item) => item.id === id && item.enabled !== false);
  if (!match) return null;
  return {
    id: match.id,
    labelAr: match.labelAr,
    labelEn: match.labelEn || match.labelAr,
  };
}

function isCustomerProfessionalServiceRow(row) {
  if (!row) return false;
  if (String(row.service_id || '').trim() !== PROFESSIONALS_SERVICE_ID) return false;
  const sub = String(row.service_sub_category || '').trim();
  if (!sub) return false;
  const info = normalizeObject(row.professional_info);
  if (info.customer_professional === true || info.customerProfessional === true) {
    return true;
  }
  return Boolean(String(row.professional_category_id || sub).trim());
}

function hasProfessionalProfileData(profile) {
  if (!profile) return false;
  const categoryId = String(
    profile.professional_category_id ??
      profile.professionalCategoryId ??
      profile.service_sub_category ??
      '',
  ).trim();
  const info = normalizeObject(profile.professional_info ?? profile.professionalInfo);
  const name = String(info.name ?? profile.store_name ?? profile.storeName ?? '').trim();
  return Boolean(categoryId && name);
}

function professionalProfileContentChanged(existing, data) {
  if (!existing) return true;
  const fields = [
    ['store_name', 'storeName'],
    ['description'],
    ['address'],
    ['open_time', 'openTime'],
    ['close_time', 'closeTime'],
    ['professional_category_id', 'professionalCategoryId'],
  ];
  for (const keys of fields) {
    const next = keys.map((key) => data[key]).find((value) => value !== undefined);
    if (next === undefined) continue;
    const prev = keys
      .map((key) => existing[key] ?? existing[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())])
      .find((value) => value !== undefined && value !== null && String(value).trim() !== '');
    if (String(next ?? '').trim() !== String(prev ?? '').trim()) return true;
  }

  const existingInfo = normalizeObject(
    existing.professional_info ?? existing.professionalInfo,
  );
  const incomingInfo = normalizeObject(data.professional_info ?? data.professionalInfo);
  const infoKeys = [
    'name',
    'phone',
    'whatsapp',
    'openTime',
    'closeTime',
    'professionId',
    'profileImageBase64',
    'description',
    'address',
    'carServiceSpecialtyId',
  ];
  for (const key of infoKeys) {
    if (incomingInfo[key] === undefined) continue;
    if (String(incomingInfo[key] ?? '').trim() !== String(existingInfo[key] ?? '').trim()) {
      return true;
    }
  }
  const nextSamples =
    data.work_sample_images_base64 ?? data.workSampleImagesBase64;
  if (nextSamples !== undefined) {
    const prev = JSON.stringify(
      normalizeArray(
        existing.work_sample_images_base64 ?? existingInfo.workSampleImagesBase64,
      ),
    );
    const next = JSON.stringify(normalizeArray(nextSamples));
    if (prev !== next) return true;
  }
  return false;
}

function serializeCustomerProfessionalProfile(profile) {
  if (!profile) return null;
  const info = normalizeObject(profile.professional_info ?? profile.professionalInfo);
  const categoryId = String(
    profile.professional_category_id ??
      profile.professionalCategoryId ??
      profile.service_sub_category ??
      info.professionId ??
      '',
  ).trim();
  return {
    ...profile,
    phone: profile.phone,
    professional_category_id: categoryId,
    professionalCategoryId: categoryId,
    professional_info: info,
    professionalInfo: info,
    approval_status:
      profile.approval_status ?? profile.approvalStatus ?? 'pending',
    is_approved: profile.is_approved ?? profile.isApproved ?? false,
    service_sub_category:
      profile.service_sub_category ?? profile.serviceSubCategory ?? categoryId,
  };
}

function legacyMerchantProfessionalRow(profile) {
  if (!profile) return null;
  const info = normalizeObject(profile.professional_info ?? profile.professionalInfo);
  const isCustomer =
    info.customer_professional === true || info.customerProfessional === true;
  const categoryId = String(profile.professional_category_id ?? info.professionId ?? '').trim();
  if (!categoryId || !isCustomer) return null;
  if (!hasProfessionalProfileData(profile)) return null;
  return serializeCustomerProfessionalProfile({
    ...profile,
    service_id: PROFESSIONALS_SERVICE_ID,
    service_sub_category: categoryId,
  });
}

async function listCustomerProfessionalServiceRows(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const rows = await listMerchantServiceProfiles(phoneKey);
  const fromServices = rows
    .filter(isCustomerProfessionalServiceRow)
    .map((row) => serializeCustomerProfessionalProfile(row));

  const seen = new Set(
    fromServices.map(
      (row) =>
        `${String(row.phone || phoneKey).trim()}::${String(row.professional_category_id || '').trim()}`,
    ),
  );

  const legacy = legacyMerchantProfessionalRow(await getMerchantProfile(phoneKey));
  if (legacy) {
    const key = `${phoneKey}::${legacy.professional_category_id}`;
    if (!seen.has(key)) {
      fromServices.push(legacy);
    }
  }

  return fromServices.sort((a, b) =>
    String(a.professional_category_id || '').localeCompare(
      String(b.professional_category_id || ''),
      'ar',
    ),
  );
}

async function getMyCustomerProfessionalProfile(phone, professionId = '') {
  const phoneKey = await resolvePhoneKey(phone);
  const target = String(professionId || '').trim();

  if (target) {
    const row = await getMerchantServiceProfile(phoneKey, PROFESSIONALS_SERVICE_ID, target);
    if (isCustomerProfessionalServiceRow(row)) {
      return serializeCustomerProfessionalProfile(row);
    }
    const legacy = legacyMerchantProfessionalRow(await getMerchantProfile(phoneKey));
    if (legacy && legacy.professional_category_id === target) {
      return legacy;
    }
    return null;
  }

  const rows = await listCustomerProfessionalServiceRows(phoneKey);
  return rows[0] || null;
}

async function listMyCustomerProfessionalProfiles(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const {
    listCustomerProfessionalsByPhone,
  } = require('./customer_professional_store');
  const fromNew = await listCustomerProfessionalsByPhone(phoneKey);
  const fromOld = await listCustomerProfessionalServiceRows(phoneKey);
  const map = new Map();
  for (const row of fromOld) {
    const key = String(row.professional_category_id || row.service_sub_category || '').trim();
    if (key) map.set(key, row);
  }
  for (const row of fromNew) {
    const key = String(row.professional_category_id || row.profession_id || '').trim();
    if (key) map.set(key, row);
  }
  return [...map.values()];
}

async function hasMyCustomerProfessionalProfile(phone, professionId = '') {
  const target = String(professionId || '').trim();
  if (target) {
    const profile = await getMyCustomerProfessionalProfile(phone, target);
    return { has: Boolean(profile) };
  }
  const rows = await listMyCustomerProfessionalProfiles(phone);
  return { has: rows.length > 0, count: rows.length };
}

async function saveCustomerProfessionalProfile(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  await ensureAppUser(phoneKey, data);

  const professionId = String(
    data.professional_category_id ??
      data.professionalCategoryId ??
      data.profession_id ??
      data.professionId ??
      '',
  ).trim();
  if (!professionId) {
    throw new Error('اختر تخصصك المهني.');
  }

  const category = await resolveProfessionalCategory(professionId);
  if (!category) {
    throw new Error('يرجى اختيار تخصص مهني صحيح.');
  }

  const name = String(
    data.name ??
      data.store_name ??
      data.storeName ??
      data.full_name ??
      data.fullName ??
      '',
  ).trim();
  if (!name) {
    throw new Error('أدخل اسمك أو اسم نشاطك.');
  }

  const address = String(data.address ?? '').trim();
  if (!address) {
    throw new Error('أدخل العنوان.');
  }

  const openTime = String(data.open_time ?? data.openTime ?? '').trim();
  const closeTime = String(data.close_time ?? data.closeTime ?? '').trim();
  if (!openTime || !closeTime) {
    throw new Error('حدّد ساعات العمل.');
  }

  const contactPhone = String(
    data.phone ?? data.contact_phone ?? data.contactPhone ?? phoneKey,
  ).trim();
  const whatsapp = String(data.whatsapp ?? contactPhone).trim();

  const profileImageRaw = String(
    data.profile_image_base64 ??
      data.profileImageBase64 ??
      data.profile_image_url ??
      data.profileImageUrl ??
      '',
  ).trim();
  const profileImageRef = normalizeMerchantImageField(profileImageRaw);
  const profileImage = profileImageRef.url || profileImageRaw;
  if (!profileImage) {
    throw new Error('أضف صورة شخصية أو لوجو.');
  }

  const existingNew = await (async () => {
    try {
      const { getCustomerProfessional } = require('./customer_professional_store');
      return await getCustomerProfessional(phoneKey, professionId);
    } catch (_) {
      return null;
    }
  })();

  const existing =
    existingNew ||
    (await getMerchantServiceProfile(phoneKey, PROFESSIONALS_SERVICE_ID, professionId)) ||
    legacyMerchantProfessionalRow(await getMerchantProfile(phoneKey)) ||
    {};
  const existingInfo = normalizeObject(
    existing.professional_info ?? existing.professionalInfo,
  );

  const incomingSamples =
    data.work_sample_images_base64 ?? data.workSampleImagesBase64;
  const workSampleList =
    incomingSamples !== undefined
      ? normalizeArray(incomingSamples)
      : normalizeArray(
          existing.work_sample_images_base64 ??
            existingInfo.workSampleImagesBase64,
        );

  const professionalInfo = {
    ...existingInfo,
    name,
    address,
    phone: contactPhone,
    whatsapp,
    openTime,
    closeTime,
    professionId: category.id,
    professionNameAr: category.labelAr,
    professionNameEn: category.labelEn,
    profileImageBase64: profileImage,
    workSampleImagesBase64: workSampleList,
    customer_professional: true,
    customerProfessional: true,
    description: String(data.description ?? existingInfo.description ?? '').trim(),
  };

  if (data.latitude !== undefined || data.lat !== undefined) {
    professionalInfo.latitude = data.latitude ?? data.lat;
  }
  if (data.longitude !== undefined || data.lng !== undefined) {
    professionalInfo.longitude = data.longitude ?? data.lng;
  }

  const carSpecialtyId = String(
    data.car_service_specialty_id ??
      data.carServiceSpecialtyId ??
      data.carServiceSpecialty ??
      '',
  ).trim();
  if (carSpecialtyId) {
    professionalInfo.carServiceSpecialtyId = carSpecialtyId;
    professionalInfo.carServiceSpecialtyAr = String(
      data.car_service_specialty_ar ?? data.carServiceSpecialtyAr ?? '',
    ).trim();
    professionalInfo.carServiceSpecialtyEn = String(
      data.car_service_specialty_en ?? data.carServiceSpecialtyEn ?? '',
    ).trim();
  }

  const draftPayload = {
    store_name: name,
    description: String(data.description ?? existing.description ?? '').trim(),
    address,
    open_time: openTime,
    close_time: closeTime,
    professional_category_id: category.id,
    professional_info: professionalInfo,
    work_sample_images_base64: workSampleList,
    profile_image_base64: profileImage,
  };

  const contentChanged = professionalProfileContentChanged(existing, draftPayload);
  const payload = {
    ...draftPayload,
    is_open: true,
  };

  const wasApproved =
    existing.is_approved === true ||
    existing.isApproved === true ||
    String(existing.approval_status ?? existing.approvalStatus ?? '').trim() ===
      'approved';

  if (!existing.phone && !existing.service_id) {
    payload.is_approved = false;
    payload.approval_status = 'pending';
  } else if (contentChanged && wasApproved) {
    payload.is_approved = false;
    payload.approval_status = 'pending';
  }

  const {
    upsertCustomerProfessional,
    MIRROR,
  } = require('./customer_professional_store');

  const savedNew = await upsertCustomerProfessional(
    payload,
    phoneKey,
    professionId,
  );

  // مرآة اختيارية للجدول القديم أثناء الانتقال — لا تفشل الطلب إن فشلت.
  if (MIRROR) {
    try {
      await saveMerchantServiceProfile(
        phoneKey,
        PROFESSIONALS_SERVICE_ID,
        payload,
        professionId,
      );
    } catch (error) {
      console.warn(
        'professional MSP mirror skipped:',
        error?.message || error,
      );
    }
  }

  const saved = savedNew || (await getMerchantServiceProfile(
    phoneKey,
    PROFESSIONALS_SERVICE_ID,
    professionId,
  ));

  const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
  await Promise.all([
    invalidateCachePrefix('marketplace:shopping-stores:'),
    invalidateCachePrefix('marketplace:restaurant-stores:'),
    invalidateCache('marketplace:stats'),
  ]);

  return serializeCustomerProfessionalProfile(saved);
}

function serviceProfileToDirectoryRow(serviceRow, merchantShell = {}) {
  const info = normalizeObject(serviceRow.professional_info);
  const categoryId = String(
    serviceRow.professional_category_id ??
      serviceRow.service_sub_category ??
      info.professionId ??
      '',
  ).trim();
  return {
    phone: serviceRow.phone,
    store_name: serviceRow.store_name || info.name || '',
    description: serviceRow.description || info.description || '',
    address: info.address || '',
    open_time: serviceRow.open_time || info.openTime || '',
    close_time: serviceRow.close_time || info.closeTime || '',
    professional_category_id: categoryId,
    professional_info: info,
    work_sample_images_base64: serviceRow.work_sample_images_base64,
    profile_image_base64:
      serviceRow.profile_image_base64 ||
      serviceRow.profile_image_url ||
      info.profileImageBase64 ||
      '',
    is_approved: serviceRow.is_approved,
    approval_status: serviceRow.approval_status,
    is_open: serviceRow.is_open,
    is_frozen: merchantShell.is_frozen ?? merchantShell.isFrozen ?? false,
    show_phone_to_customers: serviceRow.show_phone_to_customers,
    show_whatsapp_to_customers: serviceRow.show_whatsapp_to_customers,
    whatsapp: info.whatsapp || info.phone || serviceRow.phone,
  };
}

async function listCustomerProfessionalDirectoryRows(professionId = '') {
  const { professionalCategoryMatches } = require('../lib/professional_categories');
  const target = String(professionId || '').trim();

  const {
    listCustomerProfessionalsDirectory,
  } = require('./customer_professional_store');
  const fromNew = await listCustomerProfessionalsDirectory(target);

  const rows = await selectMany(
    'merchant_service_profiles',
    [{ method: 'eq', column: 'service_id', value: PROFESSIONALS_SERVICE_ID }],
    { column: 'updated_at', ascending: false },
    2000,
  );

  const customerRows = rows.filter(isCustomerProfessionalServiceRow);
  const phones = [...new Set(customerRows.map((row) => String(row.phone || '').trim()).filter(Boolean))];
  const merchantByPhone = new Map();
  if (phones.length > 0) {
    const profiles = await selectMany('merchant_profiles', [], null, 5000);
    for (const profile of profiles) {
      const phone = String(profile.phone || '').trim();
      if (phone) merchantByPhone.set(phone, profile);
    }
  }

  const fromOld = customerRows
    .filter((row) => {
      const categoryId = String(
        row.professional_category_id ?? row.service_sub_category ?? '',
      ).trim();
      if (!categoryId) return false;
      if (target && !professionalCategoryMatches(categoryId, target)) return false;
      const shell = merchantByPhone.get(String(row.phone || '').trim()) || {};
      if (isMerchantFrozen(shell)) return false;
      if (row.is_open === false) return false;
      if (!isMerchantApproved(row)) return false;
      const info = normalizeObject(row.professional_info);
      const name = String(info.name ?? row.store_name ?? '').trim();
      return Boolean(name);
    })
    .map((row) =>
      serviceProfileToDirectoryRow(
        row,
        merchantByPhone.get(String(row.phone || '').trim()) || {},
      ),
    );

  // الجديد يفوز بنفس الهاتف+التخصص.
  const map = new Map();
  for (const row of fromOld) {
    const key = `${String(row.phone || '').trim()}::${String(row.professional_category_id || '').trim()}`;
    map.set(key, row);
  }
  for (const row of fromNew) {
    const shaped = serviceProfileToDirectoryRow(row, {});
    const key = `${String(shaped.phone || '').trim()}::${String(shaped.professional_category_id || '').trim()}`;
    map.set(key, shaped);
  }
  return [...map.values()];
}

async function deleteCustomerProfessionalProfile(phone, professionId = '') {
  const phoneKey = await resolvePhoneKey(phone);
  const target = String(professionId || '').trim();
  if (!target) throw new Error('اختر التخصص المراد حذفه.');

  const {
    deleteCustomerProfessional,
  } = require('./customer_professional_store');
  await deleteCustomerProfessional(phoneKey, target);

  try {
    const { deleteMerchantServiceProfile } = require('./merchant_service_profiles');
    await deleteMerchantServiceProfile(phoneKey, PROFESSIONALS_SERVICE_ID, target);
  } catch (error) {
    console.warn('delete professional service profile:', error?.message || error);
  }

  // إن لم تبقَ ملفات مهنية، أزل professionals من shell إن وُجد.
  try {
    const remaining = await listMyCustomerProfessionalProfiles(phoneKey);
    if (!remaining.length) {
      const profile = (await getMerchantProfile(phoneKey)) || {};
      const ids = normalizeArray(profile.service_ids ?? profile.serviceIds)
        .map((id) => String(id).trim())
        .filter((id) => id && id !== PROFESSIONALS_SERVICE_ID);
      const { saveMerchantProfile } = require('./merchants');
      const patch = { service_ids: ids };
      if (String(profile.primary_service_id || '').trim() === PROFESSIONALS_SERVICE_ID) {
        patch.primary_service_id = ids[0] || null;
        patch.active_service_id = ids[0] || null;
      }
      await saveMerchantProfile(phoneKey, {
        ...patch,
        allowCustomerProfessional: true,
      });
    }
  } catch (error) {
    console.warn('cleanup professional shell after delete:', error?.message || error);
  }

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:');
  } catch (_) {}

  return { ok: true, deleted: true, professionId: target };
}

module.exports = {
  saveCustomerProfessionalProfile,
  getMyCustomerProfessionalProfile,
  listMyCustomerProfessionalProfiles,
  hasMyCustomerProfessionalProfile,
  hasProfessionalProfileData,
  listCustomerProfessionalDirectoryRows,
  isCustomerProfessionalServiceRow,
  serializeCustomerProfessionalProfile,
  deleteCustomerProfessionalProfile,
  PROFESSIONALS_SERVICE_ID,
};
