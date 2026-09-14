#!/usr/bin/env node
// LEGACY — bazaar removed from Talab app
/**
 * يسجّل مطعم الكفيل (07844258400) مع الأقسام والمنتجات.
 * التشغيل من backend/:
 *   node scripts/upsert_kafeel_restaurant.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  resolvePhoneKey,
  getPhoneVariants,
  assertSupabaseAdmin,
} = require('../supabase_repo/common');
const {
  getMerchantProfile,
  saveMerchantProfile,
  saveMerchantProduct,
} = require('../supabase_repo/merchants');
const {
  getAppUser,
  saveAppUser,
  ensureAppUser,
  saveUserState,
  getUserState,
} = require('../supabase_repo/users');

const PHONE = '07844258400';
const STORE_NAME = 'مطعم الكفيل';
const ADDRESS = 'الصويرة . الشارع العام . بازار ومطاعم طلب';
const LAT = 32.9488919;
const LNG = 44.7766857;

const SECTIONS = [
  { id: 'kafeel_breakfast', name_ar: 'فطور', nameAr: 'فطور', sort_order: 0, sortOrder: 0 },
  { id: 'kafeel_lunch', name_ar: 'غداء', nameAr: 'غداء', sort_order: 1, sortOrder: 1 },
  { id: 'kafeel_dinner', name_ar: 'عشاء', nameAr: 'عشاء', sort_order: 2, sortOrder: 2 },
  { id: 'kafeel_sides', name_ar: 'مقبلات', nameAr: 'مقبلات', sort_order: 3, sortOrder: 3 },
];

const PRODUCTS = [
  // فطور
  { id: 'kafeel_bf_01', section_id: 'kafeel_breakfast', name_ar: 'باقلاء بالدهن الحر', price: 2000 },
  { id: 'kafeel_bf_02', section_id: 'kafeel_breakfast', name_ar: 'باقلاء بالدهن الحر مع بيض', price: 3000 },
  { id: 'kafeel_bf_03', section_id: 'kafeel_breakfast', name_ar: 'شوربة عدس', price: 1500 },
  { id: 'kafeel_bf_04', section_id: 'kafeel_breakfast', name_ar: 'مخلمة لحم + بيض', price: 2000 },
  { id: 'kafeel_bf_05', section_id: 'kafeel_breakfast', name_ar: 'كبة برغل', price: 3000 },
  { id: 'kafeel_bf_06', section_id: 'kafeel_breakfast', name_ar: 'بيض سلق', price: 1000 },
  { id: 'kafeel_bf_07', section_id: 'kafeel_breakfast', name_ar: 'بيض بالدهن الحر', price: 1500 },
  { id: 'kafeel_bf_08', section_id: 'kafeel_breakfast', name_ar: 'عروك + بيض', price: 2000 },
  // غداء
  { id: 'kafeel_ln_01', section_id: 'kafeel_lunch', name_ar: 'رز + مرق', price: 2000 },
  { id: 'kafeel_ln_02', section_id: 'kafeel_lunch', name_ar: 'فاصوليا - تبسي - بامية', price: 2000 },
  { id: 'kafeel_ln_03', section_id: 'kafeel_lunch', name_ar: 'تشريب لحم + رز', price: 5000 },
  { id: 'kafeel_ln_04', section_id: 'kafeel_lunch', name_ar: 'تشريب دجاج + رز', price: 5000 },
  { id: 'kafeel_ln_05', section_id: 'kafeel_lunch', name_ar: 'كبة برغل + رز', price: 4000 },
  { id: 'kafeel_ln_06', section_id: 'kafeel_lunch', name_ar: 'سمج مقلي + رز', price: 5000 },
  // عشاء
  { id: 'kafeel_dn_01', section_id: 'kafeel_dinner', name_ar: 'طبق مشكل مقالي (بطاطا + باذنجان + فلافل)', price: 2000 },
  { id: 'kafeel_dn_02', section_id: 'kafeel_dinner', name_ar: 'طبق تتوني', price: 5000 },
  { id: 'kafeel_dn_03', section_id: 'kafeel_dinner', name_ar: 'سندويج تتوني', price: 2500 },
  { id: 'kafeel_dn_04', section_id: 'kafeel_dinner', name_ar: 'أنواع مخلمة', price: 2000 },
  { id: 'kafeel_dn_05', section_id: 'kafeel_dinner', name_ar: 'كبة مقلية', price: 1500 },
  { id: 'kafeel_dn_06', section_id: 'kafeel_dinner', name_ar: 'شوربة عدس', price: 1500 },
  // مقبلات
  { id: 'kafeel_sd_01', section_id: 'kafeel_sides', name_ar: 'مقبلات صغير', price: 1500 },
  { id: 'kafeel_sd_02', section_id: 'kafeel_sides', name_ar: 'مقبلات وسط', price: 3000 },
  { id: 'kafeel_sd_03', section_id: 'kafeel_sides', name_ar: 'طبق مقبلات كبير', price: 5000 },
];

async function main() {
  assertSupabaseAdmin();
  const phoneKey = await resolvePhoneKey(PHONE);
  console.log('phoneKey:', phoneKey);
  console.log('variants:', getPhoneVariants(phoneKey));

  await ensureAppUser(phoneKey, {
    role: 'merchant',
    account_type: 'marketplace',
    full_name: STORE_NAME,
  });
  await saveAppUser(phoneKey, {
    role: 'merchant',
    account_type: 'marketplace',
    full_name: STORE_NAME,
  });

  const existing = await getMerchantProfile(phoneKey);
  console.log(
    existing
      ? `existing merchant: ${existing.store_name}`
      : 'no merchant profile yet',
  );

  const saved = await saveMerchantProfile(phoneKey, {
    store_name: STORE_NAME,
    name: STORE_NAME,
    description: 'مطعم — فطور وغداء وعشاء ومقبلات',
    address: ADDRESS,
    latitude: LAT,
    longitude: LNG,
    lat: LAT,
    lng: LNG,
    primary_service_id: 'restaurant',
    service_ids: ['restaurant'],
    active_service_id: 'restaurant',
    restaurant_category: 'مطاعم',
    product_sections: SECTIONS,
    productSections: SECTIONS,
    whatsapp: PHONE,
    show_phone_to_customers: true,
    show_whatsapp_to_customers: true,
    is_open: true,
    isOpen: true,
    is_approved: true,
    isApproved: true,
    approval_status: 'approved',
    is_bazaar_member: true,
    isBazaarMember: true,
    _adminModerationBypass: true,
  });

  const currentState = (await getUserState(phoneKey)) || {};
  const currentStore = currentState.merchantStore || {};
  await saveUserState(phoneKey, {
    userRole: 'merchant',
    accountType: 'marketplace',
    merchantProfileComplete: true,
    merchantStore: {
      ...currentStore,
      name: STORE_NAME,
      store_name: STORE_NAME,
      storeName: STORE_NAME,
      description: 'مطعم — فطور وغداء وعشاء ومقبلات',
      address: ADDRESS,
      phone: phoneKey,
      whatsapp: PHONE,
      latitude: LAT,
      longitude: LNG,
      lat: LAT,
      lng: LNG,
      primary_service_id: 'restaurant',
      primaryServiceId: 'restaurant',
      service_ids: ['restaurant'],
      serviceIds: ['restaurant'],
      active_service_id: 'restaurant',
      activeServiceId: 'restaurant',
      restaurant_category: 'مطاعم',
      restaurantCategory: 'مطاعم',
      product_sections: SECTIONS,
      productSections: SECTIONS,
      is_open: true,
      isOpen: true,
      is_approved: true,
      isApproved: true,
      is_bazaar_member: true,
      isBazaarMember: true,
    },
  });

  console.log('profile saved:', {
    phone: saved?.phone,
    store_name: saved?.store_name,
    primary_service_id: saved?.primary_service_id,
    sections: (saved?.product_sections || SECTIONS).map((s) => s.name_ar || s.nameAr),
    is_approved: saved?.is_approved,
  });

  let ok = 0;
  for (const item of PRODUCTS) {
    await saveMerchantProduct(
      phoneKey,
      {
        id: item.id,
        name_ar: item.name_ar,
        nameAr: item.name_ar,
        name_en: item.name_ar,
        description_ar: '',
        description_en: '',
        price: item.price,
        category: 'restaurant',
        service_id: 'restaurant',
        serviceId: 'restaurant',
        section_id: item.section_id,
        sectionId: item.section_id,
        image: '',
        is_available: true,
        isAvailable: true,
        is_approved: true,
        isApproved: true,
        approval_status: 'approved',
      },
      { adminSave: true },
    );
    ok += 1;
    console.log(`  ✓ [${item.section_id}] ${item.name_ar} — ${item.price}`);
  }

  const supabase = assertSupabaseAdmin();
  const { data: listed, error } = await supabase
    .from('merchant_products')
    .select('id, name_ar, price, section_id, is_approved, is_available')
    .in('phone', getPhoneVariants(phoneKey))
    .order('section_id', { ascending: true });
  if (error) throw new Error(error.message);

  const appUser = await getAppUser(phoneKey);
  console.log('\nDone.');
  console.log('app_user:', {
    phone: appUser?.phone,
    role: appUser?.role,
    account_type: appUser?.account_type,
  });
  console.log(`products upserted: ${ok}`);
  console.log(`products in DB for phone: ${(listed || []).length}`);
  console.log('Login with OTP using:', PHONE);
}

main().catch((error) => {
  console.error('Fatal:', error?.message || error);
  process.exit(1);
});
