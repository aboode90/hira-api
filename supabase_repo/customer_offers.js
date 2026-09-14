/**
 * عروض الزبائن — نشر عام في قسم العروض مع موافقة أدمن.
 * مدة الظهور يختارها الناشر (بالأيام) وتبدأ من لحظة الموافقة.
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

const CUSTOMER_OFFER_LISTING_MODE = 'customer_offer';
const DEFAULT_OFFER_LIVE_DAYS = 7;
const MIN_OFFER_LIVE_DAYS = 1;
const MAX_OFFER_LIVE_DAYS = 30;
const ALLOWED_SUB_CATEGORIES = new Set(['discount', 'daily_deal']);
const ALLOWED_DURATION_DAYS = new Set([1, 3, 7, 14, 30]);

function isCustomerOfferRow(row) {
  if (!row) return false;
  const category = String(row.category || row.service_id || '').trim();
  if (category !== 'offers') return false;
  return (
    String(row.listing_mode || row.listingMode || '').trim() ===
    CUSTOMER_OFFER_LISTING_MODE
  );
}

function normalizeOfferDurationDays(raw, fallback = DEFAULT_OFFER_LIVE_DAYS) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (!ALLOWED_DURATION_DAYS.has(parsed)) {
    return Math.min(
      MAX_OFFER_LIVE_DAYS,
      Math.max(MIN_OFFER_LIVE_DAYS, parsed),
    );
  }
  return parsed;
}

/** مدة العرض المطلوبة تُخزَّن في prep_minutes حتى الموافقة. */
function readRequestedOfferDays(row) {
  return normalizeOfferDurationDays(
    row?.prep_minutes ??
      row?.prepMinutes ??
      row?.offer_duration_days ??
      row?.offerDurationDays,
    DEFAULT_OFFER_LIVE_DAYS,
  );
}

function offerLiveUntilIso(
  fromDate = new Date(),
  days = DEFAULT_OFFER_LIVE_DAYS,
) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const ms = Number.isNaN(base.getTime()) ? Date.now() : base.getTime();
  const liveDays = normalizeOfferDurationDays(days, DEFAULT_OFFER_LIVE_DAYS);
  return new Date(ms + liveDays * 24 * 60 * 60 * 1000).toISOString();
}

function merchantProductContentChanged(existing, data) {
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
  const nextDays =
    data.offer_duration_days ?? data.offerDurationDays ?? data.prep_minutes;
  if (nextDays !== undefined) {
    const prevDays = readRequestedOfferDays(existing);
    if (normalizeOfferDurationDays(nextDays, prevDays) !== prevDays) return true;
  }
  return false;
}

