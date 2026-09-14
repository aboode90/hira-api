/**
 * نشر/تحديث نشاط صحة وجمال من حساب الزبون — مستقل عن حساب التاجر.
 *
 * يحفظ في customer_pharmacy_profiles مع service_sub_category
 * (+ مرآة اختيارية لـ merchant_profiles للصيدلية فقط للتوافق).
 */

const {
  resolvePhoneKey,
  normalizeObject,
  nowIso,
  selectSingle,
  selectMany,
  saveRow,
} = require('./common');
const { ensureAppUser } = require('./users');
const { normalizeMerchantImageField } = require('../services/image_refs');

const BEAUTY_SERVICE_ID = 'beauty';
const PHARMACY_SUB = 'صيدلية';
const DOCTOR_SUB = 'أطباء وعيادات';
const ALLOWED_SUBS = new Set([
  'صيدلية',
  'أطباء وعيادات',
  'مختبرات طبية',
  'صالون نسائي',
  'صالون رجالي',
]);

const MIRROR =
  String(process.env.CUSTOMER_PHARMACIES_MIRROR_MERCHANT || '1').trim() !== '0';

function softSubCategory(raw) {
  const sub = String(raw || '').trim();
  if (!sub) return PHARMACY_SUB;
  return ALLOWED_SUBS.has(sub) ? sub : PHARMACY_SUB;
}

function normalizeSubCategory(raw) {
  const sub = String(raw || '').trim();
  if (!sub) return PHARMACY_SUB;
  if (!ALLOWED_SUBS.has(sub)) {
    throw new Error('اختر تخصصاً صالحاً ضمن الصحة والجمال.');
  }
  return sub;
}

function pharmacyIdForPhone(phone) {
  return `pharmacy::${String(phone || '').trim()}`;
}

function beautyIdForPhone(phone, subCategory) {
  const sub = normalizeSubCategory(subCategory);
  if (sub === PHARMACY_SUB) return pharmacyIdForPhone(phone);
  return `beauty::${sub}::${String(phone || '').trim()}`;
}

function labelForSub(sub, listingKind = '') {
  switch (sub) {
    case DOCTOR_SUB: {
      const kind = String(listingKind || '').trim().toLowerCase();
      if (kind === 'doctor') return 'الطبيب';
      if (kind === 'clinic') return 'العيادة';
      return 'الطبيب أو العيادة';
    }
    case 'مختبرات طبية':
      return 'المختبر';
    case 'صالون نسائي':
    case 'صالون رجالي':
      return 'الصالون';
    default:
      return 'الصيدلية';
  }
}

function parseBeautyMeta(source = {}) {
  const raw = source.beauty_meta ?? source.beautyMeta ?? {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...raw };
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }
  return {};
}

