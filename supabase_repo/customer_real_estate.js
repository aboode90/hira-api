/**
 * إعلانات العقارات من الزبون — موافقة أدمن ثم ظهور عام.
 * listing_mode يبقى sell | rent (فلاتر التصفح).
 * الإعلانات القديمة للتجار تُدار بنفس رقم الهاتف عبر «عقاراتي المنشورة».
 */

const {
  nowIso,
  phonesOverlap,
  resolvePhoneKey,
  getPhoneVariants,
  selectSingle,
  selectMany,
  selectManyColumns,
  hasColumn,
  saveRow,
  updateRow,
} = require('./common');
const { ensureAppUser } = require('./users');
const {
  normalizeProductImagePayload,
  serializeProductRowForClient,
  isRemoteImageUrl,
} = require('../services/image_refs');
const {
  saveCustomerListingRecord,
  getCustomerListingById,
  listCustomerListingsByDomain,
  deleteCustomerListing,
  mergeListingRows,
  DOMAINS,
} = require('./customer_listings');

const ALLOWED_RE_SUB_CATEGORIES = new Set([
  'house',
  'land',
  'shops',
  'apartment',
  'building',
  'farm',
]);

function isRealEstateRow(row) {
  if (!row) return false;
  return String(row.category || row.service_id || '').trim() === 'real_estate';
}

function normalizeListingMode(raw) {
  return String(raw || '').trim() === 'rent' ? 'rent' : 'sell';
}

function realEstateContentChanged(existing, data) {
  if (!existing) return true;
  const fields = [
    ['name_ar', 'nameAr'],
    ['description_ar', 'descriptionAr'],
    ['price', 'price'],
    ['sub_category', 'subCategory'],
    ['listing_mode', 'listingMode'],
    ['neighborhood', 'neighborhood'],
    ['facade', 'facade'],
    ['area_square_meter', 'areaSquareMeter'],
    ['floor_count', 'floorCount'],
    ['image', 'image'],
    ['image_url', 'imageUrl'],
    ['video_url', 'videoUrl'],
  ];
  for (const [snake, camel] of fields) {
    const next = data[snake] ?? data[camel];
    if (next === undefined) continue;
    const prev = existing[snake] ?? existing[camel];
    if (String(next ?? '').trim() !== String(prev ?? '').trim()) return true;
  }
  const nextGallery = data.gallery_images_base64 ?? data.galleryImagesBase64;
  if (nextGallery !== undefined) {
    const prev = JSON.stringify(existing.gallery_images_base64 ?? []);
    const next = JSON.stringify(nextGallery ?? []);
    if (prev !== next) return true;
  }
  return false;
}

