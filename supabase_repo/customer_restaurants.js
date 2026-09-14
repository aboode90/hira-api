/**
 * نشر/تحديث مطعم أو كوفي من حساب الزبون — مستقل عن حساب التاجر.
 *
 * يحفظ في customer_restaurant_profiles (+ مرآة اختيارية لـ merchant_profiles
 * أثناء الانتقال فقط حتى تُقطع قائمة المطاعم للجدول الجديد).
 */

const {
  resolvePhoneKey,
  normalizeObject,
  nowIso,
  selectSingle,
  selectMany,
  saveRow,
  assertSupabaseAdmin,
} = require('./common');
const { ensureAppUser } = require('./users');
const { normalizeMerchantImageField } = require('../services/image_refs');

const RESTAURANT_SERVICE_ID = 'restaurant';
const ALLOWED_VENUES = new Set(['مطاعم', 'كوفيات']);
const RESTAURANT_CUISINES = new Set(['مشويات', 'وجبات سريعة']);
const MIRROR =
  String(process.env.CUSTOMER_RESTAURANTS_MIRROR_MERCHANT || '1').trim() !== '0';

function normalizeVenue(raw) {
  const value = String(raw ?? '').trim();
  if (value === 'مطاعم') return 'مطاعم';
  if (value === 'كوفيات' || value === 'مرطبات') return 'كوفيات';
  return '';
}

function restaurantIdForPhone(phone) {
  return `restaurant::${String(phone || '').trim()}`;
}

function serializeCustomerRestaurant(profile = {}) {
  const source = normalizeObject(profile) || {};
  const storeName = String(
    source.store_name || source.storeName || '',
  ).trim();
  return {
    phone: String(source.owner_phone || source.phone || '').trim(),
    id: source.id || null,
    store_name: storeName,
    storeName,
    description: String(source.description || '').trim(),
    restaurant_category:
      String(source.restaurant_category || source.restaurantCategory || '').trim(),
    restaurantCategory:
      String(source.restaurant_category || source.restaurantCategory || '').trim(),
    restaurant_cuisine:
      String(source.restaurant_cuisine || source.restaurantCuisine || source.service_sub_category || '').trim() ||
      null,
    restaurantCuisine:
      String(source.restaurant_cuisine || source.restaurantCuisine || source.service_sub_category || '').trim() ||
      null,
    service_sub_category:
      String(source.service_sub_category || source.restaurant_cuisine || '').trim() || null,
    address: String(source.address || '').trim(),
    latitude: source.latitude ?? null,
    longitude: source.longitude ?? null,
    whatsapp: String(source.whatsapp || '').trim(),
    open_time: String(source.open_time || source.openTime || '').trim(),
    close_time: String(source.close_time || source.closeTime || '').trim(),
    cover_image_url:
      String(source.cover_image_url || source.coverImageUrl || '').trim() || null,
    logo_image_url:
      String(source.logo_image_url || source.logoImageUrl || '').trim() || null,
    profile_image_base64:
      String(source.profile_image_base64 || source.profileImageBase64 || '').trim() ||
      null,
    is_open: source.is_open !== false,
    is_approved: Boolean(source.is_approved),
    approval_status:
      String(source.approval_status || 'pending').trim() || 'pending',
    is_frozen: Boolean(source.is_frozen),
  };
}

async function getCustomerRestaurantProfile(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const id = restaurantIdForPhone(phoneKey);
  try {
    const byId = await selectSingle('customer_restaurant_profiles', 'id', id);
    if (byId) return byId;
    const byPhone = await selectMany(
      'customer_restaurant_profiles',
      [{ method: 'eq', column: 'owner_phone', value: phoneKey }],
      null,
      1,
    );
    return byPhone[0] || null;
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return null;
    }
    throw error;
  }
}

