const {
  nowIso,
  assignIfDefined,
  normalizeArray,
  normalizeObject,
  parseOptionalBoolean,
  isUuid,
  getPhoneVariants,
  phonesOverlap,
  canonicalPhone,
  selectSingleByPhone,
  resolvePhoneKey,
  selectSingle,
  selectMany,
  selectManyColumns,
  hasColumn,
  saveRow,
  updateRow,
  deleteRow,
  assertSupabaseAdmin,
  getSupabaseAdmin,
} = require('./common');
const {
  ensureAppUser,
  getAppUser,
  getAppUserId,
  getUserState,
  saveUserState,
} = require('./users');
const {
  normalizeProductImagePayload,
  serializeProductRowForClient,
  serializeMerchantProfileForClient,
  normalizeMerchantImageField,
  isRemoteImageUrl,
  isBase64Image,
  pickRemoteImageUrl,
} = require('../services/image_refs');
const {
  enrichMerchantProfileWithServiceProfiles,
  saveMerchantServiceProfile,
  resolveActiveServiceContext,
  loadServiceProfilesByPhone,
  resolveListingProfileFromRows,
} = require('./merchant_service_profiles');

// خدمات التواصل المباشر دون منتجات (جمال، مهنيون، سياحة)
const CONTACT_ONLY_SERVICES = new Set(['beauty', 'professionals', 'tourism']);

// إصلاحات الهجرة القديمة لملفات الصيدليات — تُنفَّذ بمعدل منخفض جداً
// (مرة كل 15 دقيقة) لأنها كانت تجري استعلامات لآلاف الملفات في كل طلب
// وتتسبب في بطء فتح قسم الصيدليات والأقسام الأخرى.
const PHARMACY_REPAIR_COOLDOWN_MS = 15 * 60 * 1000;
let lastPharmacyRepairAt = 0;

function resolveMerchantContactVisibility(profile = {}) {
  const info = normalizeObject(profile.professional_info ?? profile.professionalInfo);
  const visibility = normalizeObject(info.contact_visibility ?? info.contactVisibility);
  const showPhoneToCustomers =
    parseOptionalBoolean(
      profile.show_phone_to_customers ??
        profile.showPhoneToCustomers ??
        visibility.show_phone_to_customers ??
        visibility.showPhoneToCustomers
    ) ?? true;
  const showWhatsAppToCustomers =
    parseOptionalBoolean(
      profile.show_whatsapp_to_customers ??
        profile.showWhatsAppToCustomers ??
        visibility.show_whatsapp_to_customers ??
        visibility.showWhatsAppToCustomers
    ) ?? true;

  return { showPhoneToCustomers, showWhatsAppToCustomers };
}

function withMerchantCustomerContacts(profile = {}) {
  const visibility = resolveMerchantContactVisibility(profile);
  const phone = String(profile.phone || '').trim();
  const whatsapp = String(profile.whatsapp || '').trim();
  const customerPhone = visibility.showPhoneToCustomers ? phone : '';
  const customerWhatsApp = visibility.showWhatsAppToCustomers
    ? whatsapp || phone
    : '';

  return {
    ...profile,
    show_phone_to_customers: visibility.showPhoneToCustomers,
    show_whatsapp_to_customers: visibility.showWhatsAppToCustomers,
    customer_phone: customerPhone,
    customer_whatsapp: customerWhatsApp,
  };
}

function profileServiceIds(profile) {
  const serviceIds = normalizeArray(profile.service_ids).map((item) =>
    String(item).trim()
  );
  const parsed = serviceIds.filter(Boolean);
  if (parsed.length > 0) {
    return parsed;
  }
  const primary = String(profile.primary_service_id || '').trim();
  if (primary) return [primary];
  const store = normalizeObject(profile?.store_data);
  const storeIds = normalizeArray(store.serviceIds ?? store.service_ids)
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (storeIds.length > 0) return storeIds;
  const category = String(
    store.category ??
      store.primary_service_id ??
      store.primaryServiceId ??
      store.active_service_id ??
      store.activeServiceId ??
      '',
  ).trim();
  return category ? [category] : [];
}

function resolveProfileSubCategory(profile) {
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

function merchantMatchesSubCategoryFilter(profile, subCategoryId) {
  const target = String(subCategoryId || '').trim();
  if (!target) return true;

  const profileSubCat = resolveProfileSubCategory(profile);
  if (profileSubCat === target) return true;

  // قسم المطاعم: الفلترة بـ restaurant_category (مطاعم / كوفيات / مخابز).
  const restaurantCategory = String(profile?.restaurant_category || '').trim();
  if (restaurantCategory === target) return true;
  if (target === 'كوفيات' && restaurantCategory === 'مرطبات') return true;
  if (
    target === 'مخابز ومعجنات' &&
    (restaurantCategory === 'مخابز ومعجنات' ||
      restaurantCategory === 'bakery' ||
      profileSubCat === 'bakery')
  ) {
    return true;
  }

  // لوازم مكتبية ومدرسية: المتاجر المسجّلة في القسم أو فئاته القديمة.
  if (target === 'school') {
    if (
      profileSubCat === 'school' ||
      SCHOOL_SUPPLIES_SUB_CATEGORY_IDS.has(profileSubCat)
    ) {
      return true;
    }
    // إن لم يُضبط تصنيف الملف، نسمح بالمرور وتُصفّى عبر المنتجات لاحقاً.
    if (!profileSubCat) return true;
  }

  // تسجيل قديم: صيدلية كخدمة مستقلة (primary_service_id = pharmacy)
  if (target === 'صيدلية') {
    const primary = String(profile?.primary_service_id || '').trim();
    if (primary === 'pharmacy') return true;
  }

  return false;
}

function extractSubCategoryFromMerchantStore(store) {
  const normalized = normalizeObject(store);
  return String(
    normalized.serviceSubCategory ||
      normalized.service_sub_category ||
      normalized.subCategoryId ||
      normalized.sub_category_id ||
      '',
  ).trim();
}

/**
 * يزامن service_sub_category من app_state إلى merchant_profiles
 * (لوحة الإدارة قد تعرض التصنيف من state بينما التطبيق يقرأ من profiles فقط).
 */
async function syncProfileSubCategoriesFromAppState(profiles = []) {
  const targets = profiles.filter((profile) => {
    if (resolveProfileSubCategory(profile)) return false;
    const primary = String(profile?.primary_service_id || '').trim();
    if (primary === 'beauty' || primary === 'pharmacy') return true;
    return profileServiceIds(profile).includes('beauty');
  });
  if (targets.length === 0) return 0;

  let synced = 0;
  for (const profile of targets) {
    const phone = String(profile.phone || '').trim();
    if (!phone) continue;

    let subCategory = '';
    const state = await getUserState(phone);
    if (state) {
      subCategory = extractSubCategoryFromMerchantStore(state.merchantStore);
    }
    const primary = String(profile.primary_service_id || '').trim();
    if (!subCategory && primary === 'pharmacy') {
      subCategory = 'صيدلية';
    }
    if (!subCategory) continue;

    profile.service_sub_category = subCategory;
    const storeData = normalizeObject(profile.store_data);
    storeData.serviceSubCategory = subCategory;
    storeData.service_sub_category = subCategory;
    storeData.subCategoryId = subCategory;
    profile.store_data = storeData;

    await saveMerchantProfile(phone, {
      service_sub_category: subCategory,
      store_data: storeData,
    });
    synced += 1;
  }

  return synced;
}

/**
 * يصلح ملفات الصيدليات القديمة حتى تظهر في التطبيق مثل لوحة الإدارة.
 */
async function repairPharmacyProfilesForListing(profiles = []) {
  let repaired = 0;

  // ترشيح سريع بلا استعلامات: مرشحو الصيدلية هم فقط من يجري لهم getUserState.
  const candidates = (profiles || []).filter((profile) => {
    if (!String(profile?.phone || '').trim()) return false;
    const primary = String(profile?.primary_service_id || '').trim();
    const profileSub = resolveProfileSubCategory(profile);
    return (
      profileSub === 'صيدلية' ||
      primary === 'pharmacy' ||
      primary === 'beauty'
    );
  });

  for (const profile of candidates) {
    const phone = String(profile.phone || '').trim();
    if (!phone) continue;

    const state = await getUserState(phone);
    const stateStore = normalizeObject(state?.merchantStore);
    const stateSub = extractSubCategoryFromMerchantStore(stateStore);
    const profileSub = resolveProfileSubCategory(profile);
    const primary = String(profile.primary_service_id || '').trim();
    const stateCategory = String(stateStore.category || '').trim();

    const looksLikePharmacy =
      profileSub === 'صيدلية' ||
      stateSub === 'صيدلية' ||
      primary === 'pharmacy' ||
      stateCategory === 'pharmacy' ||
      (primary === 'beauty' && stateSub === 'صيدلية');

    if (!looksLikePharmacy) continue;

    const patch = {
      service_sub_category: 'صيدلية',
      _adminModerationBypass: true,
    };

    if (primary !== 'beauty' && primary !== 'pharmacy') {
      patch.primary_service_id = 'beauty';
      patch.active_service_id = 'beauty';
      const ids = profileServiceIds(profile);
      patch.service_ids = ids.includes('beauty') ? ids : ['beauty', ...ids];
    } else if (primary === 'pharmacy') {
      patch.primary_service_id = 'pharmacy';
      patch.active_service_id = 'pharmacy';
      const ids = profileServiceIds(profile);
      patch.service_ids = ids.length > 0 ? ids : ['pharmacy'];
    }

    const explicitlyRejected =
      profile.is_approved === false &&
      String(profile.approval_status || '').trim() === 'rejected';
    if (
      !explicitlyRejected &&
      (profile.is_approved === true ||
        profile.admin_pre_registered === true ||
        profile.approval_status === 'approved')
    ) {
      patch.is_approved = true;
      patch.approval_status = 'approved';
    }

    await saveMerchantProfile(phone, patch);
    Object.assign(profile, patch);
    repaired += 1;
  }

  return repaired;
}

function isMerchantFrozen(profile) {
  return profile?.is_frozen === true;
}

function isProfessionalMerchantProfile(profile) {
  if (!profile) return false;
  const primary = String(profile.primary_service_id ?? '').trim();
  if (primary === 'professionals') return true;
  const serviceIds = normalizeArray(profile.service_ids);
  if (serviceIds.map((item) => String(item)).includes('professionals')) return true;
  const info = normalizeObject(profile.professional_info);
  if (String(info.name ?? '').trim()) return true;
  if (String(profile.professional_category_id ?? '').trim()) return true;
  return false;
}

const ACCOUNT_APPROVAL_SERVICES = new Set([
  'professionals',
  'tourism',
  'beauty',
  'pharmacy',
]);

/** حسابات تحتاج موافقة إدارية على التسجيل (مهنيين، سياحة، صحة وجمال). باقي التجار: موافقة على المنتجات فقط. */
function merchantAccountRequiresApproval(profile) {
  if (!profile) return false;
  const info = normalizeObject(profile.professional_info ?? profile.professionalInfo);
  if (info.customer_professional === true || info.customerProfessional === true) {
    return true;
  }
  if (String(profile.professional_category_id ?? profile.professionalCategoryId ?? '').trim()) {
    return true;
  }
  const primary = String(
    profile.primary_service_id ?? profile.primaryServiceId ?? ''
  ).trim();
  if (ACCOUNT_APPROVAL_SERVICES.has(primary)) return true;
  const serviceIds = normalizeArray(profile.service_ids ?? profile.serviceIds).map(
    (item) => String(item).trim()
  );
  return serviceIds.some((id) => ACCOUNT_APPROVAL_SERVICES.has(id));
}

/**
 * التعديلات الجوهرية (اسم المتجر، الخدمة الأساسية/الهوية) تعيد الحساب المعتمد
 * إلى المراجعة. التعديلات غير الجوهرية (الوصف، ساعات العمل، الهاتف، الصور،
 * العناوين، الأقسام الفرعية) لا تعيده إلى pending.
 */
function merchantProfileEditIsEssential(data = {}) {
  const essentialKeys = [
    'store_name',
    'storeName',
    'primary_service_id',
    'primaryServiceId',
    'active_service_id',
    'activeServiceId',
    'service_ids',
    'serviceIds',
    'service_category',
    'serviceCategory',
  ];
  return essentialKeys.some((key) => data[key] !== undefined);
}

function merchantProfileDisplayName(profile) {
  if (!profile) return '';
  const storeName = String(profile.store_name ?? profile.storeName ?? '').trim();
  if (storeName) return storeName;
  const info = normalizeObject(profile.professional_info);
  return String(info.name ?? '').trim();
}

function isMerchantApproved(profile) {
  if (!profile) return false;

  const status = String(
    profile.approval_status ?? profile.approvalStatus ?? ''
  ).trim();
  if (status === 'rejected') return false;
  if (profile.is_approved === true || profile.isApproved === true) return true;
  if (status === 'approved') return true;

  if (merchantAccountRequiresApproval(profile)) {
    if (profile.is_approved === false || profile.isApproved === false) {
      return status === 'approved';
    }
    return false;
  }

  const storeName = String(profile.store_name ?? profile.storeName ?? '').trim();
  return storeName.length > 0;
}

function merchantApprovalStatus(profile) {
  if (isMerchantApproved(profile)) return 'approved';
  const status = String(profile.approval_status ?? profile.approvalStatus ?? '').trim();
  if (status === 'rejected') return 'rejected';
  if (merchantAccountRequiresApproval(profile)) return 'pending';
  const storeName = String(profile.store_name ?? profile.storeName ?? '').trim();
  if (storeName) return 'approved';
  return 'pending';
}

function isProductApproved(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.is_approved === true || row.isApproved === true) return true;
  const status = String(row.approval_status ?? row.approvalStatus ?? '').trim();
  if (status === 'approved') return true;
  if (row.is_approved === false || row.isApproved === false) return false;
  if (status === 'pending' || status === 'rejected') return false;
  return true;
}