async function saveCustomerRealEstateListing(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);

  const neighborhood = String(data.neighborhood ?? data.address ?? '').trim();
  if (!neighborhood) {
    throw new Error('أدخل الحي أو المنطقة.');
  }

  const subCategory = String(
    data.sub_category ?? data.subCategory ?? 'house',
  ).trim();
  if (!ALLOWED_RE_SUB_CATEGORIES.has(subCategory)) {
    throw new Error('اختر نوع العقار.');
  }

  const listingMode = normalizeListingMode(
    data.listing_mode ?? data.listingMode,
  );

  const facade = String(data.facade ?? '').trim();
  const floors = Number.parseInt(
    String(data.floor_count ?? data.floorCount ?? '0').replace(/,/g, ''),
    10,
  );
  const area = Number.parseInt(
    String(data.area_square_meter ?? data.areaSquareMeter ?? '0').replace(
      /,/g,
      '',
    ),
    10,
  );
  const price = Number.parseInt(
    String(data.price ?? '0').replace(/,/g, ''),
    10,
  );
  if (!Number.isFinite(price) || price < 0) {
    throw new Error('أدخل سعراً صحيحاً.');
  }

  const typeTitle =
    {
      house: 'دار',
      land: 'أرض',
      shops: 'محلات تجارية',
      apartment: 'شقة',
      building: 'بناية سكنية تجارية',
      farm: 'مزرعة',
    }[subCategory] || 'عقار';

  const nameAr =
    String(data.name_ar ?? data.nameAr ?? '').trim() ||
    `${typeTitle} — ${neighborhood}`;
  const description =
    String(
      data.description_ar ??
        data.descriptionAr ??
        data.description_en ??
        data.descriptionEn ??
        '',
    ).trim() ||
    [
      `الحي: ${neighborhood}`,
      facade ? `الواجهة: ${facade}` : null,
      Number.isFinite(floors) && floors > 0 ? `النزال: ${floors}` : null,
      Number.isFinite(area) && area > 0 ? `المساحة الكلية: ${area} م²` : null,
      `نوع العقار: ${typeTitle}`,
    ]
      .filter(Boolean)
      .join('\n');

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
      throw new Error('Unauthorized real estate listing update.');
    }
    if (
      String(existing.category || '').trim() &&
      String(existing.category || '').trim() !== 'real_estate'
    ) {
      throw new Error('Not a real estate listing.');
    }
  }

  const publisherName = String(
    data.publisher_name ??
      data.publisherName ??
      data.display_name ??
      data.displayName ??
      appUser?.full_name ??
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
    category: 'real_estate',
    name_ar: nameAr,
    name_en: String(data.name_en ?? data.nameEn ?? nameAr).trim() || nameAr,
    description_ar: description,
    description_en: description,
    price: price,
    is_available: true,
  };

  if (await hasColumn('merchant_products', 'merchant_user_id')) {
    payload.merchant_user_id = appUser?.id || null;
  }
  if (await hasColumn('merchant_products', 'service_id')) {
    payload.service_id = 'real_estate';
  }
  if (await hasColumn('merchant_products', 'sub_category')) {
    payload.sub_category = subCategory;
  }
  if (await hasColumn('merchant_products', 'listing_mode')) {
    payload.listing_mode = listingMode;
  }
  if (await hasColumn('merchant_products', 'action_label_en')) {
    payload.action_label_en = resolvedContact;
  }
  if (await hasColumn('merchant_products', 'action_label_ar')) {
    payload.action_label_ar = publisherName || 'عقارات';
  }
  if (await hasColumn('merchant_products', 'neighborhood')) {
    payload.neighborhood = neighborhood;
  }
  if (await hasColumn('merchant_products', 'facade')) {
    payload.facade = facade;
  }
  if (
    await hasColumn('merchant_products', 'floor_count') &&
    Number.isFinite(floors)
  ) {
    payload.floor_count = floors;
  }
  if (
    await hasColumn('merchant_products', 'area_square_meter') &&
    Number.isFinite(area)
  ) {
    payload.area_square_meter = area;
  }

  const rawGallery = data.gallery_images_base64 ?? data.galleryImagesBase64;
  if (
    rawGallery !== undefined &&
    (await hasColumn('merchant_products', 'gallery_images_base64'))
  ) {
    const entries = Array.isArray(rawGallery)
      ? rawGallery.map((e) => String(e || '').trim()).filter(Boolean)
      : [];
    payload.gallery_images_base64 = entries;
    if (entries.length > 0) {
      const first = entries[0];
      if (isRemoteImageUrl(first)) {
        Object.assign(
          payload,
          normalizeProductImagePayload({ image: first, image_url: first }),
        );
      } else if (await hasColumn('merchant_products', 'image_base64')) {
        payload.image_base64 = first;
      }
    }
  } else {
    Object.assign(payload, normalizeProductImagePayload(data));
  }

  if (
    (data.video_url !== undefined || data.videoUrl !== undefined) &&
    (await hasColumn('merchant_products', 'video_url'))
  ) {
    const rawVideo = String(data.video_url ?? data.videoUrl ?? '').trim();
    payload.video_url = /^https?:\/\//i.test(rawVideo) ? rawVideo : null;
  }

  if (existing && !String(payload.image || payload.image_url || '').trim()) {
    payload.image = existing.image ?? existing.image_url ?? '';
  }

  if (await hasColumn('merchant_products', 'is_approved')) {
    const contentChanged = realEstateContentChanged(existing, data);
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

  // دائماً اكتب الحقول كاملة للجدول الجديد (حتى لو لم توجد أعمدة في merchant_products).
  const listingPayload = {
    ...payload,
    service_id: 'real_estate',
    sub_category: subCategory,
    listing_mode: listingMode,
    action_label_en: resolvedContact,
    action_label_ar: publisherName || 'عقارات',
    neighborhood,
    facade,
    floor_count: Number.isFinite(floors) ? floors : null,
    area_square_meter: Number.isFinite(area) ? area : null,
    merchant_user_id: appUser?.id || null,
  };

  const saved = await saveCustomerListingRecord(listingPayload, {
    domain: DOMAINS.real_estate,
    ownerPhone: phoneKey,
    legacyId: productId,
  });
  if (!saved) throw new Error('Failed to save real estate listing.');

  try {
    const {
      invalidateCache,
      invalidateCachePrefix,
    } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:real-estate-listings:');
    await invalidateCachePrefix('marketplace:catalog-products:');
    invalidateCache('marketplace:stats');
  } catch (_) {
    // ignore
  }

  return serializeProductRowForClient(saved);
}