async function upsertCustomerRestaurantProfile(phoneKey, payload) {
  const id = restaurantIdForPhone(phoneKey);
  const row = {
    id,
    owner_phone: phoneKey,
    store_name: payload.store_name,
    description: payload.description || '',
    address: payload.address || '',
    restaurant_category: payload.restaurant_category,
    restaurant_cuisine: payload.restaurant_cuisine || null,
    service_sub_category: payload.service_sub_category || null,
    whatsapp: payload.whatsapp || phoneKey,
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
    legacy_phone: phoneKey,
    migrated_from: 'merchant_profiles',
    updated_at: nowIso(),
    created_at: payload.created_at || nowIso(),
  };
  const saved = await saveRow('customer_restaurant_profiles', row, 'id');
  return saved || row;
}

async function saveCustomerRestaurant(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  await ensureAppUser(phoneKey, data);

  const name = String(
    data.name ?? data.store_name ?? data.storeName ?? '',
  ).trim();
  if (!name) throw new Error('أدخل اسم المطعم أو المنشأة.');

  const venue = normalizeVenue(data.restaurantCategory ?? data.restaurant_category);
  if (!venue) {
    throw new Error('اختر نوع المنشأة (مطاعم أو كوفيات).');
  }

  let cuisine = String(
    data.restaurantCuisine ??
      data.restaurant_cuisine ??
      data.serviceSubCategory ??
      data.service_sub_category ??
      '',
  ).trim();
  if (venue === 'مطاعم') {
    if (cuisine && !RESTAURANT_CUISINES.has(cuisine)) {
      throw new Error('اختر تخصص المطبخ (مشويات أو وجبات سريعة).');
    }
  } else {
    cuisine = '';
  }

  const address = String(data.address ?? '').trim();
  if (!address) throw new Error('أدخل عنوان المنشأة.');

  const existing = (await getCustomerRestaurantProfile(phoneKey)) || {};

  // fallback قراءة قديمة إن لم يُرحَّل بعد
  let legacy = {};
  if (!existing.id) {
    try {
      const { getMerchantProfile } = require('./merchants');
      const { getMerchantServiceProfile } = require('./merchant_service_profiles');
      legacy = {
        ...((await getMerchantProfile(phoneKey)) || {}),
        ...((await getMerchantServiceProfile(phoneKey, RESTAURANT_SERVICE_ID, '')) || {}),
      };
    } catch (_) {}
  }

  const base = existing.id ? existing : legacy;

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

  const payload = {
    store_name: name,
    description,
    address,
    restaurant_category: venue,
    restaurant_cuisine: cuisine || null,
    service_sub_category: cuisine || null,
    whatsapp: String(data.whatsapp ?? phoneKey).trim(),
    open_time: String(data.openTime ?? data.open_time ?? base.open_time ?? '').trim(),
    close_time: String(data.closeTime ?? data.close_time ?? base.close_time ?? '').trim(),
    latitude: data.latitude ?? data.lat ?? base.latitude ?? null,
    longitude: data.longitude ?? data.lng ?? base.longitude ?? null,
    is_open: data.isOpen ?? data.is_open ?? true,
    is_approved: wasApproved ? true : false,
    approval_status: wasApproved ? 'approved' : 'pending',
    is_frozen: Boolean(base.is_frozen),
    created_at: base.created_at || nowIso(),
  };

  if (coverRef.url) payload.cover_image_url = coverRef.url;
  else if (base.cover_image_url) payload.cover_image_url = base.cover_image_url;
  if (logoRef.url) payload.logo_image_url = logoRef.url;
  else if (base.logo_image_url) payload.logo_image_url = base.logo_image_url;

  let saved;
  try {
    saved = await upsertCustomerRestaurantProfile(phoneKey, payload);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      console.warn(
        'customer_restaurant_profiles missing — apply 20260902_customer_publish_decoupling.sql',
      );
      // لا ننشئ حساب تاجر بعد الآن — نرمي خطأ واضح.
      throw new Error(
        'جدول مطاعم الزبون غير مفعّل بعد. طبّق ترحيل supabase/20260902_customer_publish_decoupling.sql',
      );
    }
    throw error;
  }

  // مرآة اختيارية فقط — بدون ضبط primary_service_id كتاجر رئيسي جديد إن أمكن.
  if (MIRROR) {
    try {
      const { saveMerchantProfile, getMerchantProfile } = require('./merchants');
      const existingProfile = (await getMerchantProfile(phoneKey)) || {};
      const serviceIdsRaw = Array.isArray(existingProfile.service_ids)
        ? existingProfile.service_ids.map((id) => String(id).trim()).filter(Boolean)
        : [];
      const nextServiceIds = serviceIdsRaw.includes(RESTAURANT_SERVICE_ID)
        ? serviceIdsRaw
        : [...serviceIdsRaw, RESTAURANT_SERVICE_ID];
      await saveMerchantProfile(phoneKey, {
        store_name: name,
        description,
        address,
        restaurant_category: venue,
        restaurant_cuisine: cuisine || null,
        service_sub_category: cuisine || null,
        whatsapp: payload.whatsapp,
        open_time: payload.open_time,
        close_time: payload.close_time,
        latitude: payload.latitude,
        longitude: payload.longitude,
        cover_image_url: payload.cover_image_url,
        logo_image_url: payload.logo_image_url,
        is_open: payload.is_open,
        service_ids: nextServiceIds,
        allowCustomerRestaurant: true,
        // لا نفرض primary_service_id=restaurant إذا كان للتاجر خدمة أخرى.
        ...(existingProfile.primary_service_id
          ? {}
          : {
              primary_service_id: RESTAURANT_SERVICE_ID,
              active_service_id: RESTAURANT_SERVICE_ID,
            }),
      });
    } catch (error) {
      console.warn('restaurant merchant mirror skipped:', error?.message || error);
    }
  }

  try {
    const { invalidateCache, invalidateCachePrefix } = require('../lib/response_cache');
    await Promise.all([
      invalidateCachePrefix('marketplace:shopping-stores:'),
      invalidateCachePrefix('marketplace:restaurant-stores:'),
      invalidateCache('marketplace:stats'),
    ]);
  } catch (_) {}

  return serializeCustomerRestaurant(saved);
}

