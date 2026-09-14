/**
 * إعلانات الزبون المستقلة (عقارات / مستعمل / عروض).
 * الكتابة الأساسية إلى customer_listings مع مرآة اختيارية إلى merchant_products
 * أثناء فترة الانتقال — بدون حذف من الجداول القديمة.
 */

const {
  nowIso,
  phonesOverlap,
  resolvePhoneKey,
  getPhoneVariants,
  selectSingle,
  selectMany,
  hasColumn,
  saveRow,
  updateRow,
  assertSupabaseAdmin,
} = require('./common');

const DOMAINS = Object.freeze({
  real_estate: 'real_estate',
  used: 'used',
  offers: 'offers',
});

const MIRROR_TO_MERCHANT_PRODUCTS =
  String(process.env.CUSTOMER_LISTINGS_MIRROR_MERCHANT || '1').trim() !== '0';

function domainFromCategory(category, listingMode) {
  const cat = String(category || '').trim();
  const mode = String(listingMode || '').trim();
  if (cat === 'real_estate') return DOMAINS.real_estate;
  if (cat === 'used' && mode === 'customer_used') return DOMAINS.used;
  if (cat === 'offers' && mode === 'customer_offer') return DOMAINS.offers;
  return null;
}

function isCustomerListingDomainRow(row) {
  if (!row) return false;
  return Boolean(domainFromCategory(row.category || row.service_id, row.listing_mode || row.listingMode));
}

function toListingRow(payload, { domain, ownerPhone, legacyId = null } = {}) {
  const now = nowIso();
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('listing id is required');
  const category = String(payload.category || domain || '').trim();
  const listingMode = payload.listing_mode ?? payload.listingMode ?? null;
  const resolvedDomain =
    domain || domainFromCategory(category, listingMode) || category;

  return {
    id,
    domain: resolvedDomain,
    owner_phone: String(ownerPhone || payload.phone || payload.owner_phone || '').trim(),
    category,
    service_id: payload.service_id ?? payload.serviceId ?? category,
    sub_category: payload.sub_category ?? payload.subCategory ?? null,
    listing_mode: listingMode,
    name_ar: payload.name_ar ?? payload.nameAr ?? null,
    name_en: payload.name_en ?? payload.nameEn ?? null,
    description_ar: payload.description_ar ?? payload.descriptionAr ?? null,
    description_en: payload.description_en ?? payload.descriptionEn ?? null,
    price: payload.price ?? 0,
    is_available: payload.is_available !== false && payload.isAvailable !== false,
    stock_quantity: payload.stock_quantity ?? payload.stockQuantity ?? null,
    image: payload.image ?? null,
    image_url: payload.image_url ?? payload.imageUrl ?? null,
    image_base64: payload.image_base64 ?? payload.imageBase64 ?? null,
    gallery_images_base64:
      payload.gallery_images_base64 ?? payload.galleryImagesBase64 ?? null,
    video_url: payload.video_url ?? payload.videoUrl ?? null,
    action_label_en: payload.action_label_en ?? payload.actionLabelEn ?? null,
    action_label_ar: payload.action_label_ar ?? payload.actionLabelAr ?? null,
    neighborhood: payload.neighborhood ?? null,
    facade: payload.facade ?? null,
    floor_count: payload.floor_count ?? payload.floorCount ?? null,
    area_square_meter:
      payload.area_square_meter ?? payload.areaSquareMeter ?? null,
    prep_minutes: payload.prep_minutes ?? payload.prepMinutes ?? null,
    available_until: payload.available_until ?? payload.availableUntil ?? null,
    is_approved: Boolean(payload.is_approved ?? payload.isApproved ?? false),
    approval_status:
      String(payload.approval_status ?? payload.approvalStatus ?? 'pending').trim() ||
      'pending',
    rejection_message_ar:
      payload.rejection_message_ar ?? payload.rejectionMessageAr ?? null,
    rejected_at: payload.rejected_at ?? payload.rejectedAt ?? null,
    merchant_user_id: payload.merchant_user_id ?? payload.merchantUserId ?? null,
    legacy_id: legacyId || payload.legacy_id || id,
    migrated_from: payload.migrated_from || 'merchant_products',
    created_at: payload.created_at || payload.createdAt || now,
    updated_at: now,
  };
}