async function listMyCustomerRealEstateListings(phone, options = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const pageSize = Math.min(
    Math.max(Number.parseInt(String(options.limit ?? 10), 10) || 10, 1),
    40,
  );
  const offset = Math.max(
    Number.parseInt(String(options.offset ?? 0), 10) || 0,
    0,
  );

  const fromNew = await listCustomerListingsByDomain(DOMAINS.real_estate, {
    ownerPhone: phoneKey,
    limit: pageSize + 1,
    offset,
  });
  const fromOld = await selectMany(
    'merchant_products',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'category', value: 'real_estate' },
    ],
    { column: 'updated_at', ascending: false },
    pageSize + 1,
    offset,
  );

  const rows = mergeListingRows(fromNew, fromOld || [])
    .filter((row) => isRealEstateRow(row))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  const mapped = rows.slice(0, pageSize).map((row) => {
    const serialized = serializeProductRowForClient(row);
    if (Array.isArray(serialized.gallery_images_base64)) {
      serialized.gallery_images_base64 = serialized.gallery_images_base64
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .slice(0, 1);
    }
    return {
      ...serialized,
      listing_source: 'customer',
      contact_phone:
        String(row.action_label_en || '').trim() ||
        String(row.phone || row.owner_phone || '').trim(),
    };
  });

  return {
    items: mapped,
    hasMore: rows.length > pageSize,
    offset,
    limit: pageSize,
  };
}

/** فحص خفيف لزر «عقاراتي» — بدون جلب الصور/المحتوى. */
async function hasMyCustomerRealEstateListings(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const fromNew = await listCustomerListingsByDomain(DOMAINS.real_estate, {
    ownerPhone: phoneKey,
    limit: 1,
  });
  if (fromNew.length > 0) return { hasListings: true };

  const variants = getPhoneVariants(phoneKey);
  const rows = await selectManyColumns(
    'merchant_products',
    'id',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'category', value: 'real_estate' },
    ],
    null,
    1,
  );
  return { hasListings: Array.isArray(rows) && rows.length > 0 };
}

async function deleteCustomerRealEstateListing(phone, listingId) {
  await deleteCustomerListing(listingId, phone);
  // أثناء الترحيل: لا نحذف من merchant_products (أرشيف حي).
  return { success: true, archivedLegacy: true };
}

module.exports = {
  ALLOWED_RE_SUB_CATEGORIES,
  isRealEstateRow,
  normalizeListingMode,
  saveCustomerRealEstateListing,
  listMyCustomerRealEstateListings,
  hasMyCustomerRealEstateListings,
  deleteCustomerRealEstateListing,
};