function serializeCustomerBeauty(profile = {}) {
  const source = normalizeObject(profile) || {};
  const storeName = String(
    source.store_name || source.storeName || '',
  ).trim();
  const sub = softSubCategory(
    source.service_sub_category || source.serviceSubCategory || PHARMACY_SUB,
  );
  const meta = parseBeautyMeta(source);
  const specialties = Array.isArray(meta.specialties)
    ? meta.specialties.map((s) => String(s).trim()).filter(Boolean)
    : Array.isArray(source.specialties)
      ? source.specialties.map((s) => String(s).trim()).filter(Boolean)
      : [];
  const workingDays = Array.isArray(meta.workingDays)
    ? meta.workingDays.map((s) => String(s).trim()).filter(Boolean)
    : Array.isArray(meta.working_days)
      ? meta.working_days.map((s) => String(s).trim()).filter(Boolean)
      : Array.isArray(source.workingDays)
        ? source.workingDays.map((s) => String(s).trim()).filter(Boolean)
        : [];
  const listingKind = String(
    meta.listingKind || meta.listing_kind || source.listingKind || '',
  )
    .trim()
    .toLowerCase();

  return {
    phone: String(source.owner_phone || source.phone || '').trim(),
    id: source.id || null,
    store_name: storeName,
    storeName,
    description: String(source.description || '').trim(),
    address: String(source.address || '').trim(),
    whatsapp: String(source.whatsapp || '').trim(),
    clinic_phone: String(
      source.clinic_phone || source.clinicPhone || '',
    ).trim(),
    clinicPhone: String(
      source.clinic_phone || source.clinicPhone || '',
    ).trim(),
    open_time: String(source.open_time || source.openTime || '').trim(),
    close_time: String(source.close_time || source.closeTime || '').trim(),
    morningOpenTime: String(meta.morningOpenTime || meta.morning_open_time || '').trim(),
    morningCloseTime: String(meta.morningCloseTime || meta.morning_close_time || '').trim(),
    eveningOpenTime: String(meta.eveningOpenTime || meta.evening_open_time || '').trim(),
    eveningCloseTime: String(meta.eveningCloseTime || meta.evening_close_time || '').trim(),
    listingKind: listingKind === 'doctor' || listingKind === 'clinic' ? listingKind : '',
    listing_kind: listingKind === 'doctor' || listingKind === 'clinic' ? listingKind : '',
    cover_image_url:
      String(source.cover_image_url || source.coverImageUrl || '').trim() ||
      null,
    logo_image_url:
      String(source.logo_image_url || source.logoImageUrl || '').trim() || null,
    profile_image_base64:
      String(
        source.profile_image_base64 || source.profileImageBase64 || '',
      ).trim() || null,
    is_open: source.is_open !== false,
    is_approved: Boolean(source.is_approved),
    approval_status:
      String(source.approval_status || 'pending').trim() || 'pending',
    is_frozen: Boolean(source.is_frozen),
    latitude: source.latitude ?? null,
    longitude: source.longitude ?? null,
    service_sub_category: sub,
    serviceSubCategory: sub,
    primary_service_id: BEAUTY_SERVICE_ID,
    service_ids: [BEAUTY_SERVICE_ID],
    beauty_meta: meta,
    beautyMeta: meta,
    specialties,
    workingDays,
    working_days: workingDays,
    professional_info:
      sub === DOCTOR_SUB
        ? {
            specialty: specialties[0] || '',
            specialties,
            workingDays,
            listingKind: String(meta.listingKind || meta.listing_kind || '').trim(),
            morningOpenTime: String(meta.morningOpenTime || meta.morning_open_time || '').trim(),
            morningCloseTime: String(meta.morningCloseTime || meta.morning_close_time || '').trim(),
            eveningOpenTime: String(meta.eveningOpenTime || meta.evening_open_time || '').trim(),
            eveningCloseTime: String(meta.eveningCloseTime || meta.evening_close_time || '').trim(),
            clinicPhone: String(
              source.clinic_phone || source.clinicPhone || '',
            ).trim(),
            phone: String(source.whatsapp || '').trim(),
            whatsapp: String(source.whatsapp || '').trim(),
            address: String(source.address || '').trim(),
          }
        : undefined,
  };
}

/** @deprecated alias */
const serializeCustomerPharmacy = serializeCustomerBeauty;

async function getCustomerBeautyProfile(phone, subCategory = PHARMACY_SUB) {
  const phoneKey = await resolvePhoneKey(phone);
  const sub = normalizeSubCategory(subCategory);
  const id = beautyIdForPhone(phoneKey, sub);
  try {
    const byId = await selectSingle('customer_pharmacy_profiles', 'id', id);
    if (byId) return byId;

    // توافق: صف صيدلية قديم بدون service_sub_category
    if (sub === PHARMACY_SUB) {
      const legacyId = pharmacyIdForPhone(phoneKey);
      if (legacyId !== id) {
        const legacy = await selectSingle(
          'customer_pharmacy_profiles',
          'id',
          legacyId,
        );
        if (legacy) return legacy;
      }
    }

    const byPhoneSub = await selectMany(
      'customer_pharmacy_profiles',
      [
        { method: 'eq', column: 'owner_phone', value: phoneKey },
        { method: 'eq', column: 'service_sub_category', value: sub },
      ],
      null,
      1,
    );
    if (byPhoneSub[0]) return byPhoneSub[0];

    if (sub === PHARMACY_SUB) {
      const byPhone = await selectMany(
        'customer_pharmacy_profiles',
        [{ method: 'eq', column: 'owner_phone', value: phoneKey }],
        null,
        5,
      );
      const match =
        (byPhone || []).find((row) => {
          const rowSub = String(row.service_sub_category || '').trim();
          return !rowSub || rowSub === PHARMACY_SUB;
        }) || null;
      return match;
    }

    return null;
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return null;
    }
    throw error;
  }
}

