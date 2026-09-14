const { phonesOverlap, getPhoneVariants } = require('../supabase_repo/common');

/** مطابع مثبتة في قسم «مطابع وإعلانات». */
const EDEN_PRINTING_CATEGORY = 'eden_printing';

const EDEN_PRINTING_PINNED_STORES = [
  {
    id: 'jannat_aden',
    storeName: 'مطبعة جنة عدن',
    ownerPhone: '9647725053888',
  },
  {
    id: 'alghaith_ads',
    storeName: 'مطبعة طلب للأعلانات',
    ownerPhone: '9647705308114',
  },
  {
    id: 'abdullah_library',
    storeName: 'مكتبة عبدالله',
    ownerPhone: '9647744009992',
  },
];

/** @deprecated — استخدم resolveEdenPrintingStoreForPhone */
const EDEN_PRINTING_STORE_NAME = EDEN_PRINTING_PINNED_STORES[0].storeName;
/** @deprecated — استخدم resolveEdenPrintingStoreForPhone */
const EDEN_PRINTING_OWNER_PHONE = EDEN_PRINTING_PINNED_STORES[0].ownerPhone;

function isEdenPrintingCategory(category) {
  return String(category || '').trim() === EDEN_PRINTING_CATEGORY;
}

function resolveEdenPrintingStoreForPhone(phone) {
  return (
    EDEN_PRINTING_PINNED_STORES.find((store) =>
      store.ownerPhone && phonesOverlap(phone, store.ownerPhone)
    ) ?? null
  );
}

function isEdenPrintingOwnerPhone(phone) {
  return resolveEdenPrintingStoreForPhone(phone) != null;
}

function getEdenPrintingStoreNameForPhone(phone) {
  return resolveEdenPrintingStoreForPhone(phone)?.storeName ?? '';
}

function profileHasEdenPrintingService(profile) {
  if (!profile || typeof profile !== 'object') return false;
  const primary = String(profile.primary_service_id || '').trim();
  if (primary === EDEN_PRINTING_CATEGORY) return true;
  const serviceIds = profile.service_ids ?? profile.serviceIds;
  if (Array.isArray(serviceIds)) {
    return serviceIds
      .map((item) => String(item || '').trim())
      .includes(EDEN_PRINTING_CATEGORY);
  }
  const store = profile.store_data ?? profile.storeData;
  if (store && typeof store === 'object') {
    const storeIds = store.service_ids ?? store.serviceIds;
    if (Array.isArray(storeIds)) {
      return storeIds
        .map((item) => String(item || '').trim())
        .includes(EDEN_PRINTING_CATEGORY);
    }
  }
  return false;
}

function assertCanPublishEdenPrinting(phone, category, merchantProfile = null) {
  if (!isEdenPrintingCategory(category)) return;
  if (isEdenPrintingOwnerPhone(phone)) return;
  if (profileHasEdenPrintingService(merchantProfile)) return;
  const err = new Error('غير مصرح بالنشر في قسم المطابع والإعلانات.');
  err.code = 'EDEN_PRINTING_FORBIDDEN';
  throw err;
}

module.exports = {
  EDEN_PRINTING_CATEGORY,
  EDEN_PRINTING_STORE_NAME,
  EDEN_PRINTING_OWNER_PHONE,
  EDEN_PRINTING_PINNED_STORES,
  isEdenPrintingCategory,
  isEdenPrintingOwnerPhone,
  resolveEdenPrintingStoreForPhone,
  getEdenPrintingStoreNameForPhone,
  profileHasEdenPrintingService,
  assertCanPublishEdenPrinting,
  getPhoneVariants,
};