async function saveCustomerOffer(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);

  const nameAr = String(data.name_ar ?? data.nameAr ?? '').trim();
  if (!nameAr) {
    throw new Error('أدخل عنوان العرض.');
  }

  const subCategory = String(
    data.sub_category ?? data.subCategory ?? 'discount',
  ).trim();
  if (!ALLOWED_SUB_CATEGORIES.has(subCategory)) {
    throw new Error('اختر نوع العرض: خصم أو عرض يومي.');
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
      throw new Error('Unauthorized offer update.');
    }
    if (
      String(existing.category || '').trim() &&
      String(existing.category || '').trim() !== 'offers'
    ) {
      throw new Error('Not a customer offer.');
    }
  }

  const durationDays = normalizeOfferDurationDays(
    data.offer_duration_days ??
      data.offerDurationDays ??
      data.prep_minutes,
    existing ? readRequestedOfferDays(existing) : DEFAULT_OFFER_LIVE_DAYS,
  );
  const resolvedDurationDays =
    subCategory === 'daily_deal' ? 1 : durationDays;
  if (
    subCategory !== 'daily_deal' &&
    !ALLOWED_DURATION_DAYS.has(resolvedDurationDays)
  ) {
    throw new Error('اختر مدة العرض: 1 أو 3 أو 7 أو 14 أو 30 يوماً.');
  }

  const contactPhone = String(
    data.contact_phone ?? data.contactPhone ?? phoneKey,
  )
    .trim()
    .replace(/\s+/g, '');
  const resolvedContact = contactPhone || phoneKey;

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

  const payload = {
    id: productId,
    phone: phoneKey,
    updated_at: nowIso(),
    category: 'offers',
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
    payload.service_id = 'offers';
  }
  if (await hasColumn('merchant_products', 'sub_category')) {
    payload.sub_category = subCategory;
  }
  if (await hasColumn('merchant_products', 'listing_mode')) {
    payload.listing_mode = CUSTOMER_OFFER_LISTING_MODE;
  }
  if (await hasColumn('merchant_products', 'prep_minutes')) {
    payload.prep_minutes = resolvedDurationDays;
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
    if (!existing || merchantProductContentChanged(existing, data)) {
      payload.available_until = null;
    }
  }

  if (await hasColumn('merchant_products', 'is_approved')) {
    const contentChanged = merchantProductContentChanged(existing, data);
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
    service_id: 'offers',
    sub_category: subCategory,
    listing_mode: CUSTOMER_OFFER_LISTING_MODE,
    prep_minutes: resolvedDurationDays,
    action_label_en: resolvedContact,
    action_label_ar: publisherName || null,
    merchant_user_id: appUser?.id || null,
    available_until: payload.available_until ?? null,
  };

  const saved = await saveCustomerListingRecord(listingPayload, {
    domain: DOMAINS.offers,
    ownerPhone: phoneKey,
    legacyId: productId,
  });
  if (!saved) throw new Error('Failed to save offer.');

  try {
    const {
      invalidateCache,
      invalidateCachePrefix,
    } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
    invalidateCache('marketplace:offer-catalog-products');
  } catch (_) {
    // ignore
  }

  const serialized = serializeProductRowForClient(saved);
  return {
    ...serialized,
    offer_duration_days: readRequestedOfferDays(saved),
  };
}

async function listMyCustomerOffers(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const fromNew = await listCustomerListingsByDomain(DOMAINS.offers, {
    ownerPhone: phoneKey,
    limit: 200,
  });
  const fromOld = await selectMany(
    'merchant_products',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'category', value: 'offers' },
    ],
    { column: 'updated_at', ascending: false },
    200,
  );

  const nowMs = Date.now();
  return mergeListingRows(fromNew, fromOld || [])
    .filter((row) => isCustomerOfferRow(row))
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
        offer_duration_days: readRequestedOfferDays(row),
        contact_phone:
          String(row.action_label_en || '').trim() ||
          String(row.phone || row.owner_phone || '').trim(),
      };
    });
}

async function deleteCustomerOffer(phone, offerId) {
  await deleteCustomerListing(offerId, phone);
  return { success: true, archivedLegacy: true };
}

/**
 * عند موافقة الأدمن: available_until = الآن + المدة التي اختارها الناشر.
 */
async function applyOfferApprovalWindow(existing, patch) {
  if (!existing || !patch) return patch;
  const category = String(
    patch.category ?? existing.category ?? existing.service_id ?? '',
  ).trim();
  if (category !== 'offers') return patch;
  const days = readRequestedOfferDays(existing);
  patch.available_until = offerLiveUntilIso(new Date(), days);
  await updateCustomerListingApproval(existing.id, {
    available_until: patch.available_until,
  });
  return patch;
}

module.exports = {
  CUSTOMER_OFFER_LISTING_MODE,
  DEFAULT_OFFER_LIVE_DAYS,
  OFFER_LIVE_DAYS: DEFAULT_OFFER_LIVE_DAYS,
  isCustomerOfferRow,
  offerLiveUntilIso,
  readRequestedOfferDays,
  saveCustomerOffer,
  listMyCustomerOffers,
  deleteCustomerOffer,
  applyOfferApprovalWindow,
};