async function listMyCustomerBeautyProfiles(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  try {
    const rows = await selectMany(
      'customer_pharmacy_profiles',
      [{ method: 'eq', column: 'owner_phone', value: phoneKey }],
      { column: 'updated_at', ascending: false },
      50,
    );
    return (rows || []).map((row) => serializeCustomerBeauty(row));
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return [];
    }
    throw error;
  }
}

async function upsertCustomerBeautyProfile(phoneKey, payload) {
  const sub = normalizeSubCategory(payload.service_sub_category);
  const id = beautyIdForPhone(phoneKey, sub);
  const row = {
    id,
    owner_phone: phoneKey,
    store_name: payload.store_name,
    description: payload.description || '',
    address: payload.address || '',
    whatsapp: payload.whatsapp || phoneKey,
    clinic_phone: payload.clinic_phone || payload.whatsapp || phoneKey,
    open_time: payload.open_time || '',
    close_time: payload.close_time || '',
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    cover_image_url: payload.cover_image_url || null,
    logo_image_url: payload.logo_image_url || null,
    profile_image_base64: payload.profile_image_base64 || null,
    is_open: payload.is_open !== false,
    is_approved: Boolean(payload.is_approved),
    approval_status: payload.approval_status || 'pending',
    is_frozen: Boolean(payload.is_frozen),
    service_sub_category: sub,
    beauty_meta: payload.beauty_meta || {},
    legacy_phone: phoneKey,
    migrated_from: 'merchant_profiles',
    updated_at: nowIso(),
    created_at: payload.created_at || nowIso(),
  };
  const saved = await saveRow('customer_pharmacy_profiles', row, 'id');
  return saved || row;
}

function isLegacyPharmacyProfile(profile = {}) {
  const primary = String(profile.primary_service_id || '').trim();
  const sub = String(profile.service_sub_category || '').trim();
  const ids = Array.isArray(profile.service_ids)
    ? profile.service_ids.map((id) => String(id).trim())
    : [];
  if (primary === 'pharmacy' || ids.includes('pharmacy')) return true;
  return primary === BEAUTY_SERVICE_ID && sub === PHARMACY_SUB;
}

function isLegacyBeautyProfile(profile = {}, subCategory = '') {
  const sub = normalizeSubCategory(subCategory);
  if (sub === PHARMACY_SUB) return isLegacyPharmacyProfile(profile);
  const primary = String(profile.primary_service_id || '').trim();
  const profileSub = String(profile.service_sub_category || '').trim();
  const ids = Array.isArray(profile.service_ids)
    ? profile.service_ids.map((id) => String(id).trim())
    : [];
  return (
    (primary === BEAUTY_SERVICE_ID || ids.includes(BEAUTY_SERVICE_ID)) &&
    profileSub === sub
  );
}

