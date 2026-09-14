#!/usr/bin/env node
// LEGACY — bazaar removed from Talab app
/**
 * يسجّل مطعم «أجنحة ومشويات عبدالله» (07732487645) مع الأقسام والمنتجات.
 * التشغيل من backend/:
 *   node scripts/upsert_abdullah_grill.js
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

const PHONE = '07732487645';
const STORE_NAME = 'أجنحة ومشويات عبدالله';
const ADDRESS = 'الصويرة - الشارع العام';
const DESCRIPTION =
  'مطعم مشويات — مستعدون لتجهيز كافة المناسبات';
const LAT = 32.9488919;
const LNG = 44.7766857;

const SECTIONS = [
  { id: 'abdullah_meat', name_ar: 'اللحوم', nameAr: 'اللحوم', sort_order: 0, sortOrder: 0 },
  { id: 'abdullah_chicken', name_ar: 'الدجاج', nameAr: 'الدجاج', sort_order: 1, sortOrder: 1 },
];

const PRODUCTS = [
  // قسم اللحوم
  { id: 'abdullah_meat_01', section_id: 'abdullah_meat', name_ar: 'عرايس لحم تركية', price: 10000 },
  { id: 'abdullah_meat_02', section_id: 'abdullah_meat', name_ar: 'شيش تكة لحم', price: 5000 },
  { id: 'abdullah_meat_03', section_id: 'abdullah_meat', name_ar: 'نقر كباب لحم', price: 12000 },
  { id: 'abdullah_meat_04', section_id: 'abdullah_meat', name_ar: 'نص نفر كباب لحم', price: 6000 },
  { id: 'abdullah_meat_05', section_id: 'abdullah_meat', name_ar: 'نفر معلاك', price: 12000 },
  { id: 'abdullah_meat_06', section_id: 'abdullah_meat', name_ar: 'نفر تكة لحم', price: 20000 },
  { id: 'abdullah_meat_07', section_id: 'abdullah_meat', name_ar: 'نص نفر تكة لحم', price: 10000 },
  { id: 'abdullah_meat_08', section_id: 'abdullah_meat', name_ar: 'ماعون تمن وسط', price: 3000 },
  { id: 'abdullah_meat_09', section_id: 'abdullah_meat', name_ar: 'ماعون تمن كبير', price: 5000 },
  // قسم الدجاج
  { id: 'abdullah_chk_01', section_id: 'abdullah_chicken', name_ar: 'دجاجة شوي + تمن + مقبلات', price: 12000 },
  { id: 'abdullah_chk_02', section_id: 'abdullah_chicken', name_ar: 'نص دجاج مشوي', price: 6000 },
  { id: 'abdullah_chk_03', section_id: 'abdullah_chicken', name_ar: 'نفر اجنحة 16 قطعة', price: 12000 },
  { id: 'abdullah_chk_04', section_id: 'abdullah_chicken', name_ar: 'نص نفر اجنحة 8 قطعة', price: 6000 },
  { id: 'abdullah_chk_05', section_id: 'abdullah_chicken', name_ar: 'شيش أجنحة 4 قطع', price: 3000 },
  { id: 'abdullah_chk_06', section_id: 'abdullah_chicken', name_ar: 'نفر تكة دجاج', price: 12000 },
  { id: 'abdullah_chk_07', section_id: 'abdullah_chicken', name_ar: 'نص نفر تكة دجاج', price: 6000 },
  { id: 'abdullah_chk_08', section_id: 'abdullah_chicken', name_ar: 'شيش تكة دجاج على التمن', price: 5000 },
  { id: 'abdullah_chk_09', section_id: 'abdullah_chicken', name_ar: 'دجاج مسحب', price: 8000 },
  {
    id: 'abdullah_chk_10',
    section_id: 'abdullah_chicken',
    name_ar: 'صينية مشكل',
    price: 25000,
    description_ar: 'نفر عرايس + نص نفر أجنحة + نص نفر تكة دجاج',
  },
  {
    id: 'abdullah_chk_11',
    section_id: 'abdullah_chicken',
    name_ar: 'صينية عبدالله',
    price: 50000,
    description_ar: 'دجاج مسحب + عرايس لحم + تكة دجاج + نفر أجنحة',
  },
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
    description: DESCRIPTION,
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
      description: DESCRIPTION,
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
        description_ar: item.description_ar ?? '',
        description_en: item.description_ar ?? '',
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