function listingToProductShape(row) {
  if (!row) return null;
  return {
    ...row,
    phone: row.owner_phone || row.phone,
    service_id: row.service_id || row.category,
  };
}

async function getCustomerListingById(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  try {
    return await selectSingle('customer_listings', 'id', key);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return null;
    }
    throw error;
  }
}

async function upsertCustomerListing(payload, meta = {}) {
  const row = toListingRow(payload, meta);
  if (!row.owner_phone) throw new Error('owner_phone is required');
  try {
    const saved = await saveRow('customer_listings', row, 'id');
    return saved || row;
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      console.warn(
        'customer_listings table missing — run supabase/20260902_customer_publish_decoupling.sql',
      );
      return null;
    }
    throw error;
  }
}

async function mirrorListingToMerchantProducts(listingRow) {
  if (!MIRROR_TO_MERCHANT_PRODUCTS || !listingRow) return null;
  const product = {
    id: listingRow.id,
    phone: listingRow.owner_phone,
    category: listingRow.category,
    service_id: listingRow.service_id || listingRow.category,
    sub_category: listingRow.sub_category,
    listing_mode: listingRow.listing_mode,
    name_ar: listingRow.name_ar,
    name_en: listingRow.name_en,
    description_ar: listingRow.description_ar,
    description_en: listingRow.description_en,
    price: listingRow.price,
    is_available: listingRow.is_available,
    stock_quantity: listingRow.stock_quantity,
    image: listingRow.image,
    image_url: listingRow.image_url,
    image_base64: listingRow.image_base64,
    gallery_images_base64: listingRow.gallery_images_base64,
    video_url: listingRow.video_url,
    action_label_en: listingRow.action_label_en,
    action_label_ar: listingRow.action_label_ar,
    neighborhood: listingRow.neighborhood,
    facade: listingRow.facade,
    floor_count: listingRow.floor_count,
    area_square_meter: listingRow.area_square_meter,
    prep_minutes: listingRow.prep_minutes,
    available_until: listingRow.available_until,
    is_approved: listingRow.is_approved,
    approval_status: listingRow.approval_status,
    rejection_message_ar: listingRow.rejection_message_ar,
    rejected_at: listingRow.rejected_at,
    merchant_user_id: listingRow.merchant_user_id,
    created_at: listingRow.created_at,
    updated_at: listingRow.updated_at,
  };

  // اكتب فقط الأعمدة الموجودة لتجنب أخطاء المخطط.
  const cleaned = {};
  for (const [key, value] of Object.entries(product)) {
    if (value === undefined) continue;
    if (!(await hasColumn('merchant_products', key))) continue;
    cleaned[key] = value;
  }
  try {
    return await saveRow('merchant_products', cleaned, 'id');
  } catch (error) {
    console.warn(
      'mirrorListingToMerchantProducts failed:',
      error?.message || error,
    );
    return null;
  }
}

/**
 * حفظ إعلان زبون: الجدول الجديد أولاً، ثم مرآة قديمة اختيارية.
 * يُرجع شكل merchant_products للتوافق مع الواجهة الحالية.
 */
async function saveCustomerListingRecord(payload, meta = {}) {
  const listing = await upsertCustomerListing(payload, meta);
  if (listing) {
    await mirrorListingToMerchantProducts(listing).catch(() => null);
    return listingToProductShape(listing);
  }
  // إن لم يوجد الجدول بعد — اكتب القديم فقط (مرحلة انتقالية).
  const fallback = {
    ...payload,
    phone: meta.ownerPhone || payload.phone,
    updated_at: nowIso(),
  };
  const saved = await saveRow('merchant_products', fallback, 'id');
  return saved || fallback;
}

async function updateCustomerListingApproval(productId, patch = {}) {
  const id = String(productId || '').trim();
  if (!id) return null;
  const existing = await getCustomerListingById(id);
  if (!existing) return null;
  const next = {
    ...patch,
    updated_at: nowIso(),
  };
  try {
    return await updateRow('customer_listings', 'id', id, next);
  } catch (error) {
    console.warn('updateCustomerListingApproval failed:', error?.message || error);
    return null;
  }
}