function productApprovalStatus(row) {
  if (isProductApproved(row)) return 'approved';
  const status = String(row.approval_status ?? row.approvalStatus ?? '').trim();
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

function incomingProductField(data, snake, camel) {
  if (data[snake] !== undefined) return data[snake];
  if (data[camel] !== undefined) return data[camel];
  return undefined;
}

function normalizeProductModerationScalar(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeProductModerationNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isProductImageResyncEquivalent(existing, data = {}) {
  const incomingBase64 = incomingProductField(data, 'image_base64', 'imageBase64');
  const existingRemote = pickRemoteImageUrl(
    existing?.image_url,
    existing?.imageUrl,
    existing?.image
  );
  if (
    incomingBase64 &&
    isBase64Image(incomingBase64) &&
    existingRemote &&
    isRemoteImageUrl(existingRemote)
  ) {
    return true;
  }
  return false;
}

function merchantProductModerationContentChanged(existing, data = {}) {
  if (!existing) return true;

  const scalarFields = [
    ['name_ar', 'nameAr'],
    ['name_en', 'nameEn'],
    ['description_ar', 'descriptionAr'],
    ['description_en', 'descriptionEn'],
    ['category', 'category'],
    ['sub_category', 'subCategory'],
    ['address', 'address'],
    ['neighborhood', 'neighborhood'],
    ['facade', 'facade'],
    ['listing_mode', 'listingMode'],
    ['section_id', 'sectionId'],
    ['video_url', 'videoUrl'],
  ];

  for (const [snake, camel] of scalarFields) {
    const incoming = incomingProductField(data, snake, camel);
    if (incoming === undefined) continue;
    const prev = existing[snake] ?? existing[camel];
    if (
      normalizeProductModerationScalar(incoming) !==
      normalizeProductModerationScalar(prev)
    ) {
      return true;
    }
  }

  const numericFields = [
    ['price', 'price'],
    ['bedrooms', 'bedrooms'],
    ['bathrooms', 'bathrooms'],
    ['area_square_meter', 'areaSquareMeter'],
    ['floor_count', 'floorCount'],
  ];
  for (const [snake, camel] of numericFields) {
    const incoming = incomingProductField(data, snake, camel);
    if (incoming === undefined) continue;
    const prev = existing[snake] ?? existing[camel];
    if (
      normalizeProductModerationNumber(incoming) !==
      normalizeProductModerationNumber(prev)
    ) {
      return true;
    }
  }

  const hasIncomingImage =
    incomingProductField(data, 'image_base64', 'imageBase64') !== undefined ||
    incomingProductField(data, 'image_url', 'imageUrl') !== undefined ||
    data.image !== undefined;
  if (hasIncomingImage && !isProductImageResyncEquivalent(existing, data)) {
    const incomingRemote = pickRemoteImageUrl(
      data.image_url,
      data.imageUrl,
      data.image,
      data.image_base64,
      data.imageBase64
    );
    const existingRemote = pickRemoteImageUrl(
      existing.image_url,
      existing.imageUrl,
      existing.image
    );
    if (
      normalizeProductModerationScalar(incomingRemote) !==
      normalizeProductModerationScalar(existingRemote)
    ) {
      return true;
    }
  }

  const rawGallery = data.gallery_images_base64 ?? data.galleryImagesBase64;
  if (rawGallery !== undefined) {
    const incomingGallery = Array.isArray(rawGallery)
      ? rawGallery.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    const existingGallery = Array.isArray(
      existing.gallery_images_base64 ?? existing.galleryImagesBase64
    )
      ? (existing.gallery_images_base64 ?? existing.galleryImagesBase64)
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
      : [];
    const incomingHasBase64 = incomingGallery.some((entry) => isBase64Image(entry));
    if (incomingHasBase64 && existingGallery.length > 0) {
      return false;
    }
    if (incomingGallery.join('|') !== existingGallery.join('|')) {
      return true;
    }
  }

  return false;
}

function isAdminPreRegisteredMerchant(profile) {
  if (!profile) return false;
  if (profile.admin_pre_registered === true || profile.adminPreRegistered === true) {
    return true;
  }
  const storeData = normalizeObject(profile.store_data ?? profile.storeData);
  return (
    storeData.adminPreRegistered === true ||
    storeData.admin_pre_registered === true
  );
}

function merchantRejectionMessage(profile) {
  return String(profile?.rejection_message_ar ?? profile?.rejectionMessageAr ?? '').trim();
}

const MERCHANT_REJECTION_REASONS = {
  storeName:
    'اسم المتجر غير واضح أو غير مطابق. يرجى إدخال اسم المتجر بشكل صحيح.',
  phone:
    'رقم الهاتف أو واتساب غير صحيح. يرجى إدخال رقم مفعّل على واتساب.',
  address:
    'عنوان المتجر أو موقعه على الخريطة غير واضح. يرجى تحديد الموقع بدقة.',
  images:
    'صور المتجر (الشعار أو الغلاف) غير واضحة أو غير مناسبة. يرجى رفع صور أفضل.',
  description:
    'وصف المتجر ناقص أو غير مناسب. يرجى كتابة وصف واضح لنشاطك.',
};

function mapMerchantApprovalFields(profile) {
  const accountApprovalRequired = merchantAccountRequiresApproval(profile);
  const rejectionReasonKey =
    String(profile?.rejection_reason_key ?? profile?.rejectionReasonKey ?? '').trim() ||
    null;
  const rejectionMessageAr = merchantRejectionMessage(profile) || null;

  if (!accountApprovalRequired) {
    return {
      isApproved: true,
      approvalStatus: 'approved',
      accountApprovalRequired: false,
      rejectionReasonKey,
      rejectionMessageAr,
    };
  }

  return {
    isApproved: isMerchantApproved(profile),
    approvalStatus: merchantApprovalStatus(profile),
    accountApprovalRequired: true,
    rejectionReasonKey,
    rejectionMessageAr,
  };
}

async function syncMerchantApprovalToState(_phoneKey, _patch = {}) {
  // Legacy: approval fields live in merchant_profiles only.
}

async function updateMerchantApprovalRecord(phoneKey, patch = {}) {
  const supabase = assertSupabaseAdmin();

  // Try atomic RPC first
  try {
    const isReject = String(patch.approvalStatus || '').trim() === 'rejected';
    let rpcResult;
    if (isReject) {
      const { data, error } = await supabase.rpc('atomic_reject_merchant', {
        p_phone: phoneKey,
        p_reason_key: patch.rejectionReasonKey || patch.rejection_reason_key || null,
        p_message_ar: patch.rejectionMessageAr || patch.rejection_message_ar || null,
      });
      if (!error) rpcResult = data;
    } else if (patch.isApproved !== undefined || patch.is_approved !== undefined) {
      const { data, error } = await supabase.rpc('atomic_approve_merchant', {
        p_phone: phoneKey,
        p_approved: Boolean(patch.isApproved ?? patch.is_approved),
      });
      if (!error) rpcResult = data;
    }
    if (rpcResult) return { phone: phoneKey, ...patch, ...rpcResult };
  } catch (_) {
    // fallback to original multi-query approach
  }

  const variants = getPhoneVariants(phoneKey);
  const dbPatch = { updated_at: nowIso() };
  if (patch.isApproved !== undefined) {
    dbPatch.is_approved = Boolean(patch.isApproved);
  }
  if (patch.approvalStatus !== undefined) {
    dbPatch.approval_status = String(patch.approvalStatus || '').trim();
  }
  if (patch.rejectionReasonKey !== undefined) {
    dbPatch.rejection_reason_key = patch.rejectionReasonKey || null;
  }
  if (patch.rejectionMessageAr !== undefined) {
    dbPatch.rejection_message_ar = patch.rejectionMessageAr || null;
  }
  if (patch.rejectedAt !== undefined) {
    dbPatch.rejected_at = patch.rejectedAt || null;
  }

  const { data, error } = await supabase
    .from('merchant_profiles')
    .update(dbPatch)
    .in('phone', variants)
    .select();

  if (error) {
    if (/column/i.test(error.message || '')) {
      console.warn(`DB_WARNING: Column missing in merchant_profiles. Ensure SQL migration is applied. Error: ${error.message}`);
    } else {
      throw new Error(error.message);
    }
  }

  const statePatch = {
    isApproved: patch.isApproved,
    is_approved: patch.isApproved,
    approvalStatus: patch.approvalStatus,
    approval_status: patch.approvalStatus,
    rejectionReasonKey: patch.rejectionReasonKey ?? null,
    rejection_reason_key: patch.rejectionReasonKey ?? null,
    rejectionMessageAr: patch.rejectionMessageAr ?? null,
    rejection_message_ar: patch.rejectionMessageAr ?? null,
    rejectedAt: patch.rejectedAt ?? null,
    rejected_at: patch.rejectedAt ?? null,
  };
  Object.keys(statePatch).forEach((key) => {
    if (statePatch[key] === undefined) delete statePatch[key];
  });
  await syncMerchantApprovalToState(phoneKey, statePatch);

  if (error && /column/i.test(error.message || '')) {
    return { phone: phoneKey, ...patch, _columnMissing: true };
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/** أقسام التسوق العالمي فقط — لا تُخلط مع التسوق المحلي. */
const GLOBAL_SHOPPING_SUB_CATEGORY_IDS = new Set(['iran', 'china']);

const SCHOOL_SUPPLIES_SUB_CATEGORY_IDS = new Set([
  'school_books_magazines',
  'school_pens',
  'school_notebooks',
  'school_colors',
  'school_erasers',
]);

const LEGACY_SCHOOL_SUB_CATEGORY_ALIASES = {
  books_magazines: 'school_books_magazines',
};

function normalizeShoppingSubCategoryId(sub) {
  const value = String(sub || '').trim();
  if (!value) return '';
  // اكسسوارات دُمجت داخل كوزمتك.
  if (value === 'accessories') return 'cosmetics';
  if (value === 'used_accessories') return 'used_cosmetics';
  // ملابس رجالية/نسائية/أطفال دُمجت داخل الملابس.
  if (
    value === 'women_clothing' ||
    value === 'men_clothing' ||
    value === 'kids_clothing'
  ) {
    return 'clothing';
  }
  if (
    value === 'used_women_clothing' ||
    value === 'used_men_clothing' ||
    value === 'used_kids_clothing'
  ) {
    return 'used_clothing';
  }
  return LEGACY_SCHOOL_SUB_CATEGORY_ALIASES[value] || value;
}

function shoppingSubCategoryMatches(productSub, filterSub) {
  const filter = normalizeShoppingSubCategoryId(filterSub);
  if (!filter) return true;
  const product = normalizeShoppingSubCategoryId(productSub);
  if (product === filter) return true;
  const rawProduct = String(productSub || '').trim();
  const rawFilter = String(filterSub || '').trim();
  // قسم لوازم مكتبية ومدرسية: اعرض كل المنتجات/المتاجر ضمن هذا القسم
  // بما فيها الفئات القديمة (كتب، أقلام، ملازم، ألوان، ممحات).
  if (rawFilter === 'school' || filter === 'school') {
    return (
      product === 'school' ||
      rawProduct === 'school' ||
      SCHOOL_SUPPLIES_SUB_CATEGORY_IDS.has(product) ||
      SCHOOL_SUPPLIES_SUB_CATEGORY_IDS.has(rawProduct)
    );
  }
  // كوزمتك: يشمل المنتجات القديمة المصنّفة اكسسوارات.
  if (rawFilter === 'cosmetics' || filter === 'cosmetics') {
    return (
      product === 'cosmetics' ||
      rawProduct === 'cosmetics' ||
      rawProduct === 'accessories' ||
      product === 'accessories'
    );
  }
  if (
    (rawFilter === 'used_cosmetics' || filter === 'used_cosmetics') &&
    (rawProduct === 'used_accessories' || product === 'used_cosmetics')
  ) {
    return true;
  }
  // الملابس: يشمل الرجالية والنسائية والأطفال القديمة.
  if (rawFilter === 'clothing' || filter === 'clothing') {
    return (
      product === 'clothing' ||
      rawProduct === 'clothing' ||
      rawProduct === 'women_clothing' ||
      rawProduct === 'men_clothing' ||
      rawProduct === 'kids_clothing'
    );
  }
  if (rawFilter === 'used_clothing' || filter === 'used_clothing') {
    return (
      product === 'used_clothing' ||
      rawProduct === 'used_clothing' ||
      rawProduct === 'used_women_clothing' ||
      rawProduct === 'used_men_clothing' ||
      rawProduct === 'used_kids_clothing'
    );
  }
  if (rawProduct === 'school' && filter.startsWith('school_')) return true;

  // السيارات: التاجر ينشر «بيع سيارة»، والزبون يتصفح «شراء سيارة».
  if (
    (rawFilter === 'car_buy' || filter === 'car_buy') &&
    (rawProduct === 'car_sell' ||
      product === 'car_sell' ||
      rawProduct === 'car_buy' ||
      product === 'car_buy')
  ) {
    return true;
  }
  // طلب سيارة (صفحة الزبون) يعرض كل أنواع الطلب المنشورة من التاجر.
  const carRequestTypes = new Set([
    'car_4seat',
    'car_starx11',
    'car_truck',
    'car_bus',
  ]);
  if (
    (rawFilter === 'car_request' || filter === 'car_request') &&
    (carRequestTypes.has(rawProduct) || carRequestTypes.has(product))
  ) {
    return true;
  }

  return false;
}

function profileHasService(profile, serviceId) {
  const target = String(serviceId || '').trim();
  if (!target) return false;
  return profileServiceIds(profile).includes(target);
}

function productMatchesStoreListing({
  row,
  profile = null,
  productCategory,
  subCategoryId = '',
  marketplaceCategory = '',
}) {
  if (row.is_available === false) return false;
  if (
    row.stock_quantity !== null &&
    row.stock_quantity !== undefined &&
    Number(row.stock_quantity) <= 0
  ) {
    return false;
  }
  if (!isProductApproved(row)) return false;

  const rawCategory = String(row.category || row.service_id || '').trim();
  const requestedCategory = String(productCategory || '').trim();
  const channel = String(marketplaceCategory || '').trim();
  // نماذج المطابع تظهر فقط في قناة مطابع وإعلانات — لا في زهور/هدايا وباقي التسوق.
  if (rawCategory === 'eden_printing') {
    return channel === 'eden_printing' || requestedCategory === 'eden_printing';
  }

  const productService = resolveListingProductService(row, profile);
  const isBazaarChannel = channel === 'bazar_ghaith';

  if (isBazaarChannel) {
    // LEGACY — bazaar channel removed; no customer listing.
    return false;
  } else if (productService !== requestedCategory) {
    return false;
  }

  const sub = String(row.sub_category || '').trim();
  const target = String(subCategoryId || '').trim();

  if (channel === 'global_shopping') {
    if (!GLOBAL_SHOPPING_SUB_CATEGORY_IDS.has(sub)) return false;
    if (target && sub !== target) return false;
    return true;
  }

  if (isBazaarChannel) {
    if (productService == 'product' && GLOBAL_SHOPPING_SUB_CATEGORY_IDS.has(sub)) {
      return false;
    }
    if (target) return shoppingSubCategoryMatches(sub, target);
    return true;
  }

  if (channel === 'product' || channel === '') {
    if (GLOBAL_SHOPPING_SUB_CATEGORY_IDS.has(sub)) return false;
    if (target) {
      if (shoppingSubCategoryMatches(sub, target)) return true;
      // منتجات قديمة بلا sub_category: فقط إن كان ملف المتجر مربوطاً بنفس القسم.
      if (!sub) {
        const profileSub = resolveProfileSubCategory(profile);
        if (profileSub && profileSub === target) return true;
        if (
          target === 'school' &&
          (profileSub === 'school' || SCHOOL_SUPPLIES_SUB_CATEGORY_IDS.has(profileSub))
        ) {
          return true;
        }
      }
      return false;
    }
    return true;
  }

  // قناة المطاعم: القسم الفرعي يُصفّى عبر restaurant_category في الملف، لا عبر المنتج.
  if (channel === 'restaurant' || requestedCategory === 'restaurant') {
    return productService === 'restaurant';
  }

  if (target) return shoppingSubCategoryMatches(sub, target);
  return true;
}

function buildProfileByPhoneMap(profiles) {
  const map = new Map();
  for (const profile of profiles) {
    for (const variant of getPhoneVariants(profile.phone)) {
      map.set(variant, profile);
    }
  }
  return map;
}

function canMerchantPublishInBazaar(_profile) {
  // LEGACY — bazar_ghaith marketplace channel removed from Talab app.
  return false;
}

function readServiceEnabledMap(profile) {
  const raw =
    profile?.service_enabled ??
    profile?.serviceEnabled ??
    profile?.store_data?.service_enabled ??
    profile?.store_data?.serviceEnabled ??
    null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function isMerchantServiceEnabled(profile, serviceId) {
  const id = String(serviceId || '').trim();
  if (!id) return true;
  const map = readServiceEnabledMap(profile);
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    return map[id] !== false;
  }
  return true;
}

function merchantQualifiesForServiceListing(profile, serviceId) {
  const normalizedServiceId = String(serviceId || '').trim();
  if (normalizedServiceId === 'bazar_ghaith') {
    // LEGACY — bazaar channel removed; never list for customers.
    return false;
  }
  if (normalizedServiceId === 'beauty') {
    const primary = String(profile?.primary_service_id || '').trim();
    if (primary === 'pharmacy') return true;
  }
  // كتالوج السيارات يشمل منتجات المعرض وخدمات طلب السيارة.
  if (normalizedServiceId === 'cars') {
    const hasCars =
      profileHasService(profile, 'cars') &&
      isMerchantServiceEnabled(profile, 'cars');
    const hasRequest =
      profileHasService(profile, 'cars_request') &&
      isMerchantServiceEnabled(profile, 'cars_request');
    return hasCars || hasRequest;
  }
  if (!profileHasService(profile, normalizedServiceId)) return false;
  return isMerchantServiceEnabled(profile, normalizedServiceId);
}

function isBazaarEligibleProductCategory(value) {
  const category = String(value || '').trim();
  return category === 'product' || category === 'restaurant';
}

function resolveListingProductService(row, profile) {
  const raw = String(row.category || row.service_id || '').trim();
  // مطابع وإعلانات: لا تُعاد كمنتجات تسوق حتى لو كان الحساب فيه خدمة product.
  if (raw === 'eden_printing') return raw;
  if (isBazaarEligibleProductCategory(raw)) return raw;
  if (!profile) return raw;
  const services = profileServiceIds(profile);
  if (services.includes('product')) return 'product';
  if (services.includes('restaurant')) return 'restaurant';
  return raw;
}

function evaluateBazaarCustomerVisibility(profile, products = []) {
  const notes = [];
  if (profile.is_open === false) notes.push('المتجر مغلق');
  if (isMerchantFrozen(profile)) notes.push('الحساب مجمّد');
  if (!canMerchantPublishInBazaar(profile)) notes.push('غير مصرّح في البازار');
  const services = profileServiceIds(profile);
  if (!services.includes('product') && !services.includes('restaurant')) {
    notes.push('التاجر ليس في قسم منتجات أو مطاعم');
  }

  const visibleProducts = products.filter((row) =>
    productMatchesStoreListing({
      row,
      profile,
      productCategory: 'bazar_ghaith',
      marketplaceCategory: 'bazar_ghaith',
    })
  );

  if (products.length === 0) {
    notes.push('لا توجد منتجات منشورة');
  } else if (visibleProducts.length === 0) {
    notes.push('لا يوجد منتج صالح للعرض (القسم أو التوفر)');
  }

  return {
    visibleToCustomers: notes.length === 0 && visibleProducts.length > 0,
    visibleProductCount: visibleProducts.length,
    visibilityNotes: notes,
  };
}

function mapStateItemToProductPayload(item = {}) {
  const category = String(
    item.category ?? item.service_id ?? item.serviceId ?? ''
  ).trim();
  const id = String(item.id || '').trim();
  if (!id || !isBazaarEligibleProductCategory(category)) {
    return null;
  }

  const isAvailable =
    item.isAvailable !== false && item.is_available !== false;

  return {
    id,
    category,
    service_id: category,
    name_ar: item.nameAr ?? item.name_ar ?? '',
    name_en: item.nameEn ?? item.name_en ?? '',
    description_ar: item.descriptionAr ?? item.description_ar ?? '',
    description_en: item.descriptionEn ?? item.description_en ?? '',
    price: Number.parseInt(item.price, 10) || 0,
    rating: Number(item.rating ?? 4.8),
    sub_category: item.subCategory ?? item.sub_category ?? '',
    section_id: item.sectionId ?? item.section_id ?? '',
    category_label_ar: item.categoryLabelAr ?? item.category_label_ar ?? '',
    category_label_en: item.categoryLabelEn ?? item.category_label_en ?? '',
    image: (() => {
      const remote = pickRemoteImageUrl(
        item.image,
        item.imageUrl,
        item.image_base64,
        item.imageBase64
      );
      if (remote) return remote;
      return String(item.image ?? item.imageUrl ?? '').trim();
    })(),
    image_base64: '',
    is_favorite: Boolean(item.isFavorite ?? item.is_favorite ?? false),
    avg_price_label_ar: item.avgPriceLabelAr ?? item.avg_price_label_ar ?? '',
    avg_price_label_en: item.avgPriceLabelEn ?? item.avg_price_label_en ?? '',
    action_label_ar: item.actionLabelAr ?? item.action_label_ar ?? '',
    action_label_en: item.actionLabelEn ?? item.action_label_en ?? '',
    address: item.address ?? '',
    prep_minutes: item.prepMinutes ?? item.prep_minutes ?? null,
    is_available: isAvailable,
    stock_quantity:
      item.stockQuantity !== undefined || item.stock_quantity !== undefined
        ? Number.parseInt(
            String(item.stockQuantity ?? item.stock_quantity),
            10,
          )
        : undefined,
  };
}

/**
 * LEGACY — bazaar removed from Talab app. No-op kept for older admin callers.
 */
async function syncMerchantProductsForBazaar(_merchantPhone) {
  return { synced: 0, totalEligible: 0, removed: true };
}

function findProfileForPhone(map, phone) {
  for (const variant of getPhoneVariants(phone)) {
    const profile = map.get(variant);
    if (profile) return profile;
  }
  return null;
}

function merchantProfileSections(profile) {
  return normalizeArray(profile?.product_sections ?? profile?.productSections);
}

async function mergeMerchantStoreData(basePayload, existingStoreData, patch = {}) {
  if (!(await hasColumn('merchant_profiles', 'store_data'))) return;
  const storeData = normalizeObject(basePayload.store_data ?? existingStoreData ?? {});
  Object.assign(storeData, patch);
  basePayload.store_data = storeData;
}

async function stripMissingMerchantStoreData(basePayload) {
  if (!basePayload || typeof basePayload !== 'object') return;
  if (await hasColumn('merchant_profiles', 'store_data')) return;
  delete basePayload.store_data;
}

async function getMerchantProfile(phone) {
  return selectSingleByPhone('merchant_profiles', phone);
}

async function getMerchantProfileForClient(phone) {
  const profile = await getMerchantProfile(phone);
  if (!profile) return null;
  const enriched = await enrichMerchantProfileWithServiceProfiles(phone, profile);
  const serialized = serializeMerchantProfileForClient(enriched);
  if (!serialized || typeof serialized !== 'object') return serialized;
  const { normalizeCourierMode } = require('./merchant_couriers');
  const storeData = normalizeObject(serialized.store_data || serialized.storeData);
  const courierMode = normalizeCourierMode(
    serialized.courier_mode ??
      serialized.courierMode ??
      storeData.courierMode ??
      storeData.courier_mode,
  );
  serialized.courier_mode = courierMode;
  serialized.courierMode = courierMode;
  return serialized;
}

function merchantIsProfessionalsServiceContext(data = {}, existingProfile = null) {
  const primary = String(
    data.primary_service_id ??
      data.primaryServiceId ??
      existingProfile?.primary_service_id ??
      '',
  ).trim();
  if (primary === 'professionals') return true;
  const serviceIds = normalizeArray(
    data.service_ids ??
      data.serviceIds ??
      existingProfile?.service_ids ??
      existingProfile?.serviceIds,
  ).map((item) => String(item).trim());
  return serviceIds.includes('professionals');
}

function stripMerchantDirectoryProfessionalFields(info = {}) {
  const next = { ...normalizeObject(info) };
  delete next.customer_professional;
  delete next.customerProfessional;
  delete next.professionId;
  delete next.profession_id;
  delete next.professionNameAr;
  delete next.professionNameEn;
  delete next.profession_name_ar;
  delete next.profession_name_en;
  return next;
}

function sanitizeMerchantProfessionalsPayload(data = {}, existingProfile = null) {
  if (merchantIsProfessionalsServiceContext(data, existingProfile)) {
    return data;
  }

  const incomingServiceIds = data.service_ids ?? data.serviceIds;
  if (incomingServiceIds !== undefined) {
    const rawIds = normalizeArray(incomingServiceIds)
      .map((item) => String(item).trim())
      .filter(Boolean);
    if (rawIds.includes('professionals')) {
      const ids = rawIds.filter((item) => item !== 'professionals');
      data.service_ids = ids;
      data.serviceIds = ids;
    }
  }

  data.professional_category_id = null;
  data.professionalCategoryId = null;

  if (data.professional_info !== undefined || data.professionalInfo !== undefined) {
    const cleaned = stripMerchantDirectoryProfessionalFields(
      data.professional_info ?? data.professionalInfo,
    );
    data.professional_info = cleaned;
    data.professionalInfo = cleaned;
  }

  return data;
}

  function isProfessionalsDirectoryMerchantWrite(data = {}, existingProfile = null) {
    if (merchantIsProfessionalsServiceContext(data, existingProfile)) {
      return true;
    }
  
    const profCatId = String(
      data.professional_category_id ?? data.professionalCategoryId ?? '',
    ).trim();
    if (profCatId) return true;
  
    const info = normalizeObject(data.professional_info ?? data.professionalInfo);
    if (String(info.professionId ?? info.profession_id ?? '').trim()) {
      return true;
    }
  
    return false;
  }

  /** هل يحاول هذا الحفظ إضافة مطعم/كوفي جديداً من مسار تاجر عام (يُمنع)؟
   *  التعديلات على حساب مطعم موجود تمرّ — لا كسر للمطاعم الحالية. */
  function isNewRestaurantMerchantWrite(data = {}, existingProfile = null) {
    const RE_VENUES = new Set(['مطاعم', 'كوفيات', 'مرطبات', 'مخابز ومعجنات', 'bakery']);
    const RE_CUISINES = new Set(['مشويات', 'وجبات سريعة']);

    const wantsRestaurantService =
      String(data.primary_service_id ?? data.primaryServiceId ?? '').trim() ===
        'restaurant' ||
      String(data.active_service_id ?? data.activeServiceId ?? '').trim() ===
        'restaurant' ||
      (Array.isArray(data.service_ids ?? data.serviceIds) &&
        (data.service_ids ?? data.serviceIds)
          .map((id) => String(id).trim())
          .filter(Boolean)
          .includes('restaurant'));

    const venue = String(
      data.restaurant_category ?? data.restaurantCategory ?? '',
    ).trim();
    const subCategory = String(
      data.service_sub_category ?? data.serviceSubCategory ?? '',
    ).trim();
    const wantsRestaurantContent =
      RE_VENUES.has(venue) ||
      RE_CUISINES.has(subCategory) ||
      (venue === '' &&
        RE_CUISINES.has(String(data.restaurant_cuisine ?? data.restaurantCuisine ?? '').trim()));

    if (!wantsRestaurantService && !wantsRestaurantContent) return false;

    // المطاعم الحالية (في service_ids أو primary) تمرّ بلا كسر.
    const existingIds = existingProfile
      ? profileServiceIds(existingProfile)
      : [];
    if (existingIds.includes('restaurant')) return false;
    if (
      String(existingProfile?.primary_service_id || '').trim() === 'restaurant'
    ) {
      return false;
    }
    return true;
  }

  /** صيدلية جديدة من مسار تاجر — ممنوعة؛ التعديل على صيدلية موجودة يمرّ. */
  function isNewPharmacyMerchantWrite(data = {}, existingProfile = null) {
    const subCategory = String(
      data.service_sub_category ??
        data.serviceSubCategory ??
        data.subCategoryId ??
        '',
    ).trim();
    const primary = String(
      data.primary_service_id ?? data.primaryServiceId ?? '',
    ).trim();
    const active = String(
      data.active_service_id ?? data.activeServiceId ?? '',
    ).trim();
    const ids = Array.isArray(data.service_ids ?? data.serviceIds)
      ? (data.service_ids ?? data.serviceIds)
          .map((id) => String(id).trim())
          .filter(Boolean)
      : [];

    const wantsPharmacy =
      primary === 'pharmacy' ||
      active === 'pharmacy' ||
      ids.includes('pharmacy') ||
      subCategory === 'صيدلية';

    if (!wantsPharmacy) return false;

    if (!existingProfile) return true;
    const existingIds = profileServiceIds(existingProfile);
    const existingPrimary = String(
      existingProfile.primary_service_id || '',
    ).trim();
    const existingSub = String(
      existingProfile.service_sub_category || '',
    ).trim();
    if (existingIds.includes('pharmacy') || existingPrimary === 'pharmacy') {
      return false;
    }
    if (existingPrimary === 'beauty' && existingSub === 'صيدلية') {
      return false;
    }
    if (existingIds.includes('beauty') && existingSub === 'صيدلية') {
      return false;
    }
    return true;
  }

  async function saveMerchantProfile(phone, data = {}) {
    const adminBypass = data._adminModerationBypass === true;
    const allowCustomerProfessional = data.allowCustomerProfessional === true;
    const allowCustomerRestaurant = data.allowCustomerRestaurant === true;
    const allowCustomerPharmacy = data.allowCustomerPharmacy === true;

    const phoneKeyEarly = await resolvePhoneKey(phone);
    const existingProfileEarly = (await getMerchantProfile(phoneKeyEarly)) || null;
    sanitizeMerchantProfessionalsPayload(data, existingProfileEarly);
    if (
      !adminBypass &&
      !allowCustomerProfessional &&
      isProfessionalsDirectoryMerchantWrite(data, existingProfileEarly)
    ) {
      throw new Error(
        'PROFESSIONALS_CUSTOMER_ONLY: نشر المهنيين متاح من قسم المهنيين بحساب الزبون فقط.',
      );
    }
    if (
      !adminBypass &&
      !allowCustomerRestaurant &&
      isNewRestaurantMerchantWrite(data, existingProfileEarly)
    ) {
      throw new Error(
        'RESTAURANT_CUSTOMER_ONLY: تسجيل المطاعم والكوفيات متاح من قسم المطاعم بحساب الزبون فقط.',
      );
    }
    if (
      !adminBypass &&
      !allowCustomerPharmacy &&
      isNewPharmacyMerchantWrite(data, existingProfileEarly)
    ) {
      throw new Error(
        'PHARMACY_CUSTOMER_ONLY: تسجيل الصيدليات متاح من قسم الصيدليات بحساب الزبون فقط.',
      );
    }

  const appUser = await ensureAppUser(phone, data);
  const basePayload = { updated_at: nowIso() };
  const showPhoneToCustomers = parseOptionalBoolean(
    data.show_phone_to_customers ?? data.showPhoneToCustomers
  );
  const showWhatsAppToCustomers = parseOptionalBoolean(
    data.show_whatsapp_to_customers ?? data.showWhatsAppToCustomers
  );
  if (await hasColumn('merchant_profiles', 'user_id')) {
    basePayload.user_id = appUser?.id || null;
  }
  assignIfDefined(basePayload, 'store_name', data.store_name ?? data.storeName);
  assignIfDefined(basePayload, 'description', data.description);
  assignIfDefined(
    basePayload,
    'primary_service_id',
    data.primary_service_id ?? data.primaryServiceId
  );
  if (await hasColumn('merchant_profiles', 'whatsapp')) {
    assignIfDefined(basePayload, 'whatsapp', data.whatsapp);
  }
  assignIfDefined(basePayload, 'address', data.address);
  if (await hasColumn('merchant_profiles', 'latitude')) {
    assignIfDefined(basePayload, 'latitude', data.latitude ?? data.lat);
  }
  if (await hasColumn('merchant_profiles', 'longitude')) {
    assignIfDefined(basePayload, 'longitude', data.longitude ?? data.lng);
  }
  if (await hasColumn('merchant_profiles', 'lat')) {
    assignIfDefined(basePayload, 'lat', data.latitude ?? data.lat);
  }
  if (await hasColumn('merchant_profiles', 'lng')) {
    assignIfDefined(basePayload, 'lng', data.longitude ?? data.lng);
  }
  assignIfDefined(basePayload, 'open_time', data.open_time ?? data.openTime);
  assignIfDefined(basePayload, 'close_time', data.close_time ?? data.closeTime);
  if (await hasColumn('merchant_profiles', 'doctor_phone')) {
    assignIfDefined(basePayload, 'doctor_phone', data.doctor_phone ?? data.doctorPhone);
  }
  if (await hasColumn('merchant_profiles', 'clinic_phone')) {
    assignIfDefined(basePayload, 'clinic_phone', data.clinic_phone ?? data.clinicPhone);
  }
  if (await hasColumn('merchant_profiles', 'service_sub_category')) {
    assignIfDefined(
      basePayload,
      'service_sub_category',
      data.service_sub_category ?? data.serviceSubCategory ?? data.subCategoryId
    );
    const primaryForSub = String(
      basePayload.primary_service_id ??
        data.primary_service_id ??
        data.primaryServiceId ??
        '',
    ).trim();
    if (
      primaryForSub === 'pharmacy' &&
      !String(basePayload.service_sub_category ?? '').trim()
    ) {
      basePayload.service_sub_category = 'صيدلية';
    }
  }
  assignIfDefined(basePayload, 'delivery_areas', data.delivery_areas ?? data.deliveryAreas);
  if (data.delivery_fee !== undefined) {
    basePayload.delivery_fee = Number.parseInt(data.delivery_fee, 10) || 0;
  }
  if (data.rate_per_km !== undefined || data.ratePerKm !== undefined) {
    const raw = Number.parseInt(data.rate_per_km ?? data.ratePerKm, 10);
    basePayload.rate_per_km = Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (data.courier_mode !== undefined || data.courierMode !== undefined) {
    const { normalizeCourierMode } = require('./merchant_couriers');
    const mode = normalizeCourierMode(data.courier_mode ?? data.courierMode);
    if (await hasColumn('merchant_profiles', 'courier_mode')) {
      basePayload.courier_mode = mode;
    }
    await mergeMerchantStoreData(basePayload, null, {
      courierMode: mode,
      courier_mode: mode,
    });
  }
  if (data.is_open !== undefined || data.isOpen !== undefined) {
    basePayload.is_open = Boolean(
      data.is_open !== undefined ? data.is_open : data.isOpen
    );
  }
  if (data.rating !== undefined) {
    basePayload.rating = Number(data.rating);
  }
  const allowEmptyImages = Boolean(data._adminModerationBypass);
  const coverRaw = data.cover_image_url ?? data.coverImageUrl ?? data.coverImageBase64;
  if (coverRaw !== undefined) {
    const coverRef = normalizeMerchantImageField(coverRaw);
    if (coverRef.url || allowEmptyImages) {
      basePayload.cover_image_url = coverRef.url;
    }
  }
  const logoRaw = data.logo_image_url ?? data.logoImageUrl ?? data.logoImageBase64;
  if (logoRaw !== undefined) {
    const logoRef = normalizeMerchantImageField(logoRaw);
    if (logoRef.url || allowEmptyImages) {
      basePayload.logo_image_url = logoRef.url;
    }
  }
  const profileRaw =
    data.profile_image_base64 ??
    data.profileImageBase64 ??
    data.profile_image_url ??
    data.profileImageUrl;
  if (profileRaw !== undefined) {
    const profileRef = normalizeMerchantImageField(profileRaw);
    if (profileRef.url) {
      if (isRemoteImageUrl(profileRef.url)) {
        if (await hasColumn('merchant_profiles', 'profile_image_url')) {
          basePayload.profile_image_url = profileRef.url;
        }
        basePayload.profile_image_base64 = profileRef.url;
      } else if (!isBase64Image(profileRef.url)) {
        basePayload.profile_image_base64 = profileRef.url;
      }
    } else if (allowEmptyImages) {
      if (await hasColumn('merchant_profiles', 'profile_image_url')) {
        basePayload.profile_image_url = '';
      }
      basePayload.profile_image_base64 = '';
    }
  }
  if (await hasColumn('merchant_profiles', 'work_sample_images_base64')) {
    const incomingWorkSamples =
      data.work_sample_images_base64 ?? data.workSampleImagesBase64;
    if (incomingWorkSamples !== undefined) {
      basePayload.work_sample_images_base64 = normalizeArray(incomingWorkSamples);
    }
  }
  if (await hasColumn('merchant_profiles', 'professional_info')) {
    // دمج جزئي: التحديثات التي لا ترسل professional_info كاملاً لا تمسح
    // البيانات الحالية (التخصص، الدوام، التواصل...) — كانت تُمسح إلى {}.
    const profileKey = await resolvePhoneKey(phone);
    const currentProfile = (await getMerchantProfile(profileKey)) || {};
    const existingInfo = normalizeObject(
      currentProfile.professional_info ?? currentProfile.professionalInfo
    );
    const incomingInfo = normalizeObject(data.professional_info ?? data.professionalInfo);
    let info = { ...existingInfo, ...incomingInfo };
    const primaryForInfo = String(
      basePayload.primary_service_id ??
        data.primary_service_id ??
        data.primaryServiceId ??
        currentProfile.primary_service_id ??
        '',
    ).trim();
    const serviceIdsForInfo = normalizeArray(
      basePayload.service_ids ??
        data.service_ids ??
        data.serviceIds ??
        currentProfile.service_ids,
    ).map((item) => String(item).trim());
    const isProfessionalsMerchant =
      primaryForInfo === 'professionals' ||
      serviceIdsForInfo.includes('professionals');
    if (!isProfessionalsMerchant) {
      info = stripMerchantDirectoryProfessionalFields(info);
    }
    if (showPhoneToCustomers !== undefined || showWhatsAppToCustomers !== undefined) {
      const visibility = normalizeObject(info.contact_visibility ?? info.contactVisibility);
      if (showPhoneToCustomers !== undefined) {
        visibility.show_phone_to_customers = showPhoneToCustomers;
        visibility.showPhoneToCustomers = showPhoneToCustomers;
      }
      if (showWhatsAppToCustomers !== undefined) {
        visibility.show_whatsapp_to_customers = showWhatsAppToCustomers;
        visibility.showWhatsAppToCustomers = showWhatsAppToCustomers;
      }
      info.contact_visibility = visibility;
      info.contactVisibility = {
        showPhoneToCustomers:
          visibility.showPhoneToCustomers ?? visibility.show_phone_to_customers,
        showWhatsAppToCustomers:
          visibility.showWhatsAppToCustomers ?? visibility.show_whatsapp_to_customers,
      };
    }
    basePayload.professional_info = info;
  }
  if (await hasColumn('merchant_profiles', 'professional_category_id')) {
    const primaryForCat = String(
      basePayload.primary_service_id ??
        data.primary_service_id ??
        data.primaryServiceId ??
        '',
    ).trim();
    const serviceIdsForCat = normalizeArray(
      basePayload.service_ids ?? data.service_ids ?? data.serviceIds,
    ).map((item) => String(item).trim());
    const isProfessionalsMerchant =
      primaryForCat === 'professionals' ||
      serviceIdsForCat.includes('professionals');
    if (!isProfessionalsMerchant) {
      basePayload.professional_category_id = null;
    } else {
      assignIfDefined(
        basePayload,
        'professional_category_id',
        data.professional_category_id ?? data.professionalCategoryId,
      );
    }
  } else if (
    data.professional_category_id !== undefined ||
    data.professionalCategoryId !== undefined
  ) {
    assignIfDefined(
      basePayload,
      'professional_category_id',
      data.professional_category_id ?? data.professionalCategoryId,
    );
  }
  if (await hasColumn('merchant_profiles', 'show_phone_to_customers')) {
    if (showPhoneToCustomers !== undefined) {
      basePayload.show_phone_to_customers = showPhoneToCustomers;
    }
  }
  if (await hasColumn('merchant_profiles', 'show_whatsapp_to_customers')) {
    if (showWhatsAppToCustomers !== undefined) {
      basePayload.show_whatsapp_to_customers = showWhatsAppToCustomers;
    }
  }
  if (await hasColumn('merchant_profiles', 'service_ids')) {
    const incomingServiceIds = data.service_ids ?? data.serviceIds;
    if (incomingServiceIds !== undefined) {
      basePayload.service_ids = normalizeArray(incomingServiceIds);
    }
  }
  if (await hasColumn('merchant_profiles', 'service_enabled')) {
    if (data.service_enabled !== undefined || data.serviceEnabled !== undefined) {
      basePayload.service_enabled = normalizeObject(
        data.service_enabled ?? data.serviceEnabled
      );
    }
  } else if (
    data.service_enabled !== undefined ||
    data.serviceEnabled !== undefined
  ) {
    await mergeMerchantStoreData(basePayload, null, {
      serviceEnabled: normalizeObject(data.service_enabled ?? data.serviceEnabled),
    });
  }
  if (await hasColumn('merchant_profiles', 'active_service_id')) {
    assignIfDefined(
      basePayload,
      'active_service_id',
      data.active_service_id ?? data.activeServiceId
    );
  }
  if (await hasColumn('merchant_profiles', 'product_sections')) {
    const incomingSections = data.product_sections ?? data.productSections;
    if (incomingSections !== undefined) {
      basePayload.product_sections = normalizeArray(incomingSections);
    }
  }
  if (await hasColumn('merchant_profiles', 'restaurant_category')) {
    assignIfDefined(
      basePayload,
      'restaurant_category',
      data.restaurant_category ?? data.restaurantCategory
    );
  }
  if (await hasColumn('merchant_profiles', 'service_sub_category')) {
    assignIfDefined(
      basePayload,
      'service_sub_category',
      data.service_sub_category ?? data.serviceSubCategory ?? data.subCategoryId
    );
    const subValue = String(basePayload.service_sub_category ?? '').trim();
    if (subValue) {
      await mergeMerchantStoreData(basePayload, null, {
        serviceSubCategory: subValue,
        subCategoryId: subValue,
      });
    }
  } else {
    const subValue = String(
      data.serviceSubCategory ?? data.service_sub_category ?? data.subCategoryId ?? ''
    ).trim();
    if (subValue) {
      await mergeMerchantStoreData(basePayload, null, {
        serviceSubCategory: subValue,
        subCategoryId: subValue,
      });
    }
  }
  if (await hasColumn('merchant_profiles', 'is_approved')) {
    if (data.is_approved !== undefined || data.isApproved !== undefined) {
      basePayload.is_approved = Boolean(data.is_approved ?? data.isApproved);
    }
  }
  if (await hasColumn('merchant_profiles', 'approval_status')) {
    assignIfDefined(
      basePayload,
      'approval_status',
      data.approval_status ?? data.approvalStatus
    );
  }
  if (await hasColumn('merchant_profiles', 'rejection_reason_key')) {
    assignIfDefined(
      basePayload,
      'rejection_reason_key',
      data.rejection_reason_key ?? data.rejectionReasonKey
    );
  }
  if (await hasColumn('merchant_profiles', 'rejection_message_ar')) {
    assignIfDefined(
      basePayload,
      'rejection_message_ar',
      data.rejection_message_ar ?? data.rejectionMessageAr
    );
  }
  if (await hasColumn('merchant_profiles', 'rejected_at')) {
    assignIfDefined(basePayload, 'rejected_at', data.rejected_at ?? data.rejectedAt);
  }
  if (await hasColumn('merchant_profiles', 'admin_pre_registered')) {
    if (data.admin_pre_registered !== undefined || data.adminPreRegistered !== undefined) {
      basePayload.admin_pre_registered = Boolean(
        data.admin_pre_registered ?? data.adminPreRegistered
      );
    }
  }
  const phoneKey = await resolvePhoneKey(phone);
  const existingProfile = await getMerchantProfile(phoneKey);
  if (
    data.governorate !== undefined ||
    data.district !== undefined ||
    data.locality !== undefined ||
    data.area !== undefined
  ) {
    if (await hasColumn('merchant_profiles', 'governorate')) {
      assignIfDefined(basePayload, 'governorate', data.governorate);
      assignIfDefined(basePayload, 'district', data.district);
      assignIfDefined(basePayload, 'locality', data.locality);
    }
    await mergeMerchantStoreData(basePayload, existingProfile?.store_data, {
      ...(data.governorate !== undefined
        ? { governorate: String(data.governorate || '').trim() }
        : {}),
      ...(data.district !== undefined
        ? { district: String(data.district || '').trim() }
        : {}),
      ...(data.locality !== undefined
        ? { locality: String(data.locality || '').trim() }
        : {}),
      ...(data.area !== undefined ? { area: String(data.area || '').trim() } : {}),
    });
  }
  if (
    existingProfile &&
    isMerchantApproved(existingProfile) &&
    !adminBypass &&
    data.is_approved === undefined &&
    data.isApproved === undefined &&
    data.approval_status === undefined &&
    data.approvalStatus === undefined
  ) {
    const merged = { ...existingProfile, ...basePayload };
    if (merchantAccountRequiresApproval(merged) && merchantProfileEditIsEssential(data)) {
      basePayload.is_approved = false;
      basePayload.approval_status = 'pending';
      if (await hasColumn('merchant_profiles', 'rejection_message_ar')) {
        basePayload.rejection_message_ar = null;
      }
      if (await hasColumn('merchant_profiles', 'rejected_at')) {
        basePayload.rejected_at = null;
      }
    }
  }
  if (!existingProfile) {
    const draftProfile = {
      ...data,
      ...basePayload,
      primary_service_id:
        basePayload.primary_service_id ??
        data.primary_service_id ??
        data.primaryServiceId,
      service_ids: basePayload.service_ids ?? data.service_ids ?? data.serviceIds,
    };
    const requiresAccountApproval = merchantAccountRequiresApproval(draftProfile);
    if (await hasColumn('merchant_profiles', 'is_approved')) {
      if (basePayload.is_approved === undefined && basePayload.isApproved === undefined) {
        basePayload.is_approved = requiresAccountApproval ? false : true;
      }
    }
    if (await hasColumn('merchant_profiles', 'approval_status')) {
      const incomingStatus = String(
        data.approval_status ?? data.approvalStatus ?? ''
      ).trim();
      if (!incomingStatus) {
        basePayload.approval_status = requiresAccountApproval ? 'pending' : 'approved';
      }
    }
    const incomingStoreName = String(
      basePayload.store_name ?? data.store_name ?? data.storeName ?? ''
    ).trim();
    if (!incomingStoreName) {
      basePayload.store_name =
        String(appUser?.full_name ?? data.full_name ?? data.fullName ?? '').trim() ||
        `تاجر ${phoneKey.slice(-4)}`;
    }
  }
  await stripMissingMerchantStoreData(basePayload);
  const saved = await saveRow(
    'merchant_profiles',
    { ...basePayload, phone: phoneKey },
    'phone',
  );
  const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
  await Promise.all([
    invalidateCachePrefix('marketplace:shopping-stores:'),
    invalidateCachePrefix('marketplace:restaurant-stores:'),
    invalidateCachePrefix('marketplace:catalog-products:'),
    invalidateCachePrefix('marketplace:store-products:'),
  ]);
  invalidateCache('marketplace:offer-catalog-products');
  invalidateCache('marketplace:stats');
  // أعد نشر لقطات الحافة حتى لا تبقى الكتالوجات/الإحصاءات stale بعد الإغلاق.
  try {
    const { scheduleEdgeSnapshotPublish } = require('../lib/edge_snapshots');
    scheduleEdgeSnapshotPublish();
  } catch (_) {
    // ignore missing R2 / snapshot config
  }
  try {
    const serviceId = String(
      basePayload.active_service_id ??
        data.active_service_id ??
        data.activeServiceId ??
        basePayload.primary_service_id ??
        data.primary_service_id ??
        data.primaryServiceId ??
        existingProfile?.active_service_id ??
        existingProfile?.primary_service_id ??
        '',
    ).trim();
    if (serviceId) {
      const { serviceSubCategory } = resolveActiveServiceContext(
        { ...(existingProfile || {}), ...basePayload },
        data,
      );
      await saveMerchantServiceProfile(
        phoneKey,
        serviceId,
        { ...(existingProfile || {}), ...basePayload, ...data },
        serviceSubCategory,
      );
    }
  } catch (serviceProfileError) {
    console.warn(
      'saveMerchantServiceProfile:',
      serviceProfileError?.message || serviceProfileError,
    );
  }
  return enrichMerchantProfileWithServiceProfiles(phoneKey, saved);
}

async function deleteMerchantProfile(phone) {
  return deleteRow('merchant_profiles', 'phone', phone);
}

async function getMerchantProducts(phone) {
  const variants = getPhoneVariants(phone);
  const rows = await selectManyColumnsWithFallback(
    'merchant_products',
    LISTING_PRODUCT_SELECT,
    LISTING_PRODUCT_SELECT_FALLBACK,
    [{ method: 'in', column: 'phone', value: variants }],
    { column: 'created_at', ascending: false },
    500
  );
  return rows.map(serializeProductRowForClient);
}

async function saveMerchantProduct(phone, data = {}, options = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);
  const targetCategoryEarly = String(
    data.category ?? data.service_id ?? data.serviceId ?? ''
  ).trim();

  const {
    EDEN_PRINTING_CATEGORY,
    isEdenPrintingCategory,
    getEdenPrintingStoreNameForPhone,
    profileHasEdenPrintingService,
    assertCanPublishEdenPrinting,
  } = require('../lib/eden_printing');

  let merchantProfile = await getMerchantProfile(phoneKey);
  if (isEdenPrintingCategory(targetCategoryEarly)) {
    if (!merchantProfile) {
      const pinnedStoreName = getEdenPrintingStoreNameForPhone(phoneKey);
      merchantProfile = await ensureMerchantProfileRecord(phoneKey, {
        store_name: pinnedStoreName || 'مطبعة',
        primary_service_id: EDEN_PRINTING_CATEGORY,
        is_approved: true,
        approval_status: 'approved',
      });
    } else if (!profileHasEdenPrintingService(merchantProfile)) {
      const serviceIdsRaw = Array.isArray(merchantProfile.service_ids)
        ? merchantProfile.service_ids.map((id) => String(id).trim()).filter(Boolean)
        : [];
      const nextServiceIds = serviceIdsRaw.includes(EDEN_PRINTING_CATEGORY)
        ? serviceIdsRaw
        : [...serviceIdsRaw, EDEN_PRINTING_CATEGORY];
      const patch = {
        service_ids: nextServiceIds,
        is_approved: true,
        approval_status: 'approved',
      };
      if (!String(merchantProfile.primary_service_id || '').trim()) {
        patch.primary_service_id = EDEN_PRINTING_CATEGORY;
        patch.active_service_id = EDEN_PRINTING_CATEGORY;
      }
      try {
        await saveMerchantProfile(phoneKey, patch);
        merchantProfile = (await getMerchantProfile(phoneKey)) || merchantProfile;
      } catch (error) {
        console.warn(
          'ensure eden_printing service on profile:',
          error?.message || error,
        );
      }
    }
  }
  assertCanPublishEdenPrinting(phoneKey, targetCategoryEarly, merchantProfile);
  if (
    String(targetCategoryEarly).trim() === 'offers' &&
    options.allowCustomerOffers !== true &&
    options.adminSave !== true &&
    data._adminModerationBypass !== true
  ) {
    throw new Error(
      'OFFERS_CUSTOMER_ONLY: نشر العروض متاح من حساب الزبون في قسم العروض فقط.',
    );
  }
  if (
    String(targetCategoryEarly).trim() === 'used' &&
    options.allowCustomerUsed !== true &&
    options.adminSave !== true &&
    data._adminModerationBypass !== true
  ) {
    throw new Error(
      'USED_CUSTOMER_ONLY: نشر المستعمل متاح من حساب الزبون في قسم المستعمل فقط.',
    );
  }
  if (
    String(targetCategoryEarly).trim() === 'real_estate' &&
    options.allowCustomerRealEstate !== true &&
    options.adminSave !== true &&
    data._adminModerationBypass !== true
  ) {
    throw new Error(
      'REAL_ESTATE_CUSTOMER_ONLY: نشر العقارات متاح من قسم العقارات بحساب الزبون فقط.',
    );
  }
  if (!merchantProfile) {
    throw new Error('Merchant profile not found.');
  }
  const productId =
    data.id && String(data.id).trim().length > 0
      ? String(data.id).trim()
      : String(Date.now());
  let existingProduct = null;
  if (productId) {
    existingProduct = await selectSingle('merchant_products', 'id', productId);
  }
  if (existingProduct && !phonesOverlap(existingProduct.phone, phoneKey)) {
    throw new Error('Unauthorized product update.');
  }
  const availabilityOnlyKeys = new Set([
    'id',
    'phone',
    'is_available',
    'isAvailable',
  ]);
  const isAvailabilityOnlyUpdate =
    Boolean(existingProduct) &&
    Object.keys(data || {}).every((key) => availabilityOnlyKeys.has(key)) &&
    (data.is_available !== undefined || data.isAvailable !== undefined);
  if (isAvailabilityOnlyUpdate) {
    const isAvailable = Boolean(
      data.is_available !== undefined ? data.is_available : data.isAvailable,
    );
    const supabase = assertSupabaseAdmin();
    const { data: saved, error } = await supabase
      .from('merchant_products')
      .update({
        is_available: isAvailable,
        updated_at: nowIso(),
      })
      .eq('id', productId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
    invalidateCache('marketplace:offer-catalog-products');
    return saved;
  }
  const resolvedSectionId = String(
    data.section_id ??
      data.sectionId ??
      existingProduct?.section_id ??
      existingProduct?.sectionId ??
      ''
  ).trim();
  // إذا لم يعدل التاجر اسم المتجر بعد، نأخذه من البيانات الواردة (للمهنيين بشكل خاص)
  const payload = {
    id: productId,
    phone: phoneKey,
    updated_at: nowIso(),
  };
  if (await hasColumn('merchant_products', 'merchant_user_id')) {
    payload.merchant_user_id = appUser?.id || null;
  }
  if (await hasColumn('merchant_products', 'service_id')) {
    payload.service_id = String(
      data.service_id ?? data.serviceId ?? data.category ?? 'restaurant'
    ).trim() || 'restaurant';
  }
  const targetCategory = String(
    data.category ?? data.service_id ?? data.serviceId ?? payload.service_id ?? ''
  ).trim();
  if (targetCategory === 'bazar_ghaith') {
    // LEGACY — bazaar marketplace channel removed from Talab app.
    throw new Error('BAZAAR_CHANNEL_REMOVED');
  }

  const publishCategory = targetCategory;
  let sectionIdKnown = !resolvedSectionId;
  if (publishCategory === 'restaurant' || publishCategory === 'product') {
    const sections = merchantProfileSections(merchantProfile);
    if (sections.length > 0) {
      if (!resolvedSectionId) {
        // منتجات قديمة بلا قسم: اسمح بالتحديث (إيقاف/تشغيل/تعديل) ولا ترفض الحفظ.
        // القسم إلزامي فقط عند إنشاء منتج جديد.
        if (!existingProduct) {
          throw new Error('SECTION_REQUIRED');
        }
        sectionIdKnown = false;
      } else {
        sectionIdKnown = sections.some(
          (section) => String(section?.id ?? '').trim() === resolvedSectionId
        );
        if (!sectionIdKnown) {
          // منتج موجود بقسم محذوف/قديم: اسمح بتعديل الاسم والسعر ولا ترفض الحفظ.
          // الرفض كان يظهر للتاجر كـ «تحقق من الاتصال».
          if (!existingProduct) {
            throw new Error('SECTION_NOT_FOUND');
          }
        }
      }
    } else {
      sectionIdKnown = Boolean(resolvedSectionId);
    }
  }
  // Only write name/description when the client actually sent them.
  // `?? ''` used to wipe descriptions on partial updates (e.g. availability
  // toggles that also send category/section_id and miss the fast path).
  if (data.name_ar !== undefined || data.nameAr !== undefined) {
    const value = data.name_ar ?? data.nameAr;
    payload.name_ar =
      value == null || String(value).trim() === ''
        ? String(existingProduct?.name_ar ?? existingProduct?.name_en ?? '').trim()
        : String(value).trim();
  }
  if (data.name_en !== undefined || data.nameEn !== undefined) {
    const value = data.name_en ?? data.nameEn;
    // الأدمن غالباً يرسل name_en: null — لا تكتب null على عمود NOT NULL.
    payload.name_en =
      value == null || String(value).trim() === ''
        ? String(
            existingProduct?.name_en ??
              existingProduct?.name_ar ??
              payload.name_ar ??
              data.name_ar ??
              data.nameAr ??
              ''
          ).trim()
        : String(value).trim();
  }
  if (data.description_ar !== undefined || data.descriptionAr !== undefined) {
    assignIfDefined(
      payload,
      'description_ar',
      data.description_ar ?? data.descriptionAr ?? ''
    );
  }
  if (data.description_en !== undefined || data.descriptionEn !== undefined) {
    assignIfDefined(
      payload,
      'description_en',
      data.description_en ?? data.descriptionEn ?? ''
    );
  }
  if (isEdenPrintingCategory(targetCategory)) {
    payload.price = 0;
  } else if (data.price !== undefined) {
    payload.price = Number.parseInt(data.price, 10) || 0;
  }
  if (data.rating !== undefined) {
    payload.rating = Number(data.rating);
  }
  assignIfDefined(payload, 'category', data.category);
  assignIfDefined(payload, 'sub_category', data.sub_category ?? data.subCategory);
  if (await hasColumn('merchant_products', 'available_until')) {
    const rawUntil = data.available_until ?? data.availableUntil;
    if (rawUntil !== undefined) {
      if (rawUntil === null || rawUntil === '') {
        payload.available_until = null;
      } else {
        const parsed = new Date(rawUntil);
        payload.available_until = Number.isNaN(parsed.getTime())
          ? null
          : parsed.toISOString();
      }
    }
  }
  const publishCategoryForOffers = String(
    payload.category ?? data.category ?? existingProduct?.category ?? '',
  ).trim();
  if (
    publishCategoryForOffers === 'offers' &&
    !(await hasColumn('merchant_products', 'available_until'))
  ) {
    console.warn(
      'offers publish without available_until column — apply supabase/20260720_product_available_until.sql',
    );
  }
  if (
    publishCategoryForOffers === 'offers' &&
    await hasColumn('merchant_products', 'available_until') &&
    payload.available_until === undefined &&
    !existingProduct?.available_until
  ) {
    // افتراضي: 7 أيام إن لم تُرسل مدة.
    payload.available_until = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
  if (await hasColumn('merchant_products', 'section_id')) {
    if (resolvedSectionId && sectionIdKnown) {
      payload.section_id = resolvedSectionId;
    } else if (existingProduct && resolvedSectionId && !sectionIdKnown) {
      // امسح القسم اليتيم حتى لا يبقى يفشل التحديث لاحقاً.
      payload.section_id = null;
    } else if (!resolvedSectionId && existingProduct) {
      // لا تعِد كتابة section_id الفارغ فوق قيمة موجودة بدون داعٍ.
    } else {
      assignIfDefined(payload, 'section_id', data.section_id ?? data.sectionId);
    }
  }
  assignIfDefined(
    payload,
    'category_label_ar',
    data.category_label_ar ?? data.categoryLabelAr
  );
  assignIfDefined(
    payload,
    'category_label_en',
    data.category_label_en ?? data.categoryLabelEn
  );
  Object.assign(payload, normalizeProductImagePayload(data));
  // لا تمسح صورة موجودة إذا فشل تطبيع الصورة القادمة من العميل.
  if (existingProduct && !String(payload.image || '').trim()) {
    payload.image = existingProduct.image ?? existingProduct.image_url ?? '';
  }
  // العقارات: الصور تُرفع كـ Base64 بلا خدمة روابط — احتفظ بالصورة الرئيسية
  // حتى تُعرض في التطبيق بدل الصورة الافتراضية الثابتة.
  if (String(payload.category || '').trim() === 'real_estate') {
    const rawMain = data.image_base64 ?? data.imageBase64;
    const mainTrimmed = rawMain != null ? String(rawMain).trim() : '';
    if (mainTrimmed && isBase64Image(mainTrimmed)) {
      payload.image_base64 = mainTrimmed;
      payload.image = mainTrimmed;
    }
  }
  if (data.is_favorite !== undefined) {
    payload.is_favorite = Boolean(data.is_favorite);
  }
  assignIfDefined(
    payload,
    'avg_price_label_ar',
    data.avg_price_label_ar ?? data.avgPriceLabelAr
  );
  assignIfDefined(
    payload,
    'avg_price_label_en',
    data.avg_price_label_en ?? data.avgPriceLabelEn
  );
  assignIfDefined(
    payload,
    'action_label_ar',
    data.action_label_ar ?? data.actionLabelAr
  );
  assignIfDefined(
    payload,
    'action_label_en',
    data.action_label_en ?? data.actionLabelEn
  );
  assignIfDefined(payload, 'address', data.address);
  if (data.bedrooms !== undefined && data.bedrooms !== null) {
    payload.bedrooms = Number.parseInt(data.bedrooms, 10);
  }
  if (data.bathrooms !== undefined && data.bathrooms !== null) {
    payload.bathrooms = Number.parseInt(data.bathrooms, 10);
  }
  if (data.area_square_meter !== undefined && data.area_square_meter !== null) {
    payload.area_square_meter = Number.parseInt(data.area_square_meter, 10);
  }
  if (data.floor_count !== undefined && data.floor_count !== null) {
    payload.floor_count = Number.parseInt(data.floor_count, 10);
  }
  assignIfDefined(payload, 'listing_mode', data.listing_mode ?? data.listingMode);
  if (await hasColumn('merchant_products', 'neighborhood')) {
    assignIfDefined(payload, 'neighborhood', data.neighborhood);
  }
  if (await hasColumn('merchant_products', 'facade')) {
    assignIfDefined(payload, 'facade', data.facade);
  }
  if (await hasColumn('merchant_products', 'gallery_images_base64')) {
    if (data.gallery_images_base64 !== undefined || data.galleryImagesBase64 !== undefined) {
      const raw = data.gallery_images_base64 ?? data.galleryImagesBase64;
      const entries = Array.isArray(raw)
        ? raw.map((entry) => String(entry || '').trim()).filter(Boolean)
        : normalizeArray(raw);
      if (String(payload.category || '').trim() === 'real_estate') {
        // العقارات: صور Base64 مرفوعة من التاجر — احتفظ بها كاملة.
        payload.gallery_images_base64 = entries;
      } else {
        payload.gallery_images_base64 = entries.filter((entry) => isRemoteImageUrl(entry));
      }
    }
  }
  if (data.prep_minutes !== undefined && data.prep_minutes !== null) {
    payload.prep_minutes = Number.parseInt(data.prep_minutes, 10);
  }
  if (data.is_available !== undefined || data.isAvailable !== undefined) {
    if (await hasColumn('merchant_products', 'is_available')) {
      payload.is_available = Boolean(
        data.is_available !== undefined ? data.is_available : data.isAvailable
      );
    }
  }
  if (
    (data.stock_quantity !== undefined || data.stockQuantity !== undefined) &&
    (await hasColumn('merchant_products', 'stock_quantity'))
  ) {
    const raw = data.stock_quantity ?? data.stockQuantity;
    if (raw === null || raw === '') {
      payload.stock_quantity = null;
    } else {
      const parsed = Number.parseInt(String(raw), 10);
      payload.stock_quantity = Number.isFinite(parsed)
        ? Math.max(0, parsed)
        : null;
      if (
        payload.stock_quantity === 0 &&
        (data.stock_quantity !== undefined || data.stockQuantity !== undefined) &&
        raw !== null &&
        raw !== ''
      ) {
        payload.is_available = false;
      }
      // إعادة التوفر تلقائياً عند زيادة الكمية بعد نفاد سابق
      if (
        payload.stock_quantity > 0 &&
        existingProduct &&
        Number(existingProduct.stock_quantity ?? -1) <= 0 &&
        data.is_available === undefined &&
        data.isAvailable === undefined
      ) {
        payload.is_available = true;
      }
    }
  }

  if (
    (data.video_url !== undefined || data.videoUrl !== undefined) &&
    (await hasColumn('merchant_products', 'video_url'))
  ) {
    const rawVideo = data.video_url ?? data.videoUrl;
    if (rawVideo === null || String(rawVideo).trim() === '') {
      payload.video_url = null;
    } else {
      const url = String(rawVideo).trim();
      payload.video_url = /^https?:\/\//i.test(url) ? url : null;
    }
  }

  if (
    (data.barcode !== undefined || data.Barcode !== undefined) &&
    (await hasColumn('merchant_products', 'barcode'))
  ) {
    const rawBarcode = String(data.barcode ?? data.Barcode ?? '').trim();
    payload.barcode = rawBarcode || null;
  }

  if (
    (data.cost !== undefined || data.cost_price !== undefined || data.costPrice !== undefined) &&
    (await hasColumn('merchant_products', 'cost_price'))
  ) {
    const rawCost = data.cost_price ?? data.costPrice ?? data.cost;
    if (rawCost === null || rawCost === '') {
      payload.cost_price = null;
    } else {
      const parsed = Number(rawCost);
      payload.cost_price = Number.isFinite(parsed) ? parsed : 0;
    }
  }

  const adminSave = options.adminSave === true || data._adminModerationBypass === true;
  const edenPrintingOwnerPublish =
    isEdenPrintingCategory(targetCategory) && isEdenPrintingOwnerPhone(phoneKey);
  const explicitApproved =
    data.is_approved === true ||
    data.isApproved === true ||
    String(data.approval_status ?? data.approvalStatus ?? '').trim() === 'approved';
  const explicitRejected =
    data.is_approved === false ||
    data.isApproved === false ||
    String(data.approval_status ?? data.approvalStatus ?? '').trim() === 'rejected';

  if (await hasColumn('merchant_products', 'is_approved')) {
    if (edenPrintingOwnerPublish || (adminSave && explicitApproved)) {
      // نماذج مطبعة جنة عدن تظهر فوراً للزبائن بدون موافقة إدارية.
      payload.is_approved = true;
      payload.approval_status = 'approved';
      if (await hasColumn('merchant_products', 'rejection_message_ar')) {
        payload.rejection_message_ar = null;
      }
      if (await hasColumn('merchant_products', 'rejected_at')) {
        payload.rejected_at = null;
      }
    } else if (adminSave && explicitRejected) {
      payload.is_approved = false;
      payload.approval_status = 'rejected';
      assignIfDefined(
        payload,
        'rejection_message_ar',
        data.rejection_message_ar ?? data.rejectionMessageAr
      );
      if (await hasColumn('merchant_products', 'rejected_at')) {
        payload.rejected_at = nowIso();
      }
    } else if (!adminSave) {
      const contentChanged = merchantProductModerationContentChanged(
        existingProduct,
        data
      );
      if (!contentChanged && existingProduct) {
        // مزامنة بدون تعديل المحتوى: لا تلمس حقول الموافقة إطلاقاً.
        // إعادة كتابة snapshot قديم كانت تلغي رفض الأدمن إذا تزامن الحفظ مع الرفض.
      } else {
        // منتج جديد أو محتوى معدّل — أعده لطابور المراجعة.
        payload.is_approved = false;
        payload.approval_status = 'pending';
        if (await hasColumn('merchant_products', 'rejection_message_ar')) {
          payload.rejection_message_ar = null;
        }
        if (await hasColumn('merchant_products', 'rejected_at')) {
          payload.rejected_at = null;
        }
      }
    } else if (existingProduct) {
      // حفظ أدمن بدون قرار موافقة صريح: لا تلمس حالة الموافقة الحالية.
    } else {
      payload.is_approved = false;
      payload.approval_status = 'pending';
    }
  }

  // PostgREST upsert builds a proposed INSERT row first; missing NOT NULL
  // columns become null and fail even when updating an existing id.
  if (existingProduct) {
    if (payload.name_ar === undefined || payload.name_ar === null) {
      payload.name_ar = existingProduct.name_ar ?? existingProduct.name_en ?? '';
    }
    if (payload.name_en === undefined || payload.name_en === null || payload.name_en === '') {
      payload.name_en =
        existingProduct.name_en ||
        existingProduct.name_ar ||
        payload.name_ar ||
        '';
    }
    if (payload.category === undefined || payload.category === null) {
      payload.category = existingProduct.category ?? payload.service_id ?? 'product';
    }
    if (
      (payload.service_id === undefined || payload.service_id === null) &&
      (await hasColumn('merchant_products', 'service_id'))
    ) {
      payload.service_id =
        existingProduct.service_id ?? existingProduct.category ?? payload.category;
    }
    if (payload.price === undefined || payload.price === null) {
      payload.price = Number.parseInt(existingProduct.price, 10) || 0;
    }
    if (payload.image === undefined || payload.image === null || payload.image === '') {
      payload.image = existingProduct.image ?? existingProduct.image_url ?? '';
    }
    if (
      (payload.merchant_user_id === undefined || payload.merchant_user_id === null) &&
      existingProduct.merchant_user_id &&
      (await hasColumn('merchant_products', 'merchant_user_id'))
    ) {
      payload.merchant_user_id = existingProduct.merchant_user_id;
    }
  } else {
    // إنشاء منتج جديد: أعمدة الاسم إلزامية.
    if (!String(payload.name_ar || '').trim()) {
      payload.name_ar = String(data.name_ar ?? data.nameAr ?? 'منتج').trim() || 'منتج';
    }
    if (!String(payload.name_en || '').trim()) {
      payload.name_en = String(
        data.name_en ?? data.nameEn ?? payload.name_ar
      ).trim();
    }
  }

  // ضمان أخير: لا تُرسل null أبداً لأعمدة الاسم الإلزامية.
  if (payload.name_ar === null || payload.name_ar === undefined) {
    payload.name_ar = String(existingProduct?.name_ar ?? 'منتج');
  }
  if (payload.name_en === null || payload.name_en === undefined || payload.name_en === '') {
    payload.name_en = String(
      existingProduct?.name_en || existingProduct?.name_ar || payload.name_ar || 'Product'
    );
  }

  // التحديث لمنتج موجود عبر UPDATE فقط — يتجنب فشل upsert على أعمدة NOT NULL.
  let saved;
  if (existingProduct) {
    saved = await updateRow('merchant_products', 'id', productId, payload);
    if (!saved) {
      throw new Error('Failed to update merchant product.');
    }
  } else {
    saved = await saveRow('merchant_products', payload, 'id');
  }
  try {
    const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
    await Promise.all([
      invalidateCachePrefix('marketplace:shopping-stores:'),
      invalidateCachePrefix('marketplace:restaurant-stores:'),
      invalidateCachePrefix('marketplace:service-stores:'),
      invalidateCachePrefix('marketplace:catalog-products:'),
      invalidateCachePrefix('marketplace:store-products:'),
    ]);
    invalidateCache('marketplace:offer-catalog-products');
    invalidateCache('marketplace:stats');
    try {
      const { scheduleEdgeSnapshotPublish } = require('../lib/edge_snapshots');
      scheduleEdgeSnapshotPublish();
    } catch (_) {
      // ignore missing R2 / snapshot config
    }
  } catch (_) {
    // ignore cache errors
  }
  return saved;
}

async function deleteMerchantProduct(id, phone) {
  const productId = String(id || '').trim();
  if (!productId) {
    throw new Error('Product id is required.');
  }

  const supabase = assertSupabaseAdmin();
  const phoneKey = phone ? await resolvePhoneKey(phone) : null;

  const existing = await selectSingle('merchant_products', 'id', productId);
  if (!existing) {
    // قد يكون الإعلان انتقل إلى customer_listings فقط.
    try {
      const { deleteCustomerListing, getCustomerListingById } = require('./customer_listings');
      const listing = await getCustomerListingById(productId);
      if (listing) {
        await deleteCustomerListing(productId, phoneKey || phone);
        return { success: true, deleted: 1, source: 'customer_listings' };
      }
    } catch (_) {}
    return { success: true, deleted: 0 };
  }

  if (phoneKey) {
    const ownerPhone = String(existing.phone || '').trim();
    if (ownerPhone && !phonesOverlap(ownerPhone, phoneKey)) {
      throw new Error('Unauthorized to delete this product.');
    }
  }

  // حماية الترحيل: إعلانات الزبون (عقارات/مستعمل/عروض) لا تُحذف من merchant_products.
  const category = String(existing.category || existing.service_id || '').trim();
  const listingMode = String(existing.listing_mode || '').trim();
  const isProtectedCustomerListing =
    category === 'real_estate' ||
    (category === 'used' && listingMode === 'customer_used') ||
    (category === 'offers' && listingMode === 'customer_offer');
  if (isProtectedCustomerListing) {
    try {
      const { deleteCustomerListing } = require('./customer_listings');
      await deleteCustomerListing(productId, phoneKey || phone);
    } catch (error) {
      console.warn('deleteCustomerListing during protected delete:', error?.message || error);
    }
    return {
      success: true,
      deleted: 0,
      archivedLegacy: true,
      message: 'Customer listing removed from customer_listings; merchant_products kept as archive.',
    };
  }

  // احذف بالمعرّف بعد التحقق من الملكية — تجنّب فشل صامت بسبب اختلاف صيغة رقم الهاتف.
  const { data, error } = await supabase
    .from('merchant_products')
    .delete()
    .eq('id', productId)
    .select('id');
  if (error) throw new Error(error.message);

  const deletedCount = Array.isArray(data) ? data.length : 0;
  if (deletedCount === 0) {
    throw new Error('Failed to delete product.');
  }

  if (phoneKey) {
    await removeMerchantProductFromUserState(phoneKey, productId);
  }
  const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
  await invalidateCachePrefix('marketplace:catalog-products:');
  invalidateCache('marketplace:offer-catalog-products');
  return { success: true, deleted: deletedCount };
}

async function removeMerchantProductFromUserState(_phoneKey, _productId) {
  // Legacy: products live in merchant_products only (app_state.items no longer used).
}

function enrichProfessionalProfileRow(row) {
  const info = normalizeObject(row.professional_info);
  const visibility = resolveMerchantContactVisibility(row);
  const rawPhone = String(info.phone || row.whatsapp || row.phone || '').trim();
  const rawWhatsapp = String(
    row.whatsapp || info.whatsapp || info.phone || row.phone || ''
  ).trim();
  const serviceIds = normalizeArray(row.service_ids).map((item) => String(item));
  const isProfessionalProfile = serviceIds.includes('professionals');
  const contactPhone = isProfessionalProfile
    ? rawPhone || String(row.phone || '').trim()
    : visibility.showPhoneToCustomers
      ? rawPhone || String(row.phone || '').trim()
      : '';
  const contactWhatsapp = isProfessionalProfile
    ? rawWhatsapp || contactPhone || String(row.phone || '').trim()
    : visibility.showWhatsAppToCustomers
      ? rawWhatsapp || contactPhone || String(row.phone || '').trim()
      : '';
  const address = String(row.address || info.address || '').trim();
  const openTime = String(row.open_time || info.openTime || '').trim();
  const closeTime = String(row.close_time || info.closeTime || '').trim();
  const morningOpenTime = String(
    info.morningOpenTime || info.morning_open_time || '',
  ).trim();
  const morningCloseTime = String(
    info.morningCloseTime || info.morning_close_time || '',
  ).trim();
  const eveningOpenTime = String(
    info.eveningOpenTime || info.evening_open_time || '',
  ).trim();
  const eveningCloseTime = String(
    info.eveningCloseTime || info.evening_close_time || '',
  ).trim();
  return {
    ...row,
    phone: contactPhone,
    whatsapp: contactWhatsapp,
    show_phone_to_customers: visibility.showPhoneToCustomers,
    show_whatsapp_to_customers: visibility.showWhatsAppToCustomers,
    customer_phone: contactPhone,
    customer_whatsapp: contactWhatsapp,
    address: address || row.address,
    open_time: openTime || row.open_time,
    close_time: closeTime || row.close_time,
    morning_open_time: morningOpenTime || undefined,
    morning_close_time: morningCloseTime || undefined,
    evening_open_time: eveningOpenTime || undefined,
    evening_close_time: eveningCloseTime || undefined,
    morningOpenTime: morningOpenTime || undefined,
    morningCloseTime: morningCloseTime || undefined,
    eveningOpenTime: eveningOpenTime || undefined,
    eveningCloseTime: eveningCloseTime || undefined,
    profile_image_base64:
      info.profileImageBase64 ||
      row.profile_image_base64 ||
      row.profile_image_url ||
      '',
  };
}

async function listProfessionalProfiles(professionId = '') {
  const { professionalCategoryMatches } = require('../lib/professional_categories');
  const target = String(professionId || '').trim();
  const {
    listCustomerProfessionalDirectoryRows,
  } = require('./customer_professionals');

  const [customerRows, profiles] = await Promise.all([
    listCustomerProfessionalDirectoryRows(target),
    selectMany('merchant_profiles'),
  ]);

  const seen = new Set(
    customerRows.map(
      (row) =>
        `${String(row.phone || '').trim()}::${String(row.professional_category_id || '').trim()}`,
    ),
  );

  const legacyRows = profiles
    .filter((row) => {
      if (isMerchantFrozen(row)) return false;
      if (!isMerchantApproved(row)) return false;
      if (row.is_open === false) return false;
      const categoryId = String(row.professional_category_id || '').trim();
      if (!categoryId) return false;
      const info = normalizeObject(row.professional_info);
      const isCustomer =
        info.customer_professional === true || info.customerProfessional === true;
      if (isCustomer) {
        const key = `${String(row.phone || '').trim()}::${categoryId}`;
        if (seen.has(key)) return false;
      }
      const name = String(info.name ?? row.store_name ?? '').trim();
      if (!name) return false;
      if (target && !professionalCategoryMatches(categoryId, target)) return false;
      return true;
    })
    .map((row) => enrichProfessionalProfileRow(row));

  return [...customerRows.map((row) => enrichProfessionalProfileRow(row)), ...legacyRows];
}


/** حجم آمن لقيم `.in` لتجنب طول URL عند PostgREST. */
const MERCHANT_PRODUCTS_PHONE_IN_CHUNK = 90;

function chunkValues(values, size = MERCHANT_PRODUCTS_PHONE_IN_CHUNK) {
  const list = Array.isArray(values) ? values : [];
  const chunkSize = Math.max(1, Number(size) || MERCHANT_PRODUCTS_PHONE_IN_CHUNK);
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * أعمدة خفيفة لقوائم المتاجر/المطاعم — بدون *_base64 لتقليل Egress.
 * قائمة ثابتة (بدون hasColumn لكل عمود) حتى لا نضاعف ضغط Supabase عند أول طلب.
 */
const LISTING_PRODUCT_SELECT = [
  'id',
  'phone',
  'name_ar',
  'name_en',
  'description_ar',
  'description_en',
  'price',
  'discounted_price',
  'original_price',
  'rating',
  'category',
  'sub_category',
  'category_label_ar',
  'category_label_en',
  'image',
  'image_url',
  'video_url',
  'listing_mode',
  'prep_minutes',
  'is_available',
  'stock_quantity',
  'available_until',
  'is_approved',
  'approval_status',
  'section_id',
  'times_ordered',
  'created_at',
  'updated_at',
].join(',');

const LISTING_PRODUCT_SELECT_FALLBACK = [
  'id',
  'phone',
  'name_ar',
  'name_en',
  'description_ar',
  'description_en',
  'price',
  'rating',
  'category',
  'sub_category',
  'image',
  'listing_mode',
  'is_available',
  'stock_quantity',
  'created_at',
  'updated_at',
].join(',');

/** تصفية ظهور المتجر فقط — بدون أسماء/أوصاف/صور لتقليل Egress في مرحلة القائمة. */
const LISTING_PRODUCT_META_SELECT = [
  'id',
  'phone',
  'category',
  'sub_category',
  'is_available',
  'stock_quantity',
  'is_approved',
  'approval_status',
  'listing_mode',
  'times_ordered',
].join(',');

const LISTING_PRODUCT_META_SELECT_FALLBACK = [
  'id',
  'phone',
  'category',
  'sub_category',
  'is_available',
  'stock_quantity',
  'listing_mode',
].join(',');

const LISTING_PROFILE_SELECT = [
  'phone',
  'store_name',
  'description',
  'primary_service_id',
  'whatsapp',
  'address',
  'open_time',
  'close_time',
  'delivery_areas',
  'delivery_fee',
  'is_open',
  'is_frozen',
  'rating',
  'cover_image_url',
  'logo_image_url',
  'profile_image_url',
  'service_ids',
  'active_service_id',
  'is_approved',
  'approval_status',
  'is_bazaar_member',
  'restaurant_category',
  'service_sub_category',
  'latitude',
  'longitude',
  'created_at',
  'updated_at',
].join(',');

const LISTING_PROFILE_SELECT_FALLBACK = [
  'phone',
  'store_name',
  'description',
  'primary_service_id',
  'whatsapp',
  'address',
  'open_time',
  'close_time',
  'is_open',
  'is_frozen',
  'rating',
  'cover_image_url',
  'logo_image_url',
  'service_ids',
  'active_service_id',
  'created_at',
  'updated_at',
].join(',');

async function selectManyColumnsWithFallback(table, primary, fallback, filters, orderBy, limit) {
  try {
    return await selectManyColumns(table, primary, filters, orderBy, limit);
  } catch (error) {
    const message = String(error?.message || error || '');
    if (!/column|does not exist|42703/i.test(message)) throw error;
    console.warn(`listing columns fallback for ${table}:`, message);

    // إن ذُكر عمود ناقص في الرسالة، أزلْه من الـ select وأعد المحاولة قبل الـ fallback الثابت.
    const missingMatch = message.match(/column\s+[\w.]+\.(\w+)\s+does not exist/i);
    const missingCol = missingMatch?.[1] ? String(missingMatch[1]).trim() : '';
    if (missingCol) {
      const stripped = String(primary || '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && part !== missingCol)
        .join(',');
      if (stripped && stripped !== primary) {
        try {
          return await selectManyColumns(table, stripped, filters, orderBy, limit);
        } catch (retryError) {
          console.warn(
            `listing columns strip-retry for ${table}:`,
            retryError?.message || retryError,
          );
        }
      }
    }

    return selectManyColumns(table, fallback, filters, orderBy, limit);
  }
}

/**
 * فهرسة منتجات حسب كل أشكال الهاتف، مع الحفاظ على ترتيب الصفوف الواردة
 * وتجنب تكرار نفس المنتج عند جمعه لتاجر واحد.
 */
function indexProductsByPhoneVariants(products) {
  const byVariant = new Map();
  for (const row of Array.isArray(products) ? products : []) {
    for (const variant of getPhoneVariants(row?.phone)) {
      if (!byVariant.has(variant)) byVariant.set(variant, []);
      byVariant.get(variant).push(row);
    }
  }
  return byVariant;
}

function collectProductsForPhone(productsByVariant, phone) {
  const collected = [];
  const seen = new Set();
  for (const variant of getPhoneVariants(phone)) {
    const rows = productsByVariant.get(variant) || [];
    for (const row of rows) {
      const key =
        row?.id != null && String(row.id).trim()
          ? `id:${String(row.id).trim()}`
          : `row:${String(row?.phone || '')}|${String(row?.name_ar || '')}|${String(row?.created_at || '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(row);
    }
  }
  return collected;
}

async function loadMerchantProductsForPhones(phones, { metaOnly = false } = {}) {
  const uniquePhones = [
    ...new Set(
      (Array.isArray(phones) ? phones : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  if (uniquePhones.length === 0) return [];

  const primary = metaOnly ? LISTING_PRODUCT_META_SELECT : LISTING_PRODUCT_SELECT;
  const fallback = metaOnly
    ? LISTING_PRODUCT_META_SELECT_FALLBACK
    : LISTING_PRODUCT_SELECT_FALLBACK;

  const chunks = chunkValues(uniquePhones, MERCHANT_PRODUCTS_PHONE_IN_CHUNK);
  const parts = await Promise.all(
    chunks.map((chunk) =>
      selectManyColumnsWithFallback(
        'merchant_products',
        primary,
        fallback,
        [{ method: 'in', column: 'phone', value: chunk }],
        { column: 'created_at', ascending: false }
      )
    )
  );
  return parts.flat();
}

function parseCompactFlag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'compact';
}

async function listMerchantStoresByService({
  serviceId,
  productCategory,
  subCategoryId = '',
  marketplaceCategory = '',
  compact = false,
}) {
  const normalizedServiceId = String(serviceId || '').trim();
  const channel = String(marketplaceCategory || '').trim();
  // LEGACY — bazaar channel removed; never list stores for customers.
  if (normalizedServiceId === 'bazar_ghaith' || channel === 'bazar_ghaith') {
    return [];
  }
  const profiles = await selectManyColumnsWithFallback(
    'merchant_profiles',
    LISTING_PROFILE_SELECT,
    LISTING_PROFILE_SELECT_FALLBACK,
    [],
    undefined,
    2000
  );
  const normalizedSubCategoryId = String(subCategoryId || '').trim();
  const isContactOnly = CONTACT_ONLY_SERVICES.has(normalizedServiceId);
  const serviceProfilesByPhone = await loadServiceProfilesByPhone();

  if (normalizedServiceId === 'beauty' && normalizedSubCategoryId === 'صيدلية') {
    // إصلاحات رحّالية قديمة لملفات الصيدليات — تُنفَّذ في الخلفية (لا توقف
    // استجابة الطلب!) ومرة كل 15 دقيقة كحد أقصى. أي خطأ يُتجاوز.
    const now = Date.now();
    if (now - lastPharmacyRepairAt >= PHARMACY_REPAIR_COOLDOWN_MS) {
      lastPharmacyRepairAt = now;
      (async () => {
        try {
          await syncProfileSubCategoriesFromAppState(profiles);
          await repairPharmacyProfilesForListing(profiles);
        } catch (repairError) {
          console.error('pharmacy repair skipped:', repairError?.message || repairError);
        }
      })();
    }
  }

  const qualifiedProfiles = [];
  for (const profile of profiles) {
    const isOpen = profile.is_open !== false;
    if (!isOpen) continue;
    if (isMerchantFrozen(profile)) continue;
    if (!isMerchantApproved(profile)) continue;
    if (!merchantQualifiesForServiceListing(profile, normalizedServiceId)) {
      continue;
    }

    const phoneKey = String(profile.phone || '').trim();
    const profileRows = (() => {
      for (const variant of getPhoneVariants(phoneKey)) {
        const rows = serviceProfilesByPhone.get(variant);
        if (rows && rows.length > 0) return rows;
      }
      return serviceProfilesByPhone.get(phoneKey) || [];
    })();
    const listingProfile = resolveListingProfileFromRows(
      profile,
      normalizedServiceId,
      normalizedSubCategoryId,
      profileRows,
    );
    if (!listingProfile) continue;

    // تصفية حسب serviceSubCategory في الملف — لخدمات مثل الصحة/السياحة فقط.
    // قسم التسوق (product): الاعتماد على منتجات المتجر في القسم المطلوب،
    // لأن كثيراً من المتاجر لا تضبط service_sub_category على الملف.
    const useProfileSubCategoryGate =
      Boolean(normalizedSubCategoryId) &&
      normalizedServiceId !== 'product' &&
      channel !== 'product';
    if (useProfileSubCategoryGate) {
      if (!merchantMatchesSubCategoryFilter(listingProfile, normalizedSubCategoryId)) {
        continue;
      }
    }

    qualifiedProfiles.push(listingProfile);
  }

  if (isContactOnly) {
    return qualifiedProfiles.map((profile) => ({
      profile: serializeMerchantProfileForClient(
        withMerchantCustomerContacts(profile)
      ),
      products: [],
      productCount: 0,
      hasRestaurantProducts: false,
      compact: Boolean(compact),
    }));
  }

  const phoneVariants = [];
  for (const profile of qualifiedProfiles) {
    phoneVariants.push(...getPhoneVariants(profile.phone));
  }

  // مرحلة 1: أعمدة meta فقط لمعرفة من يظهر في القائمة (أقل Egress بكثير).
  const allMetaProducts = await loadMerchantProductsForPhones(phoneVariants, {
    metaOnly: true,
  });
  const metaByVariant = indexProductsByPhoneVariants(allMetaProducts);
  const listingChannel = channel || normalizedServiceId;
  // لا نمسح جدول الطلبات كاملاً عند كل فتح قائمة — يعتمد على times_ordered في المنتج
  // أو صفر؛ هذا يقلّل Egress بشكل كبير. عدّاد «الأكثر طلباً» يبقى متاحاً عند تحديث العمود.
  const qualifiedStores = [];

  for (const profile of qualifiedProfiles) {
    const products = collectProductsForPhone(metaByVariant, profile.phone);
    const filteredProducts = products.filter((row) =>
      productMatchesStoreListing({
        row,
        profile,
        productCategory,
        subCategoryId: normalizedSubCategoryId,
        marketplaceCategory: listingChannel,
      })
    );

    // المتجر بلا منتجات مطابقة للقسم، أو بلا منتجات إطلاقاً،
    // لا يظهر في القوائم — الحساب الفارغ يبقى مخفياً عن المستخدمين.
    if (filteredProducts.length === 0) continue;

    const hasRestaurantProducts = filteredProducts.some(
      (row) => resolveListingProductService(row, profile) === 'restaurant'
    );

    qualifiedStores.push({
      profile,
      filteredMeta: filteredProducts,
      hasRestaurantProducts,
    });
  }

  let fullByVariant = null;
  if (!compact && qualifiedStores.length > 0) {
    const qualifiedPhoneVariants = [];
    for (const entry of qualifiedStores) {
      qualifiedPhoneVariants.push(...getPhoneVariants(entry.profile.phone));
    }
    const fullProducts = await loadMerchantProductsForPhones(
      qualifiedPhoneVariants,
      { metaOnly: false }
    );
    fullByVariant = indexProductsByPhoneVariants(fullProducts);
  }

  const result = [];
  for (const entry of qualifiedStores) {
    const serializedProfile = serializeMerchantProfileForClient(
      withMerchantCustomerContacts(
        require('../lib/pos_departments').applyPosListingName(
          entry.profile,
          normalizedSubCategoryId,
        ),
      ),
    );

    if (compact) {
      result.push({
        profile: serializedProfile,
        products: [],
        productCount: entry.filteredMeta.length,
        hasRestaurantProducts: entry.hasRestaurantProducts,
        compact: true,
      });
      continue;
    }

    const fullRows = collectProductsForPhone(
      fullByVariant,
      entry.profile.phone
    ).filter((row) =>
      productMatchesStoreListing({
        row,
        profile: entry.profile,
        productCategory,
        subCategoryId: normalizedSubCategoryId,
        marketplaceCategory: listingChannel,
      })
    );

    for (const row of fullRows) {
      const n = Number(row.times_ordered ?? row.timesOrdered ?? 0) || 0;
      row.timesOrdered = n;
      row.times_ordered = n;
    }

    result.push({
      profile: serializedProfile,
      products: fullRows.map(serializeProductRowForClient),
      productCount: fullRows.length,
      hasRestaurantProducts: entry.hasRestaurantProducts,
      compact: false,
    });
  }

  return result;
}

/**
 * منتجات متجر واحد للزبون عند فتح القائمة — بديل عن تضمين الكتالوج في قائمة المتاجر.
 */
async function listStoreProductsForCustomer({
  merchantPhone,
  productCategory = '',
  subCategoryId = '',
  marketplaceCategory = '',
} = {}) {
  const phoneKey = String(merchantPhone || '').trim();
  if (!phoneKey) return [];

  const profile = await getMerchantProfile(phoneKey);
  if (!profile) return [];
  if (profile.is_open === false) return [];
  if (isMerchantFrozen(profile)) return [];
  if (!isMerchantApproved(profile)) return [];

  const rows = await loadMerchantProductsForPhones(getPhoneVariants(phoneKey), {
    metaOnly: false,
  });
  const listingChannel = String(marketplaceCategory || productCategory || '').trim();
  const category = String(productCategory || '').trim();

  return rows
    .filter((row) =>
      productMatchesStoreListing({
        row,
        profile,
        productCategory: category || listingChannel,
        subCategoryId: String(subCategoryId || '').trim(),
        marketplaceCategory: listingChannel || category,
      })
    )
    .map((row) => {
      const n = Number(row.times_ordered ?? row.timesOrdered ?? 0) || 0;
      row.timesOrdered = n;
      row.times_ordered = n;
      return serializeProductRowForClient(row);
    });
}

async function listShoppingStores(subCategoryId = '', { compact = false } = {}) {
  return listMerchantStoresByService({
    serviceId: 'product',
    productCategory: 'product',
    subCategoryId,
    marketplaceCategory: 'product',
    compact,
  });
}

async function listServiceStores(
  serviceId = '',
  productCategory = '',
  subCategoryId = '',
  marketplaceCategory = '',
  { compact = false } = {}
) {
  const normalizedService = String(serviceId || '').trim();
  const normalizedCategory = String(productCategory || normalizedService).trim();
  const normalizedSub = String(subCategoryId || '').trim();
  if (!normalizedService) return [];
  const fromMerchant = await listMerchantStoresByService({
    serviceId: normalizedService,
    productCategory: normalizedCategory,
    subCategoryId: normalizedSub,
    marketplaceCategory: String(marketplaceCategory || '').trim(),
    compact,
  });

  const wantsBeautyMerge =
    normalizedService === 'pharmacy' ||
    normalizedService === 'beauty' ||
    normalizedSub === 'صيدلية' ||
    normalizedSub === 'أطباء وعيادات' ||
    normalizedSub === 'مختبرات طبية' ||
    normalizedSub === 'صالون نسائي' ||
    normalizedSub === 'صالون رجالي';

  if (!wantsBeautyMerge) return fromMerchant;

  let fromCustomer = [];
  try {
    const { listCustomerBeautyStores } = require('./customer_pharmacies');
    const subForMerge =
      normalizedService === 'pharmacy' && !normalizedSub
        ? 'صيدلية'
        : normalizedSub;
    fromCustomer = await listCustomerBeautyStores({
      compact,
      subCategory: subForMerge,
    });
  } catch (error) {
    console.warn('listServiceStores beauty merge:', error?.message || error);
  }

  const map = new Map();
  for (const store of fromMerchant || []) {
    const phone = String(
      store.phone || store.merchantPhone || store.profile?.phone || '',
    ).trim();
    if (phone) map.set(phone, store);
  }
  for (const store of fromCustomer || []) {
    const phone = String(store.phone || store.profile?.phone || '').trim();
    if (!phone) continue;
    map.set(phone, { ...(map.get(phone) || {}), ...store });
  }
  return [...map.values()];
}

async function listOfferCatalogProducts() {
  const supabase = assertSupabaseAdmin();
  const usesPhone = await hasColumn('merchant_offers', 'phone');
  const usesMerchantUserId = await hasColumn('merchant_offers', 'merchant_user_id');
  const hasOfferDates =
    (await hasColumn('merchant_offers', 'start_date')) &&
    (await hasColumn('merchant_offers', 'end_date'));
  const selectColumns = usesPhone
    ? `phone, title_ar, discount_percent, product_names_ar, is_active${
        hasOfferDates ? ', start_date, end_date' : ''
      }`
    : `merchant_user_id, title_ar, discount_percent, product_names_ar, is_active${
        hasOfferDates ? ', start_date, end_date' : ''
      }`;

  const { data: offerRowsRaw, error } = await supabase
    .from('merchant_offers')
    .select(selectColumns)
    .eq('is_active', true)
    .limit(500);

  const today = new Date().toISOString().slice(0, 10);
  const offerRows = (offerRowsRaw || []).filter((row) => {
    if (!hasOfferDates) return true;
    const start = String(row.start_date || '').trim();
    const end = String(row.end_date || '').trim();
    if (start && start > today) return false;
    if (end && end < today) return false;
    return true;
  });

  const phoneByUserId = new Map();
  if (!usesPhone && usesMerchantUserId && Array.isArray(offerRows) && offerRows.length) {
    const userIds = [
      ...new Set(
        offerRows
          .map((row) => String(row.merchant_user_id || '').trim())
          .filter(Boolean)
      ),
    ];
    if (userIds.length) {
      const { data: users } = await supabase
        .from('app_users')
        .select('id, phone')
        .in('id', userIds);
      for (const user of users || []) {
        if (user?.id && user?.phone) {
          phoneByUserId.set(String(user.id), String(user.phone).trim());
        }
      }
    }
  }

  const offersByPhone = new Map();
  if (!error && Array.isArray(offerRows)) {
    for (const row of offerRows) {
      const phone = String(
        row.phone || phoneByUserId.get(String(row.merchant_user_id || '').trim()) || ''
      ).trim();
      if (!phone) continue;
      const list = offersByPhone.get(phone) || [];
      list.push({
        titleAr: row.title_ar || '',
        discountPercent: Number(row.discount_percent || 0),
        productNamesAr: normalizeArray(row.product_names_ar),
        isActive: row.is_active !== false,
        startDate: String(row.start_date || '').trim(),
        endDate: String(row.end_date || '').trim(),
      });
      offersByPhone.set(phone, list);
    }
  }

  if (offersByPhone.size === 0) {
    return enrichDirectOfferProducts(await listCatalogProducts('offers', ''));
  }

  const directOffers = enrichDirectOfferProducts(
    await listCatalogProducts('offers', ''),
  );
  const directIds = new Set(
    directOffers.map((row) => String(row.id || '').trim()).filter(Boolean),
  );

  const products = await listCatalogProducts('', '');
  const result = [...directOffers];

  for (const product of products) {
    const productId = String(product.id || '').trim();
    if (productId && directIds.has(productId)) continue;
    const phone = String(product.merchant_phone || product.phone || '').trim();
    const phoneVariants = getPhoneVariants(phone);
    let matchedOffers = [];
    for (const variant of phoneVariants) {
      if (offersByPhone.has(variant)) {
        matchedOffers = offersByPhone.get(variant);
        break;
      }
    }
    if (!matchedOffers.length) continue;

    const nameAr = String(product.name_ar || '').trim();
    let bestOffer = null;
    for (const offer of matchedOffers) {
      const names = Array.isArray(offer.productNamesAr)
        ? offer.productNamesAr
        : [];
      const matches =
        names.length === 0 ||
        names.some((name) => {
          const label = String(name || '').trim();
          return label && nameAr.includes(label);
        });
      if (!matches) continue;
      const discount = Number(offer.discountPercent || 0);
      if (
        !bestOffer ||
        discount > Number(bestOffer.discountPercent || 0)
      ) {
        bestOffer = offer;
      }
    }
    if (!bestOffer) continue;

    const price = Number(product.price || 0);
    const discount = Number(bestOffer.discountPercent || 0);
    const discountedPrice = Math.max(
      0,
      Math.round((price * (100 - discount)) / 100)
    );
    result.push({
      ...product,
      category: product.category || 'offers',
      offer_title_ar: bestOffer.titleAr || '',
      offer_discount_percent: discount,
      original_price: price,
      discounted_price: discountedPrice,
      offer_start_date: bestOffer.startDate || '',
      offer_end_date: bestOffer.endDate || '',
    });
  }

  return result.sort(
    (a, b) => Number(b.offer_discount_percent || 0) - Number(a.offer_discount_percent || 0)
  );
}

function enrichDirectOfferProducts(products) {
  return (products || []).map((product) => {
    const price = Number(product.price || 0);
    const until =
      product.available_until ||
      product.availableUntil ||
      product.offer_end_date ||
      '';
    const sub = String(product.sub_category || product.subCategory || '').trim();
    const titleFallback =
      sub === 'daily_deal' ? 'عرض يومي' : sub === 'discount' ? 'خصم' : '';
    return {
      ...product,
      category: product.category || 'offers',
      offer_title_ar:
        String(product.offer_title_ar || product.name_ar || titleFallback).trim(),
      offer_discount_percent: Number(product.offer_discount_percent || 0),
      original_price:
        product.original_price != null
          ? Number(product.original_price)
          : price,
      discounted_price:
        product.discounted_price != null
          ? Number(product.discounted_price)
          : price,
      offer_start_date: String(product.offer_start_date || '').trim(),
      offer_end_date: String(until || '').trim(),
    };
  });
}

const MARKETPLACE_CATEGORY_DEFS = [
  { id: 'restaurant', serviceId: 'restaurant', productCategory: 'restaurant' },
  { id: 'product', serviceId: 'product', productCategory: 'product' },
  { id: 'tourism', serviceId: 'tourism', productCategory: 'tourism' },
  { id: 'beauty', serviceId: 'beauty', productCategory: 'beauty' },
  { id: 'used', serviceId: 'used', productCategory: 'used' },
  { id: 'offers', serviceId: 'offers', productCategory: 'offers' },
  { id: 'cars', serviceId: 'cars', productCategory: 'cars' },
  { id: 'real_estate', serviceId: 'real_estate', productCategory: 'real_estate' },
  { id: 'global_shopping', serviceId: 'product', productCategory: 'product' },
];

async function getMarketplaceStats() {
  const profiles = await selectMany('merchant_profiles');
  const openProfiles = profiles.filter((row) => row.is_open !== false);
  const products = await selectMany(
    'merchant_products',
    [],
    { column: 'created_at', ascending: false }
  );
  const availableProducts = products.filter((row) => row.is_available !== false);
  const profileByPhone = buildProfileByPhoneMap(openProfiles);

  const storeCountByService = {};
  for (const def of MARKETPLACE_CATEGORY_DEFS) {
    const stores = await listMerchantStoresByService({
      serviceId: def.serviceId,
      productCategory: def.productCategory,
      subCategoryId: '',
      marketplaceCategory: def.id,
    });
    storeCountByService[def.id] = stores.length;
  }

  const categories = MARKETPLACE_CATEGORY_DEFS.map((def) => {
    const categoryProducts = availableProducts.filter((row) => {
      const phone = String(row.phone || '').trim();
      const profile = findProfileForPhone(profileByPhone, phone);
      if (!profile) return false;
      if (!merchantQualifiesForServiceListing(profile, def.serviceId)) {
        return false;
      }
      return productMatchesStoreListing({
        row,
        profile,
        productCategory: def.productCategory,
        subCategoryId: '',
        marketplaceCategory: def.id,
      });
    });

    const subCategoryCounts = {};
    for (const row of categoryProducts) {
      const subId = String(row.sub_category || '').trim() || '_all';
      subCategoryCounts[subId] = (subCategoryCounts[subId] || 0) + 1;
    }

    return {
      id: def.id,
      storeCount: storeCountByService[def.id] || 0,
      productCount: categoryProducts.length,
      subCategories: Object.entries(subCategoryCounts).map(([id, count]) => ({
        id: id === '_all' ? '' : id,
        productCount: count,
      })),
    };
  });

  const resolvedCategories = await Promise.all(
    categories.map(async (entry) => {
      const def = MARKETPLACE_CATEGORY_DEFS.find((item) => item.id === entry.id);
      const subCategories = await Promise.all(
        entry.subCategories.map(async (sub) => {
          if (!sub.id || !def) {
            return { ...sub, storeCount: entry.storeCount };
          }
          const stores = await listMerchantStoresByService({
            serviceId: def.serviceId,
            productCategory: def.productCategory,
            subCategoryId: sub.id,
            marketplaceCategory: def.id,
          });
          return {
            ...sub,
            storeCount: stores.length,
          };
        })
      );
      return {
        ...entry,
        subCategories,
        totalCount: Math.max(entry.storeCount, entry.productCount),
      };
    })
  );

  let offerCount = 0;
  try {
    const offers = await listOfferCatalogProducts();
    offerCount = offers.length;
  } catch (_) {
    offerCount = 0;
  }

  const professionals = await listProfessionalProfiles('');
  const realEstatePage = await listRealEstateListings('', '', '', {
    limit: 200,
    offset: 0,
  });
  const realEstate = Array.isArray(realEstatePage?.items)
    ? realEstatePage.items
    : Array.isArray(realEstatePage)
      ? realEstatePage
      : [];

  return {
    categories: [
      ...resolvedCategories.map((entry) => {
        if (entry.id === 'offers') {
          return {
            ...entry,
            productCount: offerCount,
            totalCount: offerCount,
          };
        }
        if (entry.id === 'real_estate') {
          return {
            ...entry,
            storeCount: realEstate.length,
            productCount: realEstate.length,
            totalCount: realEstate.length,
          };
        }
        return entry;
      }),
      {
        id: 'professionals',
        storeCount: professionals.length,
        productCount: professionals.length,
        totalCount: professionals.length,
        subCategories: [],
      },
    ],
    offerCount,
    professionalCount: professionals.length,
    realEstateCount: realEstate.length,
    updatedAt: nowIso(),
  };
}

async function listRestaurantStores(subCategoryId = '', { compact = false } = {}) {
  const fromMerchant = await listMerchantStoresByService({
    serviceId: 'restaurant',
    productCategory: 'restaurant',
    subCategoryId,
    marketplaceCategory: 'restaurant',
    compact,
  });

  let fromCustomer = [];
  try {
    const { listCustomerRestaurantStores } = require('./customer_restaurants');
    fromCustomer = await listCustomerRestaurantStores({ subCategoryId, compact });
  } catch (error) {
    console.warn('listRestaurantStores customer merge:', error?.message || error);
  }

  const map = new Map();
  for (const store of fromMerchant || []) {
    const phone = String(store.phone || store.merchantPhone || '').trim();
    if (phone) map.set(phone, store);
  }
  for (const store of fromCustomer || []) {
    const phone = String(store.phone || '').trim();
    if (!phone) continue;
    map.set(phone, { ...(map.get(phone) || {}), ...store });
  }
  return [...map.values()];
}

async function listCatalogProducts(category = '', subCategoryId = '') {
  const categoryFilter = String(category || '').trim();
  // LEGACY — bazaar channel removed; never browse as catalog.
  if (categoryFilter === 'bazar_ghaith') {
    return [];
  }
  const profiles = await selectManyColumnsWithFallback(
    'merchant_profiles',
    LISTING_PROFILE_SELECT,
    LISTING_PROFILE_SELECT_FALLBACK,
    [],
    { column: 'updated_at', ascending: false },
    1500
  );
  const openProfiles = profiles.filter(
    (row) => row.is_open !== false && !isMerchantFrozen(row)
  );
  const profileByPhone = buildProfileByPhoneMap(openProfiles);

  const target = String(subCategoryId || '').trim();
  // فلترة SQL حسب القسم (عند اختيار قسم محدد) — يقلّل تحميل المنتجات
  // من كل الجدول إلى قسم واحد فقط فيتسارع أول فتح للقسم الفرعي.
  const productsFilters =
    categoryFilter
      ? [{ method: 'eq', column: 'category', value: categoryFilter }]
      : [];
  const products = await selectManyColumnsWithFallback(
    'merchant_products',
    LISTING_PRODUCT_SELECT,
    LISTING_PRODUCT_SELECT_FALLBACK,
    productsFilters,
    { column: 'created_at', ascending: false },
    2000
  );

  // دمج إعلانات الزبون من الجدول الجديد (used/offers) دون فقدان الصفوف القديمة.
  let mergedProducts = products;
  try {
    const {
      listCustomerListingsByDomain,
      mergeListingRows,
      DOMAINS,
    } = require('./customer_listings');
    if (!categoryFilter || categoryFilter === 'used') {
      const usedRows = await listCustomerListingsByDomain(DOMAINS.used, {
        approvedOnly: false,
        limit: 2000,
      });
      mergedProducts = mergeListingRows(usedRows, mergedProducts);
    }
    if (!categoryFilter || categoryFilter === 'offers') {
      const offerRows = await listCustomerListingsByDomain(DOMAINS.offers, {
        approvedOnly: false,
        limit: 2000,
      });
      mergedProducts = mergeListingRows(offerRows, mergedProducts);
    }
  } catch (error) {
    console.warn('listCatalogProducts customer_listings merge:', error?.message || error);
  }

  const {
    isEdenPrintingCategory,
    isEdenPrintingOwnerPhone,
    getEdenPrintingStoreNameForPhone,
  } = require('../lib/eden_printing');

  const nowMs = Date.now();
  return mergedProducts
    .filter((row) => {
      if (row.is_available === false) return false;
  if (
    row.stock_quantity !== null &&
    row.stock_quantity !== undefined &&
    Number(row.stock_quantity) <= 0
  ) {
    return false;
  }
      const untilRaw = row.available_until ?? row.availableUntil;
      if (untilRaw) {
        const untilMs = new Date(untilRaw).getTime();
        if (!Number.isNaN(untilMs) && untilMs <= nowMs) return false;
      }
      if (!isProductApproved(row)) return false;
      const productService = String(
        row.category || row.service_id || ''
      ).trim();
      if (
        categoryFilter &&
        productService !== categoryFilter
      ) {
        return false;
      }
      const phone = String(row.phone || '').trim();

      // مطبعة جنة عدن / طلب: نماذج المطابع فقط ضمن كتالوج المطابع — لا في تسوق/زهور.
      if (
        isEdenPrintingCategory(productService) &&
        isEdenPrintingOwnerPhone(phone)
      ) {
        return !categoryFilter || categoryFilter === 'eden_printing';
      }

      const profile = findProfileForPhone(profileByPhone, phone);
      const listingMode = String(row.listing_mode || row.listingMode || '').trim();
      const isCustomerOffer =
        productService === 'offers' && listingMode === 'customer_offer';
      const isCustomerUsed =
        productService === 'used' && listingMode === 'customer_used';
      const isCustomerCar =
        productService === 'cars' &&
        (listingMode === 'customer_car' || listingMode === 'customer_car_request');

      if (isCustomerOffer || isCustomerUsed || isCustomerCar) {
        // إعلانات الزبون: لا تتطلب ملف تاجر؛ تظهر بعد الموافقة فقط (أعلاه).
        if (target) {
          if (isCustomerCar) {
            if (!shoppingSubCategoryMatches(row.sub_category, target)) {
              return false;
            }
          } else if (String(row.sub_category || '').trim() !== target) {
            return false;
          }
        }
        return true;
      }

      if (!profile) return false;
      if (!isMerchantApproved(profile)) return false;

      if (
        productService &&
        !isMerchantServiceEnabled(profile, productService)
      ) {
        return false;
      }

      if (categoryFilter === 'bazar_ghaith') {
        return false;
      }

      const serviceIds = profileServiceIds(profile);
      if (
        categoryFilter === 'product' &&
        !serviceIds.includes('product') &&
        productService !== 'product'
      ) {
        return false;
      }
      if (
        categoryFilter === 'restaurant' &&
        !serviceIds.includes('restaurant') &&
        productService !== 'restaurant'
      ) {
        return false;
      }
      if (
        ['tourism', 'beauty', 'used', 'offers', 'cars', 'eden_printing'].includes(categoryFilter) &&
        !serviceIds.includes(categoryFilter) &&
        productService !== categoryFilter
      ) {
        return false;
      }
      if (target) {
        if (categoryFilter === 'offers' || productService === 'offers') {
          if (String(row.sub_category || '').trim() !== target) return false;
        } else if (!shoppingSubCategoryMatches(row.sub_category, target)) {
          return false;
        }
      }
      return true;
    })
    .map((row) => {
      const phone = String(row.phone || '').trim();
      const profile = findProfileForPhone(profileByPhone, phone);
      const profileContacts = withMerchantCustomerContacts(profile || {});
      const productService = String(row.category || row.service_id || '').trim();
      const edenOwner =
        isEdenPrintingCategory(productService) && isEdenPrintingOwnerPhone(phone);
      const listingMode = String(row.listing_mode || row.listingMode || '').trim();
      const isCustomerOffer =
        productService === 'offers' && listingMode === 'customer_offer';
      const isCustomerUsed =
        productService === 'used' && listingMode === 'customer_used';
      const isCustomerCar =
        productService === 'cars' &&
        (listingMode === 'customer_car' || listingMode === 'customer_car_request');
      const isCustomerListing =
        isCustomerOffer || isCustomerUsed || isCustomerCar;
      const contactPhone = isCustomerListing
        ? String(row.action_label_en || '').trim() || phone
        : phone;
      const publisherLabel = isCustomerListing
        ? String(row.action_label_ar || '').trim() ||
          (isCustomerCar
            ? listingMode === 'customer_car_request'
              ? 'طلب سيارة أجرة'
              : 'بيع سيارة'
            : isCustomerUsed
              ? 'مستعمل'
              : 'عرض')
        : '';
      return serializeProductRowForClient({
        ...row,
        merchant_phone: contactPhone,
        merchant_whatsapp: isCustomerListing
          ? contactPhone
          : profileContacts.customer_whatsapp ?? (edenOwner ? phone : ''),
        merchant_customer_phone: isCustomerListing
          ? contactPhone
          : profileContacts.customer_phone ?? '',
        merchant_customer_whatsapp: isCustomerListing
          ? contactPhone
          : profileContacts.customer_whatsapp ?? '',
        merchant_show_phone_to_customers: isCustomerListing
          ? true
          : profileContacts.show_phone_to_customers ?? true,
        merchant_show_whatsapp_to_customers: isCustomerListing
          ? true
          : profileContacts.show_whatsapp_to_customers ?? true,
        merchant_store_name: isCustomerListing
          ? publisherLabel
          : profile?.store_name ??
            (edenOwner ? getEdenPrintingStoreNameForPhone(phone) : ''),
        merchant_address: profile?.address ?? '',
        merchant_latitude:
          profile?.latitude ?? profile?.lat ?? null,
        merchant_longitude:
          profile?.longitude ?? profile?.lng ?? null,
        merchant_open_time: profile?.open_time ?? null,
        merchant_close_time: profile?.close_time ?? null,
        merchant_is_open:
          profile?.is_open === undefined ? true : Boolean(profile?.is_open),
        merchant_is_frozen: profile?.is_frozen === true,
        merchant_rate_per_km: profile?.rate_per_km ?? null,
      });
    });
}

async function listRealEstateListings(
  subCategoryId = '',
  listingMode = '',
  neighborhood = '',
  options = {},
) {
  const target = String(subCategoryId || '').trim();
  const modeFilter = String(listingMode || '').trim();
  const neighborhoodFilter = String(neighborhood || '').trim().toLowerCase();
  const pageSize = Math.min(
    Math.max(Number.parseInt(String(options.limit ?? 10), 10) || 10, 1),
    40,
  );
  const pageOffset = Math.max(
    Number.parseInt(String(options.offset ?? 0), 10) || 0,
    0,
  );

  const filters = [{ method: 'eq', column: 'category', value: 'real_estate' }];
  if (target) {
    filters.push({ method: 'eq', column: 'sub_category', value: target });
  }
  if (modeFilter) {
    filters.push({ method: 'eq', column: 'listing_mode', value: modeFilter });
  }

  // نجلب نوافذ حتى نملأ الصفحة بعد فلتر الموافقة/الحي.
  const collected = [];
  let dbOffset = 0;
  let exhausted = false;
  const chunkSize = Math.max(pageSize * 2, 40);
  const maxScan = pageOffset + pageSize + chunkSize;

  // ابدأ بصفوف الجدول الجديد ثم أكمل من الأرشيف القديم.
  try {
    const {
      listCustomerListingsByDomain,
      DOMAINS,
    } = require('./customer_listings');
    const listingFilters = {
      approvedOnly: false,
      limit: maxScan,
      offset: 0,
    };
    if (target) listingFilters.subCategory = target;
    if (modeFilter) listingFilters.listingMode = modeFilter;
    const fromNew = await listCustomerListingsByDomain(
      DOMAINS.real_estate,
      listingFilters,
    );
    for (const row of fromNew) {
      if (row.is_available === false) continue;
      if (
        row.stock_quantity !== null &&
        row.stock_quantity !== undefined &&
        Number(row.stock_quantity) <= 0
      ) {
        continue;
      }
      if (!isProductApproved(row)) continue;
      if (neighborhoodFilter) {
        const rowNeighborhood = String(row.neighborhood || '')
          .trim()
          .toLowerCase();
        if (!rowNeighborhood.includes(neighborhoodFilter)) continue;
      }
      collected.push(row);
    }
  } catch (error) {
    console.warn('listRealEstateListings customer_listings:', error?.message || error);
  }

  const seenIds = new Set(collected.map((row) => String(row.id)));

  while (collected.length < pageOffset + pageSize + 1 && dbOffset < maxScan) {
    const products = await selectMany(
      'merchant_products',
      filters,
      { column: 'created_at', ascending: false },
      chunkSize,
      dbOffset,
    );
    if (!products.length) {
      exhausted = true;
      break;
    }
    dbOffset += products.length;
    if (products.length < chunkSize) exhausted = true;

    for (const row of products) {
      if (seenIds.has(String(row.id))) continue;
      if (row.is_available === false) continue;
      if (
        row.stock_quantity !== null &&
        row.stock_quantity !== undefined &&
        Number(row.stock_quantity) <= 0
      ) {
        continue;
      }
      if (!isProductApproved(row)) continue;
      if (neighborhoodFilter) {
        const rowNeighborhood = String(row.neighborhood || '')
          .trim()
          .toLowerCase();
        if (!rowNeighborhood.includes(neighborhoodFilter)) continue;
      }
      seenIds.add(String(row.id));
      collected.push(row);
      if (collected.length >= pageOffset + pageSize + 1) break;
    }
    if (exhausted) break;
  }

  const pageRows = collected.slice(pageOffset, pageOffset + pageSize);
  const hasMore =
    collected.length > pageOffset + pageSize ||
    (!exhausted && collected.length >= pageOffset + pageSize);

  const profilesByPhone = new Map();
  const phones = [
    ...new Set(
      pageRows.map((product) => String(product.phone || '').trim()).filter(Boolean),
    ),
  ];
  if (phones.length) {
    const profileRows = await selectMany('merchant_profiles', [
      { method: 'in', column: 'phone', value: phones },
    ]);
    for (const profile of profileRows || []) {
      profilesByPhone.set(String(profile.phone || '').trim(), profile);
    }
  }

  const items = pageRows.map((product) => {
    const phone = String(product.phone || '').trim();
    const merchantRow = profilesByPhone.get(phone) || null;
    const productForClient = { ...product };
    if (Array.isArray(productForClient.gallery_images_base64)) {
      const gallery = productForClient.gallery_images_base64
        .map((entry) => String(entry || '').trim())
        .filter((entry) => entry.length > 0);
      productForClient.gallery_images_base64 = gallery.slice(0, 1);
    }
    if (
      !String(productForClient.image_base64 || '').trim() &&
      Array.isArray(productForClient.gallery_images_base64) &&
      productForClient.gallery_images_base64.length > 0
    ) {
      productForClient.image_base64 = productForClient.gallery_images_base64[0];
    }

    const contactPhone =
      String(product.action_label_en || '').trim() || phone;
    const publisherName =
      String(product.action_label_ar || '').trim() ||
      (merchantRow ? merchantProfileDisplayName(merchantRow) : '') ||
      'عقارات';

    const merchantActive =
      merchantRow &&
      merchantRow.is_open !== false &&
      !isMerchantFrozen(merchantRow) &&
      isMerchantApproved(merchantRow) &&
      isMerchantServiceEnabled(merchantRow, 'real_estate');

    const merchant = merchantActive
      ? withMerchantCustomerContacts(merchantRow)
      : {
          phone: contactPhone,
          store_name: publisherName,
          storeName: publisherName,
          is_open: true,
          customer_phone: contactPhone,
          customerPhone: contactPhone,
        };

    return {
      product: {
        ...productForClient,
        merchant_phone: contactPhone,
      },
      merchant,
    };
  });

  return {
    items,
    hasMore,
    offset: pageOffset,
    limit: pageSize,
  };
}

function merchantProfilePayloadFromAppState(state, appUser) {
  const merchantStore = normalizeObject(state?.merchantStore);
  const storeName =
    String(merchantStore.name ?? merchantStore.store_name ?? '').trim() ||
    String(appUser?.full_name ?? '').trim();
  if (!storeName) return null;

  const serviceIds = normalizeArray(
    merchantStore.serviceIds ?? merchantStore.service_ids
  );
  const category =
    String(
      merchantStore.category ??
        merchantStore.activeServiceId ??
        merchantStore.active_service_id ??
        merchantStore.primary_service_id ??
        merchantStore.primaryServiceId ??
        ''
    ).trim() || (serviceIds[0] || 'product');

  const requiresAccountApproval = merchantAccountRequiresApproval({
    primary_service_id: category,
    service_ids: serviceIds.length > 0 ? serviceIds : [category],
    professional_category_id:
      merchantStore.professionalCategoryId ??
      merchantStore.professional_category_id,
    professional_info:
      merchantStore.professionalInfo ?? merchantStore.professional_info,
  });

  return {
    store_name: storeName,
    description: merchantStore.description,
    primary_service_id: category,
    service_ids: serviceIds.length > 0 ? serviceIds : [category],
    active_service_id:
      merchantStore.activeServiceId ?? merchantStore.active_service_id ?? category,
    whatsapp: merchantStore.whatsapp,
    address: merchantStore.address,
    latitude: merchantStore.latitude ?? merchantStore.lat,
    longitude: merchantStore.longitude ?? merchantStore.lng,
    open_time: merchantStore.openTime ?? merchantStore.open_time,
    close_time: merchantStore.closeTime ?? merchantStore.close_time,
    delivery_fee: merchantStore.deliveryFee ?? merchantStore.delivery_fee,
    rate_per_km: merchantStore.ratePerKm ?? merchantStore.rate_per_km,
    delivery_areas: merchantStore.deliveryAreas ?? merchantStore.delivery_areas,
    is_open: merchantStore.isOpen ?? merchantStore.is_open ?? true,
    service_enabled: normalizeObject(
      merchantStore.service_enabled ?? merchantStore.serviceEnabled ?? {}
    ),
    restaurant_category:
      merchantStore.restaurantCategory ?? merchantStore.restaurant_category,
    service_sub_category:
      merchantStore.serviceSubCategory ??
      merchantStore.service_sub_category ??
      merchantStore.subCategoryId ??
      merchantStore.sub_category_id,
    professional_category_id:
      merchantStore.professionalCategoryId ??
      merchantStore.professional_category_id,
    professional_info:
      merchantStore.professionalInfo ?? merchantStore.professional_info,
    profile_image_base64:
      merchantStore.profileImageBase64 ?? merchantStore.profile_image_base64,
    cover_image_url:
      merchantStore.coverImageBase64 ??
      merchantStore.coverImage ??
      merchantStore.cover_image_url,
    logo_image_url:
      merchantStore.logoImageBase64 ??
      merchantStore.logoImage ??
      merchantStore.logo_image_url,
    work_sample_images_base64:
      merchantStore.workSampleImagesBase64 ??
      merchantStore.work_sample_images_base64,
    product_sections:
      merchantStore.productSections ?? merchantStore.product_sections,
    is_approved: requiresAccountApproval ? false : true,
    approval_status: requiresAccountApproval ? 'pending' : 'approved',
  };
}

function resolveStateForPhone(stateByPhone, phone) {
  for (const variant of getPhoneVariants(phone)) {
    const state = stateByPhone[variant];
    if (state && typeof state === 'object') return state;
  }
  return {};
}

async function ensureMerchantProfileRecord(phone, options = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  let profile = await getMerchantProfile(phoneKey);
  if (profile) return profile;

  const appUser = await getAppUser(phoneKey);
  const state = (await getUserState(phoneKey)) || {};
  const payload = merchantProfilePayloadFromAppState(state, appUser);
  const storeName =
    payload?.store_name ||
    String(appUser?.full_name ?? '').trim() ||
    `تاجر ${phoneKey.slice(-4)}`;

  profile = await saveMerchantProfile(phoneKey, {
    ...(payload || {}),
    store_name: storeName,
    primary_service_id: payload?.primary_service_id || 'product',
    ...options,
  });

  if (!profile) {
    throw new Error('Merchant profile not found.');
  }
  return profile;
}

function hasMerchantDataInState(state) {
  const normalized = normalizeObject(state);
  if (normalized.merchantProfileComplete === true) return true;
  const store = normalizeObject(normalized.merchantStore);
  if (!store || Object.keys(store).length === 0) return false;
  const storeName = String(store.name ?? store.store_name ?? '').trim();
  return storeName.length > 0;
}

async function merchantProfileExistsForPhone(phone, existingPhones) {
  const phoneKey = String(phone || '').trim();
  if (!phoneKey) return true;
  if (getPhoneVariants(phoneKey).some((variant) => existingPhones.has(variant))) {
    return true;
  }
  const profile = await getMerchantProfile(phoneKey);
  return Boolean(profile);
}

async function createMerchantProfileIfMissing(phone, state, appUser, existingPhones) {
  const phoneKey = String(phone || '').trim();
  if (!phoneKey) return false;
  if (await merchantProfileExistsForPhone(phoneKey, existingPhones)) {
    return false;
  }

  const payload = merchantProfilePayloadFromAppState(state, appUser);
  const role = String(appUser?.role ?? '').trim();
  const isMerchantIntent =
    role === 'merchant' || payload !== null || hasMerchantDataInState(state);
  if (!isMerchantIntent) return false;

  const toSave =
    payload ||
    ({
      store_name:
        String(appUser?.full_name ?? '').trim() || `تاجر ${phoneKey.slice(-4)}`,
      primary_service_id: 'product',
      is_approved: true,
      approval_status: 'approved',
    });

  if (!String(toSave.store_name ?? '').trim()) return false;

  await saveMerchantProfile(phoneKey, toSave);
  for (const variant of getPhoneVariants(phoneKey)) {
    existingPhones.add(variant);
  }
  return true;
}

async function syncMissingMerchantProfilesFromAppState() {
  return true; // Disabled inline sync for dashboard performance
  const [users, states, existingMerchants] = await Promise.all([
    selectMany('app_users', [], { column: 'updated_at', ascending: false }, 3000),
    selectManyColumns(
      'app_state',
      'phone, state',
      [],
      { column: 'updated_at', ascending: false },
      2500
    ),
    selectMany('merchant_profiles', [], { column: 'phone', ascending: true }, 2000),
  ]);

  const existingPhones = new Set();
  for (const row of existingMerchants) {
    for (const variant of getPhoneVariants(row.phone)) {
      existingPhones.add(variant);
    }
  }

  const stateByPhone = {};
  for (const row of states) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    for (const variant of getPhoneVariants(phone)) {
      stateByPhone[variant] = row.state || {};
    }
  }

  let synced = 0;

  for (const user of users) {
    const phone = String(user.phone || '').trim();
    if (!phone) continue;
    const state = resolveStateForPhone(stateByPhone, phone);
    const created = await createMerchantProfileIfMissing(
      phone,
      state,
      user,
      existingPhones
    );
    if (created) synced += 1;
  }

  // تغطية حالات app_state التي لا يوجد لها صف مطابق في app_users
  const scannedStatePhones = new Set();
  for (const row of states) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    let alreadyScanned = false;
    for (const variant of getPhoneVariants(phone)) {
      if (scannedStatePhones.has(variant)) {
        alreadyScanned = true;
        break;
      }
    }
    if (alreadyScanned) continue;
    for (const variant of getPhoneVariants(phone)) {
      scannedStatePhones.add(variant);
    }

    const state = row.state || {};
    if (!hasMerchantDataInState(state)) continue;

    const appUser = await getAppUser(phone).catch(() => null);
    const created = await createMerchantProfileIfMissing(
      phone,
      state,
      appUser,
      existingPhones
    );
    if (created) synced += 1;
  }

  if (synced > 0) {
    console.log(`syncMissingMerchantProfiles: created ${synced} merchant profile(s).`);
  }
  return synced;
}

/**
 * Decrement product stock when a merchant accepts an order.
 * When stock hits 0, marks the product unavailable so it disappears from the store.
 */
async function decrementStockForAcceptedOrder(orderPayload = {}) {
  if (!(await hasColumn('merchant_products', 'stock_quantity'))) {
    return { skipped: true, reason: 'no_stock_column' };
  }
  if (orderPayload.stockDecremented === true) {
    return { skipped: true, reason: 'already_decremented' };
  }

  const lines = Array.isArray(orderPayload.lineItems)
    ? orderPayload.lineItems
    : Array.isArray(orderPayload.items)
      ? orderPayload.items
      : [];

  const updates = [];
  for (const line of lines) {
    if (!line || line.isAvailable === false) continue;
    const productId = String(
      line.productId ?? line.product_id ?? line.id ?? '',
    ).trim();
    if (!productId) continue;
    const qty = Math.max(
      1,
      Number.parseInt(String(line.quantity ?? line.count ?? 1), 10) || 1,
    );

    const row = await selectSingle('merchant_products', 'id', productId);
    if (!row) continue;
    if (row.stock_quantity === null || row.stock_quantity === undefined) {
      continue; // unlimited / not tracked
    }

    const current = Math.max(0, Number.parseInt(String(row.stock_quantity), 10) || 0);
    const next = Math.max(0, current - qty);
    const patch = {
      id: productId,
      stock_quantity: next,
      updated_at: nowIso(),
    };
    if (next <= 0) {
      patch.is_available = false;
    }
    await saveRow('merchant_products', patch, 'id');
    updates.push({ productId, from: current, to: next, qty });
  }

  return { skipped: false, updates };
}

/**
 * Decrement stock for a POS (walk-in) sale from the cashier app.
 */
async function decrementStockForPosSale(items = []) {
  if (!(await hasColumn('merchant_products', 'stock_quantity'))) {
    return { skipped: true, reason: 'no_stock_column', updates: [] };
  }
  const updates = [];
  for (const line of items || []) {
    const productId = String(line.productId || line.product_id || line.id || '').trim();
    if (!productId) continue;
    const qty = Math.max(1, Number.parseInt(String(line.quantity ?? line.qty ?? 1), 10) || 1);
    const row = await selectSingle('merchant_products', 'id', productId);
    if (!row) continue;
    if (row.stock_quantity === null || row.stock_quantity === undefined) continue;
    const current = Math.max(0, Number.parseInt(String(row.stock_quantity), 10) || 0);
    const next = Math.max(0, current - qty);
    const patch = {
      id: productId,
      stock_quantity: next,
      updated_at: nowIso(),
    };
    if (next <= 0) patch.is_available = false;
    await saveRow('merchant_products', patch, 'id');
    updates.push({ productId, from: current, to: next, qty });
  }
  return { skipped: false, updates };
}

/**
 * يحسب عدد مرات طلب كل منتج من طلبات العملاء المكتملة (customer_orders).
 * يُستخدم لقسم «الأكثر طلباً» — الترتيب يعتمد على طلبات حقيقية.
 * يعيد خريطة { productId: count }.
 *
 * كاش ذكي في الذاكرة (90 ثانية): الحساب كان يُنفَّذ عند كل فتح لقائمة
 * المطاعم فيجلب كل الطلبات — أصبح يُحسب مرة واحدة لكل 90 ثانية،
 * ويُبطَل فوراً عند إنشاء/قبول طلب جديد عبر invalidateProductOrderCountsCache.
 */
let productOrderCountsCache = { at: 0, data: null };
const PRODUCT_ORDER_COUNTS_TTL_MS = 90 * 1000;

async function buildProductOrderCounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && productOrderCountsCache.data && now - productOrderCountsCache.at < PRODUCT_ORDER_COUNTS_TTL_MS) {
    return productOrderCountsCache.data;
  }

  const supabase = assertSupabaseAdmin();
  const orderColumn = await hasColumn('customer_orders', 'order_payload');
  const statusColumn = await hasColumn('customer_orders', 'status_key');
  if (!orderColumn) return new Map();

  let rows = [];
  const pageSize = 1000;
  const pageColumns = ['id'];
  if (statusColumn) pageColumns.push('status_key');
  pageColumns.push('order_payload');

  let from = 0;
  // نجلب كل الطلبات غير الملغاة/غير المعاد منها، بشرائح متتالية.
  // عند تباطؤ/مهلة جدول الطلبات لا نُسقط قائمة المطاعم — نعيد الكاش القديم
  // (إن وُجد) أو خريطة فارغة؛ القسم يستمر بالعمل.
  for (;;) {
    const { data, error } = await supabase
      .from('customer_orders')
      .select(pageColumns.join(','))
      .range(from, from + pageSize - 1)
      .limit(pageSize);
    if (error) {
      console.warn('buildProductOrderCounts fetch error:', error?.message || error);
      if (productOrderCountsCache.data) return productOrderCountsCache.data;
      return new Map();
    }
    rows = rows.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  const counts = new Map();
  const ignoreStatuses = new Set(['cancelled', 'canceled', 'refunded']);
  for (const row of rows) {
    if (statusColumn) {
      const status = String(row.status_key || row.status || '').trim().toLowerCase();
      if (ignoreStatuses.has(status)) continue;
    }
    const payload = normalizeObject(row.order_payload);
    const items = Array.isArray(payload.lineItems)
      ? payload.lineItems
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const productId = String(
        item.productId || item.product_id || item.id || ''
      ).trim();
      if (!productId) continue;
      const qty = Math.max(1, Number.parseInt(String(item.quantity ?? item.qty ?? 1), 10) || 1);
      counts.set(productId, (counts.get(productId) || 0) + qty);
    }
  }

  productOrderCountsCache = { at: Date.now(), data: counts };
  return counts;
}

/** يُستدعى بعد إنشاء/قبول/تحديث طلب حتى يعكس «الأكثر طلباً» فوراً. */
function invalidateProductOrderCountsCache() {
  productOrderCountsCache = { at: 0, data: null };
}

module.exports = {
  resolveMerchantContactVisibility,
  withMerchantCustomerContacts,
  profileServiceIds,
  isMerchantFrozen,
  isProfessionalMerchantProfile,
  merchantProfileDisplayName,
  isMerchantApproved,
  merchantApprovalStatus,
  isProductApproved,
  productApprovalStatus,
  isAdminPreRegisteredMerchant,
  merchantRejectionMessage,
  MERCHANT_REJECTION_REASONS,
  merchantAccountRequiresApproval,
  mapMerchantApprovalFields,
  syncMerchantApprovalToState,
  updateMerchantApprovalRecord,
  profileHasService,
  resolveProfileSubCategory,
  merchantMatchesSubCategoryFilter,
  productMatchesStoreListing,
  chunkValues,
  indexProductsByPhoneVariants,
  collectProductsForPhone,
  buildProfileByPhoneMap,
  canMerchantPublishInBazaar,
  merchantQualifiesForServiceListing,
  isBazaarEligibleProductCategory,
  resolveListingProductService,
  evaluateBazaarCustomerVisibility,
  mapStateItemToProductPayload,
  findProfileForPhone,
  merchantProfileSections,
  getMerchantProfile,
  getMerchantProfileForClient,
  saveMerchantProfile,
  deleteMerchantProfile,
  enrichProfessionalProfileRow,
  getMerchantProducts,
  saveMerchantProduct,
  deleteMerchantProduct,
  decrementStockForAcceptedOrder,
  decrementStockForPosSale,
  buildProductOrderCounts,
  invalidateProductOrderCountsCache,
  listProfessionalProfiles,
  listMerchantStoresByService,
  listStoreProductsForCustomer,
  parseCompactFlag,
  listShoppingStores,
  listServiceStores,
  listOfferCatalogProducts,
  getMarketplaceStats,
  listRestaurantStores,
  listCatalogProducts,
  listRealEstateListings,
  GLOBAL_SHOPPING_SUB_CATEGORY_IDS,
  MARKETPLACE_CATEGORY_DEFS,
  syncMerchantProductsForBazaar,
  merchantProfilePayloadFromAppState,
  ensureMerchantProfileRecord,
  syncMissingMerchantProfilesFromAppState,
  syncProfileSubCategoriesFromAppState,
};