async function saveCustomerBeauty(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  await ensureAppUser(phoneKey, data);

  const sub = normalizeSubCategory(
    data.service_sub_category ??
      data.serviceSubCategory ??
      data.subCategoryId ??
      PHARMACY_SUB,
  );
  const listingKindRaw = String(
    data.listingKind ?? data.listing_kind ?? '',
  )
    .trim()
    .toLowerCase();
  const listingKind =
    listingKindRaw === 'doctor' || listingKindRaw === 'clinic'
      ? listingKindRaw
      : '';
  const label = labelForSub(sub, listingKind);

  const name = String(
    data.name ?? data.store_name ?? data.storeName ?? '',
  ).trim();
  if (!name) throw new Error(`أدخل اسم ${label}.`);

  const address = String(data.address ?? '').trim();
  if (!address) throw new Error(`أدخل عنوان ${label}.`);

  const existing = (await getCustomerBeautyProfile(phoneKey, sub)) || {};

  let legacy = {};
  if (!existing.id) {
    try {
      const { getMerchantProfile } = require('./merchants');
      const profile = (await getMerchantProfile(phoneKey)) || {};
      if (isLegacyBeautyProfile(profile, sub)) {
        legacy = profile;
      }
    } catch (_) {}
  }

  const base = existing.id ? existing : legacy;
  const baseMeta = parseBeautyMeta(base);

  const coverRaw = String(
    data.coverImageBase64 ??
      data.cover_image_base64 ??
      data.coverImageUrl ??
      data.cover_image_url ??
      '',
  ).trim();
  const logoRaw = String(
    data.logoImageBase64 ??
      data.logo_image_base64 ??
      data.logoImageUrl ??
      data.logo_image_url ??
      data.profileImageBase64 ??
      data.profile_image_base64 ??
      '',
  ).trim();
  const coverRef = normalizeMerchantImageField(coverRaw);
  const logoRef = normalizeMerchantImageField(logoRaw);

  const description = String(
    data.description ?? base.description ?? '',
  ).trim();

  const wasApproved =
    base.is_approved === true ||
    String(base.approval_status || '').trim() === 'approved';

  const whatsapp = String(data.whatsapp ?? phoneKey).trim();
  const clinicPhone = String(
    data.clinicPhone ?? data.clinic_phone ?? whatsapp,
  ).trim();

  const specialtiesRaw =
    data.specialties ?? data.doctorSpecialties ?? baseMeta.specialties ?? [];
  const specialties = Array.isArray(specialtiesRaw)
    ? specialtiesRaw.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const workingDaysRaw =
    data.workingDays ??
    data.working_days ??
    baseMeta.workingDays ??
    baseMeta.working_days ??
    [];
  const workingDays = Array.isArray(workingDaysRaw)
    ? workingDaysRaw.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (sub === DOCTOR_SUB && specialties.length === 0) {
    throw new Error('اختر تخصصاً طبياً واحداً على الأقل.');
  }
  if (sub === DOCTOR_SUB && !listingKind) {
    throw new Error('اختر نوع التسجيل: طبيب أو عيادة.');
  }

  const shiftMeta = {
    morningOpenTime: String(data.morningOpenTime ?? data.morning_open_time ?? '').trim(),
    morning_open_time: String(data.morningOpenTime ?? data.morning_open_time ?? '').trim(),
    morningCloseTime: String(data.morningCloseTime ?? data.morning_close_time ?? '').trim(),
    morning_close_time: String(data.morningCloseTime ?? data.morning_close_time ?? '').trim(),
    eveningOpenTime: String(data.eveningOpenTime ?? data.evening_open_time ?? '').trim(),
    evening_open_time: String(data.eveningOpenTime ?? data.evening_open_time ?? '').trim(),
    eveningCloseTime: String(data.eveningCloseTime ?? data.evening_close_time ?? '').trim(),
    evening_close_time: String(data.eveningCloseTime ?? data.evening_close_time ?? '').trim(),
  };

  const beautyMeta = {
    ...baseMeta,
    ...(sub === DOCTOR_SUB
      ? {
          specialty: specialties[0] || '',
          specialties,
          workingDays,
          working_days: workingDays,
          listingKind,
          listing_kind: listingKind,
          ...shiftMeta,
        }
      : {}),
  };

  const payload = {
    store_name: name,
    description,
    address,
    whatsapp,
    clinic_phone: clinicPhone,
    open_time: String(
      data.openTime ?? data.open_time ?? base.open_time ?? '',
    ).trim(),
    close_time: String(
      data.closeTime ?? data.close_time ?? base.close_time ?? '',
    ).trim(),
    latitude: data.latitude ?? data.lat ?? base.latitude ?? null,
    longitude: data.longitude ?? data.lng ?? base.longitude ?? null,
    is_open: data.isOpen ?? data.is_open ?? true,
    is_approved: wasApproved ? true : false,
    approval_status: wasApproved ? 'approved' : 'pending',
    is_frozen: Boolean(base.is_frozen),
    created_at: base.created_at || nowIso(),
    service_sub_category: sub,
    beauty_meta: beautyMeta,
  };

  if (coverRef.url) payload.cover_image_url = coverRef.url;
  else if (base.cover_image_url) payload.cover_image_url = base.cover_image_url;
  if (logoRef.url) payload.logo_image_url = logoRef.url;
  else if (base.logo_image_url) payload.logo_image_url = base.logo_image_url;
  else if (base.profile_image_base64) {
    payload.profile_image_base64 = base.profile_image_base64;
  }

  let saved;
  try {
    saved = await upsertCustomerBeautyProfile(phoneKey, payload);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      throw new Error(
        'جدول نشر الصحة والجمال غير مفعّل بعد. طبّق ترحيل supabase/20260903_customer_beauty_profiles.sql',
      );
    }
    throw error;
  }

  // مرآة التاجر للصيدلية فقط (ملف تاجر واحد لا يسع عدة تخصصات).
  if (MIRROR && sub === PHARMACY_SUB) {
    try {
      const { saveMerchantProfile, getMerchantProfile } = require('./merchants');
      const existingProfile = (await getMerchantProfile(phoneKey)) || {};
      const serviceIdsRaw = Array.isArray(existingProfile.service_ids)
        ? existingProfile.service_ids
            .map((id) => String(id).trim())
            .filter(Boolean)
        : [];
      const nextServiceIds = serviceIdsRaw.includes(BEAUTY_SERVICE_ID)
        ? serviceIdsRaw
        : [...serviceIdsRaw, BEAUTY_SERVICE_ID];
      await saveMerchantProfile(phoneKey, {
        store_name: name,
        description,
        address,
        service_sub_category: PHARMACY_SUB,
        whatsapp,
        clinic_phone: clinicPhone,
        open_time: payload.open_time,
        close_time: payload.close_time,
        latitude: payload.latitude,
        longitude: payload.longitude,
        cover_image_url: payload.cover_image_url,
        logo_image_url: payload.logo_image_url,
        is_open: payload.is_open,
        service_ids: nextServiceIds,
        allowCustomerPharmacy: true,
        ...(existingProfile.primary_service_id
          ? {}
          : {
              primary_service_id: BEAUTY_SERVICE_ID,
              active_service_id: BEAUTY_SERVICE_ID,
            }),
      });
    } catch (error) {
      console.warn('beauty merchant mirror skipped:', error?.message || error);
    }
  }

  try {
    const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
    await Promise.all([
      invalidateCachePrefix('marketplace:service-stores:'),
      invalidateCachePrefix('marketplace:shopping-stores:'),
      invalidateCache('marketplace:stats'),
    ]);
  } catch (_) {}

  return serializeCustomerBeauty(saved);
}

