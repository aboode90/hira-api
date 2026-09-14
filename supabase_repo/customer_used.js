/**
 * إعلانات المستعمل من الزبون — موافقة أدمن ثم ظهور 7 أيام ثم حذف.
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
} = require('./common');
const { ensureAppUser } = require('./users');
const {
  normalizeProductImagePayload,
  serializeProductRowForClient,
} = require('../services/image_refs');
const {
  saveCustomerListingRecord,
  getCustomerListingById,
  listCustomerListingsByDomain,
  deleteCustomerListing,
  mergeListingRows,
  updateCustomerListingApproval,
  DOMAINS,
} = require('./customer_listings');

const CUSTOMER_USED_LISTING_MODE = 'customer_used';
const USED_LIVE_DAYS = 7;
const ALLOWED_USED_SUB_CATEGORIES = new Set([
  'used_home_goods',
  'used_electrical_appliances',
  'used_construction',
  'used_shoes_bags',
  'used_clothing',
  'used_other',
]);

function isCustomerUsedRow(row) {
  if (!row) return false;
  const category = String(row.category || row.service_id || '').trim();
  if (category !== 'used') return false;
  return (
    String(row.listing_mode || row.listingMode || '').trim() ===
    CUSTOMER_USED_LISTING_MODE
  );
}

function usedLiveUntilIso(fromDate = new Date()) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const ms = Number.isNaN(base.getTime()) ? Date.now() : base.getTime();
  return new Date(ms + USED_LIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function usedListingContentChanged(existing, data) {
  if (!existing) return true;
  const fields = [
    ['name_ar', 'nameAr'],
    ['name_en', 'nameEn'],
    ['description_ar', 'descriptionAr'],
    ['description_en', 'descriptionEn'],
    ['price', 'price'],
    ['sub_category', 'subCategory'],
    ['image', 'image'],
    ['image_url', 'imageUrl'],
  ];
  for (const [snake, camel] of fields) {
    const next = data[snake] ?? data[camel];
    if (next === undefined) continue;
    const prev = existing[snake] ?? existing[camel];
    if (String(next ?? '').trim() !== String(prev ?? '').trim()) return true;
  }
  return false;
}

async function saveCustomerUsedListing(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);

  const nameAr = String(data.name_ar ?? data.nameAr ?? '').trim();
  if (!nameAr) {
    throw new Error('أدخل عنوان الإعلان.');
  }

  const subCategory = String(
    data.sub_category ?? data.subCategory ?? 'used_other',
  ).trim();
  if (!ALLOWED_USED_SUB_CATEGORIES.has(subCategory)) {
    throw new Error('اختر تصنيف المستعمل.');
  }

  const productId =
    data.id && String(data.id).trim().length > 0
      ? String(data.id).trim()
      : String(Date.now());

  let existing = null;
  if (productId) {
    const fromNew = await getCustomerListingById(productId);
    existing = fromNew
      ? { ...fromNew, phone: fromNew.owner_phone || fromNew.phone }
      : await selectSingle('merchant_products', 'id', productId);
  }
  if (existing) {
    if (!phonesOverlap(existing.phone || existing.owner_phone, phoneKey)) {
      throw new Error('Unauthorized used listing update.');
    }
    if (
      String(existing.category || '').trim() &&
      String(existing.category || '').trim() !== 'used'
    ) {
      throw new Error('Not a customer used listing.');
    }
  }

  const description = String(
    data.description_ar ??
      data.descriptionAr ??
      data.description_en ??
      data.descriptionEn ??
      '',
  ).trim();
  const priceRaw = data.price;
  const price = Number.parseInt(String(priceRaw ?? '0').replace(/,/g, ''), 10);
  const resolvedPrice = Number.isFinite(price) && price >= 0 ? price : 0;

  const publisherName = String(
    data.publisher_name ??
      data.publisherName ??
      data.display_name ??
      data.displayName ??
      '',
  ).trim();

  const contactPhone = String(
    data.contact_phone ?? data.contactPhone ?? phoneKey,
  )
    .trim()
    .replace(/\s+/g, '');
  const resolvedContact = contactPhone || phoneKey;

  const payload = {
    id: productId,
    phone: phoneKey,
    updated_at: nowIso(),
    category: 'used',
    name_ar: nameAr,
    name_en: String(data.name_en ?? data.nameEn ?? nameAr).trim() || nameAr,
    description_ar: description,
    description_en: description,
    price: resolvedPrice,
    is_available: true,
  };

  if (await hasColumn('merchant_products', 'merchant_user_id')) {
    payload.merchant_user_id = appUser?.id || null;
  }
  if (await hasColumn('merchant_products', 'service_id')) {
    payload.service_id = 'used';
  }
  if (await hasColumn('merchant_products', 'sub_category')) {
    payload.sub_category = subCategory;
  }
  if (await hasColumn('merchant_products', 'listing_mode')) {
    payload.listing_mode = CUSTOMER_USED_LISTING_MODE;
  }
  if (await hasColumn('merchant_products', 'action_label_en')) {
    payload.action_label_en = resolvedContact;
  }
  if (await hasColumn('merchant_products', 'action_label_ar') && publisherName) {
    payload.action_label_ar = publisherName;
  }

  Object.assign(payload, normalizeProductImagePayload(data));
  if (existing && !String(payload.image || '').trim()) {
    payload.image = existing.image ?? existing.image_url ?? '';
  }

  if (await hasColumn('merchant_products', 'available_until')) {
    if (!existing || usedListingContentChanged(existing, data)) {
      payload.available_until = null;
    }
  }

  if (await hasColumn('merchant_products', 'is_approved')) {
    const contentChanged = usedListingContentChanged(existing, data);
    if (!existing || contentChanged) {
      payload.is_approved = false;
      if (await hasColumn('merchant_products', 'approval_status')) {
        payload.approval_status = 'pending';
      }
      if (await hasColumn('merchant_products', 'rejection_message_ar')) {
        payload.rejection_message_ar = null;
      }
      if (await hasColumn('merchant_products', 'rejected_at')) {
        payload.rejected_at = null;
      }
    }
  }

  if (!existing) {
    payload.created_at = nowIso();
  }

  const listingPayload = {
    ...payload,
    service_id: 'used',
    sub_category: subCategory,
    listing_mode: CUSTOMER_USED_LISTING_MODE,
    action_label_en: resolvedContact,
    action_label_ar: publisherName || null,
    merchant_user_id: appUser?.id || null,
    available_until: payload.available_until ?? null,
  };

  const saved = await saveCustomerListingRecord(listingPayload, {
    domain: DOMAINS.used,
    ownerPhone: phoneKey,
    legacyId: productId,
  });
  if (!saved) throw new Error('Failed to save used listing.');

  try {
    const {
      invalidateCachePrefix,
    } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {
    // ignore
  }

  return serializeProductRowForClient(saved);
}

async function listMyCustomerUsedListings(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const fromNew = await listCustomerListingsByDomain(DOMAINS.used, {
    ownerPhone: phoneKey,
    limit: 200,
  });
  const fromOld = await selectMany(
    'merchant_products',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'category', value: 'used' },
    ],
    { column: 'updated_at', ascending: false },
    200,
  );

  const nowMs = Date.now();
  return mergeListingRows(fromNew, fromOld || [])
    .filter((row) => isCustomerUsedRow(row))
    .map((row) => {
      const serialized = serializeProductRowForClient(row);
      const untilRaw = row.available_until ?? row.availableUntil;
      let daysLeft = null;
      if (untilRaw) {
        const untilMs = new Date(untilRaw).getTime();
        if (!Number.isNaN(untilMs)) {
          daysLeft = Math.ceil((untilMs - nowMs) / (24 * 60 * 60 * 1000));
        }
      }
      return {
        ...serialized,
        listing_source: 'customer',
        days_left: daysLeft,
        contact_phone:
          String(row.action_label_en || '').trim() ||
          String(row.phone || row.owner_phone || '').trim(),
      };
    });
}

async function deleteCustomerUsedListing(phone, offerId) {
  await deleteCustomerListing(offerId, phone);
  return { success: true, archivedLegacy: true };
}

async function applyUsedApprovalWindow(existing, patch) {
  if (!existing || !patch) return patch;
  if (!isCustomerUsedRow(existing)) return patch;
  patch.available_until = usedLiveUntilIso(new Date());
  await updateCustomerListingApproval(existing.id, {
    available_until: patch.available_until,
  });
  return patch;
}

module.exports = {
  CUSTOMER_USED_LISTING_MODE,
  USED_LIVE_DAYS,
  isCustomerUsedRow,
  usedLiveUntilIso,
  saveCustomerUsedListing,
  listMyCustomerUsedListings,
  deleteCustomerUsedListing,
  applyUsedApprovalWindow,
};
