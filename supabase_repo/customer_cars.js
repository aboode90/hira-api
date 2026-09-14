/**
 * إعلانات بيع السيارات من الزبون — نفس جدول المنتجات، بدون حذف بيانات المعارض القديمة.
 * تظهر في «شراء سيارة» مع إعلانات التجار السابقة (sub_category = car_sell).
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
  deleteRow,
} = require('./common');
const { ensureAppUser } = require('./users');
const {
  normalizeProductImagePayload,
  serializeProductRowForClient,
} = require('../services/image_refs');

const CUSTOMER_CAR_LISTING_MODE = 'customer_car';
const CAR_SELL_SUB = 'car_sell';

function encodeCarDescription({ year, color, payment, description }) {
  const lines = [];
  const y = String(year || '').trim();
  const c = String(color || '').trim();
  const p = String(payment || '').trim();
  const d = String(description || '').trim();
  if (y) lines.push(`السنة: ${y}`);
  if (c) lines.push(`اللون: ${c}`);
  if (p) lines.push(`طريقة البيع: ${p}`);
  if (d) {
    if (lines.length) lines.push('');
    lines.push(d);
  }
  return lines.join('\n').trim();
}

function parseCarDescription(raw) {
  const text = String(raw || '').trim();
  let year = '';
  let color = '';
  let payment = '';
  const body = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (body.length) body.push('');
      continue;
    }
    const yearMatch = trimmed.match(/^السنة\s*:\s*(.+)$/i);
    if (yearMatch) {
      year = yearMatch[1].trim();
      continue;
    }
    const colorMatch = trimmed.match(/^اللون\s*:\s*(.+)$/i);
    if (colorMatch) {
      color = colorMatch[1].trim();
      continue;
    }
    const payMatch = trimmed.match(/^طريقة البيع\s*:\s*(.+)$/i);
    if (payMatch) {
      payment = payMatch[1].trim();
      continue;
    }
    body.push(trimmed);
  }
  return {
    year,
    color,
    payment,
    description: body.join('\n').trim(),
  };
}

function isCustomerOrOwnedCarSellRow(row, phoneKey) {
  if (!row) return false;
  const category = String(row.category || row.service_id || '').trim();
  if (category !== 'cars') return false;
  const sub = String(row.sub_category || row.subCategory || '').trim();
  if (sub !== CAR_SELL_SUB && sub !== 'car_buy') return false;
  return phonesOverlap(row.phone || row.owner_phone, phoneKey);
}

function carListingContentChanged(existing, data) {
  if (!existing) return true;
  const fields = [
    ['name_ar', 'nameAr'],
    ['description_ar', 'descriptionAr'],
    ['price', 'price'],
    ['address', 'address'],
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

async function saveCustomerCarListing(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);

  const nameAr = String(data.name_ar ?? data.nameAr ?? '').trim();
  if (!nameAr) throw new Error('أدخل نوع السيارة.');

  const address = String(data.address ?? data.car_location ?? data.carLocation ?? '').trim();
  if (!address) throw new Error('أدخل مكان السيارة.');

  const priceRaw = data.price;
  const price = Number.parseInt(String(priceRaw ?? '0').replace(/,/g, ''), 10);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('أدخل سعر السيارة بالدولار.');
  }

  const year = String(data.car_year ?? data.carYear ?? data.year ?? '').trim();
  if (!year) throw new Error('أدخل موديل السيارة (السنة).');

  const color = String(data.car_color ?? data.carColor ?? data.color ?? '').trim();
  if (!color) throw new Error('أدخل لون السيارة.');

  const payment = String(
    data.payment_method ?? data.paymentMethod ?? 'نقداً',
  ).trim() || 'نقداً';

  const userDescription = String(
    data.description_ar ?? data.descriptionAr ?? data.description ?? '',
  ).trim();

  const description = encodeCarDescription({
    year,
    color,
    payment,
    description: userDescription,
  });

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
      throw new Error('Unauthorized car listing update.');
    }
    const cat = String(existing.category || '').trim();
    if (cat && cat !== 'cars') {
      throw new Error('Not a car listing.');
    }
  }

  const contactPhone = String(
    data.contact_phone ?? data.contactPhone ?? phoneKey,
  )
    .trim()
    .replace(/\s+/g, '');
  const resolvedContact = contactPhone || phoneKey;
  const publisherName = String(
    data.publisher_name ?? data.publisherName ?? data.display_name ?? '',
  ).trim();

  const payload = {
    id: productId,
    phone: phoneKey,
    updated_at: nowIso(),
    category: 'cars',
    name_ar: nameAr,
    name_en: String(data.name_en ?? data.nameEn ?? nameAr).trim() || nameAr,
    description_ar: description,
    description_en: description,
    price,
    is_available: true,
    address,
  };

  if (await hasColumn('merchant_products', 'merchant_user_id')) {
    payload.merchant_user_id = appUser?.id || null;
  }
  if (await hasColumn('merchant_products', 'service_id')) {
    payload.service_id = 'cars';
  }
  if (await hasColumn('merchant_products', 'sub_category')) {
    payload.sub_category = CAR_SELL_SUB;
  }
  if (await hasColumn('merchant_products', 'listing_mode')) {
    payload.listing_mode = CUSTOMER_CAR_LISTING_MODE;
  }
  if (await hasColumn('merchant_products', 'avg_price_label_ar')) {
    payload.avg_price_label_ar = 'سعر البيع';
  }
  if (await hasColumn('merchant_products', 'avg_price_label_en')) {
    payload.avg_price_label_en = 'Selling Price';
  }
  if (await hasColumn('merchant_products', 'action_label_en')) {
    payload.action_label_en = resolvedContact;
  }
  if (await hasColumn('merchant_products', 'action_label_ar')) {
    payload.action_label_ar = publisherName || 'تواصل';
  }
  if (await hasColumn('merchant_products', 'category_label_ar')) {
    payload.category_label_ar = 'بيع سيارة';
  }
  if (await hasColumn('merchant_products', 'category_label_en')) {
    payload.category_label_en = 'Sell Car';
  }

  Object.assign(payload, normalizeProductImagePayload(data));
  if (existing && !String(payload.image || '').trim()) {
    payload.image = existing.image ?? existing.image_url ?? '';
  }

  if (await hasColumn('merchant_products', 'is_approved')) {
    const contentChanged = carListingContentChanged(existing, {
      ...data,
      description_ar: description,
      address,
      price,
      name_ar: nameAr,
    });
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

  const saved = await saveRow('merchant_products', payload, 'id');
  if (!saved) throw new Error('Failed to save car listing.');

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {
    // ignore
  }

  const serialized = serializeProductRowForClient(saved);
  const parsed = parseCarDescription(serialized.description_ar || description);
  return {
    ...serialized,
    car_year: parsed.year || year,
    car_color: parsed.color || color,
    payment_method: parsed.payment || payment,
    description_plain: parsed.description || userDescription,
    contact_phone: resolvedContact,
    listing_source: 'customer',
  };
}

async function listMyCustomerCarListings(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const rows = await selectMany(
    'merchant_products',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'category', value: 'cars' },
    ],
    { column: 'updated_at', ascending: false },
    200,
  );

  return (rows || [])
    .filter((row) => isCustomerOrOwnedCarSellRow(row, phoneKey))
    .map((row) => {
      const serialized = serializeProductRowForClient(row);
      const parsed = parseCarDescription(
        row.description_ar || row.descriptionAr || '',
      );
      return {
        ...serialized,
        car_year: parsed.year,
        car_color: parsed.color,
        payment_method: parsed.payment,
        description_plain: parsed.description,
        listing_source:
          String(row.listing_mode || '').trim() === CUSTOMER_CAR_LISTING_MODE
            ? 'customer'
            : 'merchant',
        contact_phone:
          String(row.action_label_en || '').trim() ||
          String(row.phone || '').trim(),
      };
    });
}

async function deleteCustomerCarListing(phone, listingId) {
  const phoneKey = await resolvePhoneKey(phone);
  const id = String(listingId || '').trim();
  if (!id) throw new Error('Listing id is required.');
  const existing = await selectSingle('merchant_products', 'id', id);
  if (!existing) return { success: true };
  if (!isCustomerOrOwnedCarSellRow(existing, phoneKey)) {
    throw new Error('Unauthorized car listing delete.');
  }
  await deleteRow('merchant_products', 'id', id);
  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {
    // ignore
  }
  return { success: true };
}

const CUSTOMER_CAR_REQUEST_LISTING_MODE = 'customer_car_request';
const CAR_REQUEST_SUBS = new Set([
  'car_4seat',
  'car_starx11',
  'car_truck',
  'car_bus',
]);

function isCustomerOrOwnedCarRequestRow(row, phoneKey) {
  if (!row) return false;
  const category = String(row.category || row.service_id || '').trim();
  if (category !== 'cars') return false;
  const sub = String(row.sub_category || row.subCategory || '').trim();
  if (!CAR_REQUEST_SUBS.has(sub)) return false;
  return phonesOverlap(row.phone || row.owner_phone, phoneKey);
}

async function saveCustomerCarRequestListing(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);

  const subCategory = String(
    data.sub_category ?? data.subCategory ?? data.request_type ?? '',
  ).trim();
  if (!CAR_REQUEST_SUBS.has(subCategory)) {
    throw new Error('اختر نوع طلب السيارة.');
  }

  const nameAr = String(data.name_ar ?? data.nameAr ?? '').trim();
  if (!nameAr) throw new Error('أدخل نوع السيارة.');

  const address = String(
    data.address ?? data.car_location ?? data.carLocation ?? '',
  ).trim();
  if (!address) throw new Error('أدخل مكان السيارة.');

  const year = String(data.car_year ?? data.carYear ?? data.year ?? '').trim();
  if (!year) throw new Error('أدخل موديل السيارة (السنة).');

  const color = String(data.car_color ?? data.carColor ?? data.color ?? '').trim();
  if (!color) throw new Error('أدخل لون السيارة.');

  const userDescription = String(
    data.description_ar ?? data.descriptionAr ?? data.description ?? '',
  ).trim();

  const description = encodeCarDescription({
    year,
    color,
    payment: '',
    description: userDescription,
  });

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
      throw new Error('Unauthorized car request update.');
    }
    const cat = String(existing.category || '').trim();
    if (cat && cat !== 'cars') {
      throw new Error('Not a car request listing.');
    }
  }

  const contactPhone = String(
    data.contact_phone ?? data.contactPhone ?? phoneKey,
  )
    .trim()
    .replace(/\s+/g, '');
  const resolvedContact = contactPhone || phoneKey;
  const publisherName = String(
    data.publisher_name ?? data.publisherName ?? data.display_name ?? '',
  ).trim();

  const typeTitle =
    {
      car_4seat: 'سيارة 4 راكب',
      car_starx11: 'سيارة 11 راكب',
      car_truck: 'سيارة حمل',
      car_bus: 'باص',
    }[subCategory] || 'طلب سيارة أجرة';

  const payload = {
    id: productId,
    phone: phoneKey,
    updated_at: nowIso(),
    category: 'cars',
    name_ar: nameAr,
    name_en: String(data.name_en ?? data.nameEn ?? nameAr).trim() || nameAr,
    description_ar: description,
    description_en: description,
    price: 0,
    is_available: true,
    address,
  };

  if (await hasColumn('merchant_products', 'merchant_user_id')) {
    payload.merchant_user_id = appUser?.id || null;
  }
  if (await hasColumn('merchant_products', 'service_id')) {
    payload.service_id = 'cars';
  }
  if (await hasColumn('merchant_products', 'sub_category')) {
    payload.sub_category = subCategory;
  }
  if (await hasColumn('merchant_products', 'listing_mode')) {
    payload.listing_mode = CUSTOMER_CAR_REQUEST_LISTING_MODE;
  }
  if (await hasColumn('merchant_products', 'avg_price_label_ar')) {
    payload.avg_price_label_ar = 'تواصل';
  }
  if (await hasColumn('merchant_products', 'avg_price_label_en')) {
    payload.avg_price_label_en = 'Contact';
  }
  if (await hasColumn('merchant_products', 'action_label_en')) {
    payload.action_label_en = resolvedContact;
  }
  if (await hasColumn('merchant_products', 'action_label_ar')) {
    payload.action_label_ar = publisherName || 'تواصل';
  }
  if (await hasColumn('merchant_products', 'category_label_ar')) {
    payload.category_label_ar = typeTitle;
  }
  if (await hasColumn('merchant_products', 'category_label_en')) {
    payload.category_label_en = typeTitle;
  }

  Object.assign(payload, normalizeProductImagePayload(data));
  if (existing && !String(payload.image || '').trim()) {
    payload.image = existing.image ?? existing.image_url ?? '';
  }

  if (await hasColumn('merchant_products', 'is_approved')) {
    const contentChanged = carListingContentChanged(existing, {
      ...data,
      description_ar: description,
      address,
      price: 0,
      name_ar: nameAr,
      sub_category: subCategory,
    });
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

  const saved = await saveRow('merchant_products', payload, 'id');
  if (!saved) throw new Error('Failed to save car request listing.');

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {
    // ignore
  }

  const serialized = serializeProductRowForClient(saved);
  const parsed = parseCarDescription(serialized.description_ar || description);
  return {
    ...serialized,
    car_year: parsed.year || year,
    car_color: parsed.color || color,
    description_plain: parsed.description || userDescription,
    contact_phone: resolvedContact,
    listing_source: 'customer',
  };
}

async function listMyCustomerCarRequestListings(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const rows = await selectMany(
    'merchant_products',
    [
      { method: 'in', column: 'phone', value: variants },
      { method: 'eq', column: 'category', value: 'cars' },
    ],
    { column: 'updated_at', ascending: false },
    200,
  );

  return (rows || [])
    .filter((row) => isCustomerOrOwnedCarRequestRow(row, phoneKey))
    .map((row) => {
      const serialized = serializeProductRowForClient(row);
      const parsed = parseCarDescription(
        row.description_ar || row.descriptionAr || '',
      );
      return {
        ...serialized,
        car_year: parsed.year,
        car_color: parsed.color,
        description_plain: parsed.description,
        listing_source:
          String(row.listing_mode || '').trim() ===
          CUSTOMER_CAR_REQUEST_LISTING_MODE
            ? 'customer'
            : 'merchant',
        contact_phone:
          String(row.action_label_en || '').trim() ||
          String(row.phone || '').trim(),
      };
    });
}

async function deleteCustomerCarRequestListing(phone, listingId) {
  const phoneKey = await resolvePhoneKey(phone);
  const id = String(listingId || '').trim();
  if (!id) throw new Error('Listing id is required.');
  const existing = await selectSingle('merchant_products', 'id', id);
  if (!existing) return { success: true };
  if (!isCustomerOrOwnedCarRequestRow(existing, phoneKey)) {
    throw new Error('Unauthorized car request delete.');
  }
  await deleteRow('merchant_products', 'id', id);
  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:catalog-products:');
  } catch (_) {
    // ignore
  }
  return { success: true };
}

module.exports = {
  CUSTOMER_CAR_LISTING_MODE,
  CUSTOMER_CAR_REQUEST_LISTING_MODE,
  encodeCarDescription,
  parseCarDescription,
  saveCustomerCarListing,
  listMyCustomerCarListings,
  deleteCustomerCarListing,
  saveCustomerCarRequestListing,
  listMyCustomerCarRequestListings,
  deleteCustomerCarRequestListing,
};