/** @deprecated alias — صيدلية */
async function saveCustomerPharmacy(phone, data = {}) {
  return saveCustomerBeauty(phone, {
    ...data,
    service_sub_category:
      data.service_sub_category ||
      data.serviceSubCategory ||
      PHARMACY_SUB,
  });
}

async function getMyCustomerBeauty(phone, subCategory = PHARMACY_SUB) {
  const phoneKey = await resolvePhoneKey(phone);
  const sub = normalizeSubCategory(subCategory);
  const row = await getCustomerBeautyProfile(phoneKey, sub);
  if (row) return serializeCustomerBeauty(row);

  try {
    const { getMerchantProfile } = require('./merchants');
    const profile = (await getMerchantProfile(phoneKey)) || {};
    if (!isLegacyBeautyProfile(profile, sub)) return null;
    return serializeCustomerBeauty({
      ...profile,
      owner_phone: phoneKey,
      service_sub_category: sub,
    });
  } catch (_) {
    return null;
  }
}

async function getMyCustomerPharmacy(phone) {
  return getMyCustomerBeauty(phone, PHARMACY_SUB);
}

async function listCustomerBeautyStores({
  compact = false,
  subCategory = '',
} = {}) {
  const wantedSub = String(subCategory || '').trim();
  try {
    const filters = [
      { method: 'eq', column: 'is_open', value: true },
      { method: 'eq', column: 'is_frozen', value: false },
    ];
    if (wantedSub && ALLOWED_SUBS.has(wantedSub)) {
      filters.push({
        method: 'eq',
        column: 'service_sub_category',
        value: wantedSub,
      });
    }
    const rows = await selectMany(
      'customer_pharmacy_profiles',
      filters,
      { column: 'updated_at', ascending: false },
      2000,
    );
    return (rows || [])
      .filter((row) => {
        return (
          row.is_approved === true ||
          String(row.approval_status || '').trim() === 'approved'
        );
      })
      .filter((row) => {
        if (!wantedSub) return true;
        const rowSub = String(row.service_sub_category || PHARMACY_SUB).trim();
        // صفوف قديمة بلا عمود التخصص = صيدلية
        if (wantedSub === PHARMACY_SUB) {
          return !rowSub || rowSub === PHARMACY_SUB;
        }
        return rowSub === wantedSub;
      })
      .map((row) => {
        const serialized = serializeCustomerBeauty(row);
        const sub = serialized.service_sub_category;
        const profile = {
          phone: serialized.phone,
          store_name: serialized.store_name,
          storeName: serialized.storeName,
          description: serialized.description,
          address: serialized.address,
          whatsapp: serialized.whatsapp,
          clinic_phone: serialized.clinic_phone,
          open_time: serialized.open_time,
          close_time: serialized.close_time,
          cover_image_url: serialized.cover_image_url,
          logo_image_url: serialized.logo_image_url,
          profile_image_base64: serialized.profile_image_base64,
          is_open: serialized.is_open,
          is_approved: serialized.is_approved,
          approval_status: serialized.approval_status,
          is_frozen: serialized.is_frozen,
          latitude: serialized.latitude,
          longitude: serialized.longitude,
          primary_service_id: BEAUTY_SERVICE_ID,
          service_ids: [BEAUTY_SERVICE_ID],
          service_sub_category: sub,
          serviceSubCategory: sub,
          source: 'customer_beauty',
          specialties: serialized.specialties,
          workingDays: serialized.workingDays,
          working_days: serialized.working_days,
          professional_info: serialized.professional_info,
          beauty_meta: serialized.beauty_meta,
        };
        return {
          profile,
          products: [],
          productCount: 0,
          hasRestaurantProducts: false,
          compact: Boolean(compact),
          source: 'customer_beauty',
          phone: serialized.phone,
          storeName: serialized.storeName,
          isOpen: serialized.is_open,
          coverImageUrl: serialized.cover_image_url,
          logoImageUrl: serialized.logo_image_url,
          address: serialized.address,
          latitude: serialized.latitude,
          longitude: serialized.longitude,
        };
      });
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return [];
    }
    // عمود service_sub_category غير موجود بعد — أعد كل الصفوف للصيدلية فقط
    if (
      wantedSub === PHARMACY_SUB ||
      !wantedSub ||
      /service_sub_category|42703/i.test(String(error?.message || ''))
    ) {
      if (wantedSub && wantedSub !== PHARMACY_SUB) return [];
      try {
        const rows = await selectMany(
          'customer_pharmacy_profiles',
          [
            { method: 'eq', column: 'is_open', value: true },
            { method: 'eq', column: 'is_frozen', value: false },
          ],
          { column: 'updated_at', ascending: false },
          2000,
        );
        return (rows || [])
          .filter(
            (row) =>
              row.is_approved === true ||
              String(row.approval_status || '').trim() === 'approved',
          )
          .map((row) => {
            const serialized = serializeCustomerBeauty({
              ...row,
              service_sub_category: PHARMACY_SUB,
            });
            return {
              profile: {
                ...serialized,
                source: 'customer_pharmacy',
              },
              products: [],
              productCount: 0,
              hasRestaurantProducts: false,
              compact: Boolean(compact),
              source: 'customer_pharmacy',
              phone: serialized.phone,
              storeName: serialized.storeName,
              isOpen: serialized.is_open,
              coverImageUrl: serialized.cover_image_url,
              logoImageUrl: serialized.logo_image_url,
              address: serialized.address,
              latitude: serialized.latitude,
              longitude: serialized.longitude,
            };
          });
      } catch (_) {
        return [];
      }
    }
    throw error;
  }
}