async function getMyCustomerRestaurant(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const row = await getCustomerRestaurantProfile(phoneKey);
  if (row) return serializeCustomerRestaurant(row);

  // fallback قديم
  try {
    const { getMerchantProfile } = require('./merchants');
    const { getMerchantServiceProfile } = require('./merchant_service_profiles');
    const profile = (await getMerchantProfile(phoneKey)) || {};
    const serviceRow =
      (await getMerchantServiceProfile(phoneKey, RESTAURANT_SERVICE_ID, '')) || {};
    const serviceIds = Array.isArray(profile.service_ids)
      ? profile.service_ids.map(String)
      : [];
    const hasRestaurant =
      serviceIds.includes(RESTAURANT_SERVICE_ID) ||
      String(profile.primary_service_id || '').trim() === RESTAURANT_SERVICE_ID;
    if (!hasRestaurant) return null;
    return serializeCustomerRestaurant({ ...profile, ...serviceRow, owner_phone: phoneKey });
  } catch (_) {
    return null;
  }
}

async function listCustomerRestaurantStores({ subCategoryId = '', compact = false } = {}) {
  try {
    const rows = await selectMany(
      'customer_restaurant_profiles',
      [
        { method: 'eq', column: 'is_open', value: true },
        { method: 'eq', column: 'is_frozen', value: false },
      ],
      { column: 'updated_at', ascending: false },
      2000,
    );
    const target = String(subCategoryId || '').trim();
    return (rows || [])
      .filter((row) => {
        if (!target) return true;
        const venue = String(row.restaurant_category || '').trim();
        const cuisine = String(
          row.restaurant_cuisine || row.service_sub_category || '',
        ).trim();
        if (venue === target || cuisine === target) return true;
        if (target === 'كوفيات' && venue === 'مرطبات') return true;
        if (
          target === 'مخابز ومعجنات' &&
          (venue === 'bakery' || cuisine === 'bakery')
        ) {
          return true;
        }
        return false;
      })
      .map((row) => {
        const serialized = serializeCustomerRestaurant(row);
        const profile = {
          phone: serialized.phone,
          store_name: serialized.store_name,
          storeName: serialized.storeName,
          description: serialized.description,
          restaurant_category: serialized.restaurant_category,
          restaurantCategory: serialized.restaurantCategory,
          restaurant_cuisine: serialized.restaurant_cuisine,
          restaurantCuisine: serialized.restaurantCuisine,
          service_sub_category: serialized.service_sub_category,
          address: serialized.address,
          whatsapp: serialized.whatsapp,
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
          primary_service_id: RESTAURANT_SERVICE_ID,
          service_ids: [RESTAURANT_SERVICE_ID],
          source: 'customer_restaurant',
        };
        // نفس شكل متاجر التاجر حتى لا ينهار تطبيق الزبون عند قراءة store['profile'].
        return {
          profile,
          products: [],
          productCount: 0,
          hasRestaurantProducts: true,
          compact: Boolean(compact),
          source: 'customer_restaurant',
          // حقول مختصرة للتوافق مع أي قارئ قديم يتوقع المستوى الأعلى.
          phone: serialized.phone,
          storeName: serialized.storeName,
          restaurantCategory: serialized.restaurantCategory,
          restaurantCuisine: serialized.restaurantCuisine,
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
    throw error;
  }
}

async function deleteCustomerRestaurant(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const {
    deleteRow,
    getPhoneVariants,
    phonesOverlap,
    selectMany,
  } = require('./common');

  const existing = await getCustomerRestaurantProfile(phoneKey);
  if (existing?.id) {
    try {
      await deleteRow('customer_restaurant_profiles', 'id', existing.id);
    } catch (error) {
      if (!/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
        throw error;
      }
    }
  } else {
    try {
      await deleteRow(
        'customer_restaurant_profiles',
        'id',
        restaurantIdForPhone(phoneKey),
      );
    } catch (_) {}
  }

  // احذف منتجات/منيو المطعم لهذا الرقم.
  try {
    const variants = getPhoneVariants(phoneKey);
    const products = await selectMany(
      'merchant_products',
      [],
      { column: 'created_at', ascending: false },
      3000,
    );
    for (const row of products || []) {
      const cat = String(row.category || row.service_id || '').trim();
      if (cat !== RESTAURANT_SERVICE_ID) continue;
      if (!variants.some((v) => phonesOverlap(row.phone, v))) continue;
      const id = String(row.id || '').trim();
      if (id) await deleteRow('merchant_products', 'id', id);
    }
  } catch (error) {
    console.warn('delete restaurant products:', error?.message || error);
  }

  try {
    const { deleteMerchantServiceProfile } = require('./merchant_service_profiles');
    await deleteMerchantServiceProfile(phoneKey, RESTAURANT_SERVICE_ID, '');
  } catch (error) {
    console.warn('delete restaurant service profile:', error?.message || error);
  }

  try {
    const { getMerchantProfile, saveMerchantProfile } = require('./merchants');
    const profile = (await getMerchantProfile(phoneKey)) || {};
    const ids = (Array.isArray(profile.service_ids) ? profile.service_ids : [])
      .map((id) => String(id).trim())
      .filter((id) => id && id !== RESTAURANT_SERVICE_ID);
    const patch = {
      service_ids: ids,
      allowCustomerRestaurant: true,
    };
    if (String(profile.primary_service_id || '').trim() === RESTAURANT_SERVICE_ID) {
      patch.primary_service_id = ids[0] || null;
      patch.active_service_id = ids[0] || null;
    }
    await saveMerchantProfile(phoneKey, patch);
  } catch (error) {
    console.warn('cleanup restaurant shell after delete:', error?.message || error);
  }

  try {
    const { invalidateCachePrefix } = require('../lib/response_cache');
    await invalidateCachePrefix('marketplace:');
  } catch (_) {}

  return { ok: true, deleted: true };
}

module.exports = {
  RESTAURANT_SERVICE_ID,
  ALLOWED_VENUES,
  RESTAURANT_CUISINES,
  normalizeVenue,
  saveCustomerRestaurant,
  getMyCustomerRestaurant,
  serializeCustomerRestaurant,
  listCustomerRestaurantStores,
  getCustomerRestaurantProfile,
  deleteCustomerRestaurant,
};