async function listCustomerListingsByDomain(domain, filters = {}) {
  try {
    const clauses = [{ method: 'eq', column: 'domain', value: domain }];
    if (filters.ownerPhone) {
      const variants = getPhoneVariants(filters.ownerPhone);
      if (variants.length === 1) {
        clauses.push({ method: 'eq', column: 'owner_phone', value: variants[0] });
      } else if (variants.length > 1) {
        clauses.push({ method: 'in', column: 'owner_phone', value: variants });
      }
    }
    if (filters.category) {
      clauses.push({ method: 'eq', column: 'category', value: filters.category });
    }
    if (filters.subCategory) {
      clauses.push({
        method: 'eq',
        column: 'sub_category',
        value: filters.subCategory,
      });
    }
    if (filters.listingMode) {
      clauses.push({
        method: 'eq',
        column: 'listing_mode',
        value: filters.listingMode,
      });
    }
    if (filters.approvedOnly) {
      clauses.push({ method: 'eq', column: 'is_approved', value: true });
    }
    const rows = await selectMany(
      'customer_listings',
      clauses,
      { column: 'updated_at', ascending: false },
      filters.limit || null,
      filters.offset || null,
    );
    return (rows || []).map(listingToProductShape);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return [];
    }
    throw error;
  }
}

async function listPendingCustomerListings(category = null) {
  try {
    const clauses = [
      { method: 'eq', column: 'is_approved', value: false },
      { method: 'eq', column: 'approval_status', value: 'pending' },
    ];
    if (category) {
      clauses.push({ method: 'eq', column: 'category', value: category });
    }
    const rows = await selectMany(
      'customer_listings',
      clauses,
      { column: 'updated_at', ascending: false },
      2000,
    );
    return (rows || []).map(listingToProductShape);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return [];
    }
    throw error;
  }
}

async function deleteCustomerListing(id, phone) {
  const key = String(id || '').trim();
  if (!key) return false;
  const existing = await getCustomerListingById(key);
  if (existing) {
    if (phone && !phonesOverlap(existing.owner_phone, phone)) {
      throw new Error('Unauthorized listing delete.');
    }
    const supabase = assertSupabaseAdmin();
    const { error } = await supabase.from('customer_listings').delete().eq('id', key);
    if (error) throw new Error(error.message);
  }
  // لا نحذف من merchant_products أثناء الترحيل — أرشفة حية.
  return true;
}

async function resolveListingForRead(id) {
  const fromNew = await getCustomerListingById(id);
  if (fromNew) return listingToProductShape(fromNew);
  return selectSingle('merchant_products', 'id', id);
}

/**
 * دمج صفوف جديدة + قديمة بنفس id دون تكرار (الجديد يفوز).
 */
function mergeListingRows(primaryRows, fallbackRows) {
  const map = new Map();
  for (const row of fallbackRows || []) {
    if (!row?.id) continue;
    if (!isCustomerListingDomainRow(row) && !row.domain) {
      // قد تكون صفوف عقارات بدون domain في القديم
      const cat = String(row.category || '').trim();
      if (!['real_estate', 'used', 'offers'].includes(cat)) continue;
    }
    map.set(String(row.id), row);
  }
  for (const row of primaryRows || []) {
    if (!row?.id) continue;
    map.set(String(row.id), row);
  }
  return [...map.values()];
}

async function countCustomerListingsByDomain() {
  const out = { real_estate: 0, used: 0, offers: 0, tableMissing: false };
  try {
    const supabase = assertSupabaseAdmin();
    for (const domain of Object.values(DOMAINS)) {
      const { count, error } = await supabase
        .from('customer_listings')
        .select('*', { count: 'exact', head: true })
        .eq('domain', domain);
      if (error) throw error;
      out[domain] = Number(count) || 0;
    }
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      out.tableMissing = true;
      return out;
    }
    throw error;
  }
  return out;
}

module.exports = {
  DOMAINS,
  MIRROR_TO_MERCHANT_PRODUCTS,
  domainFromCategory,
  isCustomerListingDomainRow,
  toListingRow,
  listingToProductShape,
  getCustomerListingById,
  upsertCustomerListing,
  mirrorListingToMerchantProducts,
  saveCustomerListingRecord,
  updateCustomerListingApproval,
  listCustomerListingsByDomain,
  listPendingCustomerListings,
  deleteCustomerListing,
  resolveListingForRead,
  mergeListingRows,
  countCustomerListingsByDomain,
};