async function listCustomerPharmacyStores({ compact = false } = {}) {
  return listCustomerBeautyStores({ compact, subCategory: PHARMACY_SUB });
}

async function deleteCustomerBeauty(phone, subCategory = '') {
  const { deleteRow } = require('./common');
  const phoneKey = await resolvePhoneKey(phone);
  const sub = normalizeSubCategory(subCategory);
  if (!sub || !ALLOWED_SUBS.has(sub)) {
    throw new Error('اختر التخصص المراد حذفه.');
  }

  const existing = await getCustomerBeautyProfile(phoneKey, sub);
  const id = existing?.id || beautyIdForPhone(phoneKey, sub);
  try {
    await deleteRow('customer_pharmacy_profiles', 'id', id);
  } catch (error) {
    if (!/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      throw error;
    }
  }

  // legacy pharmacy id
  if (sub === PHARMACY_SUB) {
    try {
      await deleteRow('customer_pharmacy_profiles', 'id', pharmacyIdForPhone(phoneKey));
    } catch (_) {}
  }

  try {
    const { deleteMerchantServiceProfile } = require('./merchant_service_profiles');
    await deleteMerchantServiceProfile(phoneKey, BEAUTY_SERVICE_ID, sub);
  } catch (error) {
    console.warn('delete beauty service profile:', error?.message || error);
  }

  try {
    const remaining = await listMyCustomerBeautyProfiles(phoneKey);
    if (!remaining.length) {
      const { getMerchantProfile, saveMerchantProfile } = require('./merchants');
      const profile = (await getMerchantProfile(phoneKey)) || {};
      const ids = (Array.isArray(profile.service_ids) ? profile.service_ids : [])
        .map((x) => String(x).trim())
        .filter((x) => x && x !== BEAUTY_SERVICE_ID && x !== 'pharmacy');
      const patch = {
        service_ids: ids,
        allowCustomerPharmacy: true,
      };
      if (
        ['beauty', 'pharmacy'].includes(
          String(profile.primary_service_id || '').trim(),
        )
      ) {
        patch.primary_service_id = ids[0] || null;
        patch.active_service_id = ids[0] || null;
      }
      await saveMerchantProfile(phoneKey, patch);
    }
  } catch (error) {
    console.warn('cleanup beauty shell after delete:', error?.message || error);
  }

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:');
  } catch (_) {}

  return { ok: true, deleted: true, subCategory: sub };
}

module.exports = {
  BEAUTY_SERVICE_ID,
  PHARMACY_SUB,
  DOCTOR_SUB,
  ALLOWED_SUBS,
  serializeCustomerPharmacy,
  serializeCustomerBeauty,
  saveCustomerPharmacy,
  saveCustomerBeauty,
  getMyCustomerPharmacy,
  getMyCustomerBeauty,
  listMyCustomerBeautyProfiles,
  listCustomerPharmacyStores,
  listCustomerBeautyStores,
  deleteCustomerBeauty,
  getCustomerPharmacyProfile: (phone) =>
    getCustomerBeautyProfile(phone, PHARMACY_SUB),
  getCustomerBeautyProfile,
  beautyIdForPhone,
  pharmacyIdForPhone,
};
