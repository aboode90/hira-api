/**
 * منتجات التسوق من حساب الزبون — نفس جدول merchant_products بمفتاح الهاتف.
 * لا يرحّل ولا يعدّل صفوف التجار القديمة؛ listing_mode للجديد فقط.
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
  deleteRow,
} = require('./common');
const { ensureAppUser } = require('./users');
const {
  normalizeProductImagePayload,
  serializeProductRowForClient,
} = require('../services/image_refs');

const CUSTOMER_PRODUCT_LISTING_MODE = 'customer_product';
const PRODUCT_SERVICE = 'product';

function isShoppingProductRow(row) {
  if (!row) return false;
  const category = String(row.category || row.service_id || '').trim();
  // LEGACY — bazar_ghaith is no longer a browsable shopping channel.
  return category === PRODUCT_SERVICE;
}

function shoppingContentChanged(existing, data) {
  if (!existing) return true;
  const fields = [
    ['name_ar', 'nameAr'],
    ['description_ar', 'descriptionAr'],
    ['price', 'price'],
    ['image', 'image'],
    ['image_url', 'imageUrl'],
    ['sub_category', 'subCategory'],
    ['stock_quantity', 'stockQuantity'],
  ];
  for (const [snake, camel] of fields) {
    const next = data[snake] ?? data[camel];
    if (next === undefined) continue;
    const prev = existing[snake] ?? existing[camel];
    if (String(next ?? '').trim() !== String(prev ?? '').trim()) return true;
  }
  return false;
}

async function ensureCustomerShoppingMerchantProfile(phoneKey, data = {}) {
  const {
    ensureMerchantProfileRecord,
    getMerchantProfile,
    saveMerchantProfile,
  } = require('./merchants');

  const storeName = String(
    data.store_name ?? data.storeName ?? data.merchant_store_name ?? '',
  ).trim();
  const address = String(data.store_address ?? data.storeAddress ?? data.address ?? '').trim();
  const lat = data.latitude ?? data.store_latitude ?? data.storeLatitude;
  const lng = data.longitude ?? data.store_longitude ?? data.storeLongitude;

  let profile = await getMerchantProfile(phoneKey);
  if (!profile) {
    profile = await ensureMerchantProfileRecord(phoneKey, {
      store_name: storeName || `متجر ${phoneKey.slice(-4)}`,
      primary_service_id: PRODUCT_SERVICE,
      active_service_id: PRODUCT_SERVICE,
      is_approved: true,
      approval_status: 'approved',
      ...(address ? { address } : {}),
      ...(lat != null && lng != null
        ? { latitude: Number(lat), longitude: Number(lng) }
        : {}),
    });
  }

  const existing = profile || {};
  const serviceIdsRaw = Array.isArray(existing.service_ids)
    ? existing.service_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const nextServiceIds = serviceIdsRaw.includes(PRODUCT_SERVICE)
    ? serviceIdsRaw
    : [...serviceIdsRaw, PRODUCT_SERVICE];

  const patch = {
    service_ids: nextServiceIds,
    is_approved: true,
    approval_status: 'approved',
  };
  if (storeName) patch.store_name = storeName;
  if (address) patch.address = address;
  if (lat != null && Number.isFinite(Number(lat))) patch.latitude = Number(lat);
  if (lng != null && Number.isFinite(Number(lng))) patch.longitude = Number(lng);
  if (!existing.primary_service_id) {
    patch.primary_service_id = PRODUCT_SERVICE;
    patch.active_service_id = PRODUCT_SERVICE;
  }

  const sectionsRaw = Array.isArray(existing.product_sections)
    ? existing.product_sections
    : Array.isArray(existing.productSections)
      ? existing.productSections
      : [];
  if (sectionsRaw.length === 0) {
    patch.product_sections = [
      {
        id: 'general',
        name_ar: 'عام',
        nameAr: 'عام',
        name_en: 'General',
        nameEn: 'General',
        sort_order: 1,
        sortOrder: 1,
      },
    ];
  }

  try {
    await saveMerchantProfile(phoneKey, patch);
  } catch (error) {
    console.warn('customer shopping profile patch:', error?.message || error);
  }

  return getMerchantProfile(phoneKey);
}

async function saveCustomerShoppingProduct(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);

  const nameAr = String(data.name_ar ?? data.nameAr ?? '').trim();
  if (!nameAr) throw new Error('أدخل اسم المنتج.');

  const priceRaw = data.price;
  const price = Number.parseInt(String(priceRaw ?? '0').replace(/,/g, ''), 10);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error('أدخل سعر المنتج.');
  }

  const subCategory = String(
    data.sub_category ?? data.subCategory ?? '',
  ).trim();
  if (!subCategory) throw new Error('اختر قسم التسوق.');

  await ensureCustomerShoppingMerchantProfile(phoneKey, data);

  const productId =
    data.id && String(data.id).trim().length > 0
      ? String(data.id).trim()
      : String(Date.now());

  let existing = null;
  if (productId) {
    existing = await selectSingle('merchant_products', 'id', productId);
  }
  if (existing) {
    if (!phonesOverlap(existing.phone, phoneKey)) {
      throw new Error('Unauthorized product update.');
    }
    if (!isShoppingProductRow(existing)) {
      throw new Error('Not a shopping product.');
    }
  }

  const description = String(
    data.description_ar ?? data.descriptionAr ?? data.description ?? '',
  ).trim();

  const stockRaw = data.stock_quantity ?? data.stockQuantity;
  const stock =
    stockRaw === null || stockRaw === undefined || stockRaw === ''
      ? null
      : Number.parseInt(String(stockRaw).replace(/,/g, ''), 10);

  const payload = {
    id: productId,
    phone: phoneKey,
    updated_at: nowIso(),
    category: PRODUCT_SERVICE,
    name_ar: nameAr,
    name_en: String(data.name_en ?? data.nameEn ?? nameAr).trim() || nameAr,
    description_ar: description,
    description_en: description,
    price,
    is_available:
      data.is_available !== undefined
        ? Boolean(data.is_available)
        : data.isAvailable !== undefined
          ? Boolean(data.isAvailable)
          : true,
  };

  if (await hasColumn('merchant_products', 'merchant_user_id')) {
    payload.merchant_user_id = appUser?.id || null;
  }
  if (await hasColumn('merchant_products', 'service_id')) {
    payload.service_id = PRODUCT_SERVICE;
  }
  if (await hasColumn('merchant_products', 'sub_category')) {
    payload.sub_category = subCategory;
  }
  if (await hasColumn('merchant_products', 'listing_mode')) {
    // لا نفرض listing_mode على صف تاجر قديم عند التعديل؛ للجديد فقط.
    if (!existing) {
      payload.listing_mode = CUSTOMER_PRODUCT_LISTING_MODE;
    } else if (!String(existing.listing_mode || '').trim()) {
      // اتركه فارغاً للمنتجات القديمة
    } else if (
      String(existing.listing_mode || '').trim() === CUSTOMER_PRODUCT_LISTING_MODE
    ) {
      payload.listing_mode = CUSTOMER_PRODUCT_LISTING_MODE;
    }
  }
  if (
    stock !== null &&
    Number.isFinite(stock) &&
    (await hasColumn('merchant_products', 'stock_quantity'))
  ) {
    payload.stock_quantity = stock;
  }
  if (await hasColumn('merchant_products', 'section_id')) {
    const sectionId = String(data.section_id ?? data.sectionId ?? 'general').trim();
    payload.section_id = sectionId || 'general';
  }

  Object.assign(payload, normalizeProductImagePayload(data));
  if (existing && !String(payload.image || '').trim()) {
    payload.image = existing.image ?? existing.image_url ?? '';
  }

  if (await hasColumn('merchant_products', 'is_approved')) {
    const contentChanged = shoppingContentChanged(existing, {
      ...data,
      name_ar: nameAr,
      description_ar: description,
      price,
      sub_category: subCategory,
    });
    if (!existing || contentChanged) {
      payload.is_approved = false;
      if (await hasColumn('merchant_products', 'approval_status')) {
        payload.approval_status = 'pending';
      }
    }
  }

  if (!existing) {
    payload.created_at = nowIso();
  }

  const saved = await saveRow('merchant_products', payload, 'id');

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:shopping-stores:');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {}

  return serializeProductRowForClient(saved);
}

async function listMyCustomerShoppingProducts(phone, options = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const subFilter = String(options.subCategoryId || options.sub_category || '').trim();

  const rows = await selectMany(
    'merchant_products',
    [],
    { column: 'updated_at', ascending: false },
    3000,
  );

  return (rows || [])
    .filter((row) => {
      if (!isShoppingProductRow(row)) return false;
      if (!variants.some((v) => phonesOverlap(row.phone, v))) return false;
      if (subFilter) {
        const sub = String(row.sub_category || row.subCategory || '').trim();
        if (sub && sub !== subFilter) return false;
      }
      return true;
    })
    .map((row) => serializeProductRowForClient(row));
}

async function hasMyCustomerShoppingStore(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const { getMerchantProfile } = require('./merchants');
  const profile = await getMerchantProfile(phoneKey);
  if (profile) {
    const serviceIds = Array.isArray(profile.service_ids)
      ? profile.service_ids.map(String)
      : [];
    const primary = String(profile.primary_service_id || '').trim();
    if (serviceIds.includes(PRODUCT_SERVICE) || primary === PRODUCT_SERVICE) {
      return true;
    }
  }
  const products = await listMyCustomerShoppingProducts(phoneKey);
  return products.length > 0;
}

async function deleteCustomerShoppingProduct(phone, productId) {
  const phoneKey = await resolvePhoneKey(phone);
  const id = String(productId || '').trim();
  if (!id) throw new Error('Product id is required.');

  const existing = await selectSingle('merchant_products', 'id', id);
  if (!existing) return { ok: true, deleted: false };
  if (!phonesOverlap(existing.phone, phoneKey)) {
    throw new Error('Unauthorized product delete.');
  }
  if (!isShoppingProductRow(existing)) {
    throw new Error('Not a shopping product.');
  }

  await deleteRow('merchant_products', 'id', id);
  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:shopping-stores:');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {}
  return { ok: true, deleted: true };
}

async function deleteCustomerShoppingStore(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const products = await listMyCustomerShoppingProducts(phoneKey);
  for (const row of products) {
    const id = String(row.id || '').trim();
    if (!id) continue;
    try {
      await deleteRow('merchant_products', 'id', id);
    } catch (error) {
      console.warn(
        'delete shopping product during store delete:',
        error?.message || error,
      );
    }
  }

  try {
    const { deleteMerchantServiceProfile } = require('./merchant_service_profiles');
    await deleteMerchantServiceProfile(phoneKey, PRODUCT_SERVICE, '');
  } catch (error) {
    console.warn('delete shopping service profile:', error?.message || error);
  }

  try {
    const { getMerchantProfile, saveMerchantProfile } = require('./merchants');
    const profile = (await getMerchantProfile(phoneKey)) || {};
    const ids = (Array.isArray(profile.service_ids) ? profile.service_ids : [])
      .map((id) => String(id).trim())
      .filter((id) => id && id !== PRODUCT_SERVICE);
    const patch = { service_ids: ids };
    if (String(profile.primary_service_id || '').trim() === PRODUCT_SERVICE) {
      patch.primary_service_id = ids[0] || null;
      patch.active_service_id = ids[0] || null;
    }
    await saveMerchantProfile(phoneKey, patch);
  } catch (error) {
    console.warn('cleanup shopping shell after delete:', error?.message || error);
  }

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:shopping-stores:');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {}

  return { ok: true, deleted: true, productsDeleted: products.length };
}

module.exports = {
  CUSTOMER_PRODUCT_LISTING_MODE,
  saveCustomerShoppingProduct,
  listMyCustomerShoppingProducts,
  hasMyCustomerShoppingStore,
  deleteCustomerShoppingProduct,
  deleteCustomerShoppingStore,
  ensureCustomerShoppingMerchantProfile,
};
