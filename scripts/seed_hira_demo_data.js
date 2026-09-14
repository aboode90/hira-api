#!/usr/bin/env node
/**
 * بيانات تجريبية لحيرة — مطاعم ومتاجر معتمدة + منتجات.
 * Usage (from backend/): node scripts/seed_hira_demo_data.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { assertSupabaseAdmin, resolvePhoneKey } = require('../supabase_repo/common');
const { saveMerchantProfile, saveMerchantProduct } = require('../supabase_repo/merchants');
const { ensureAppUser, saveAppUser, saveUserState, getUserState } = require('../supabase_repo/users');

const LAT = 32.9488919;
const LNG = 44.7766857;
const ADDRESS = 'الصويرة - الشارع العام';

const DEMO_STORES = [
  {
    phone: '07700000001',
    storeName: 'مطعم حيرة — مشويات',
    description: 'مطعم تجريبي — مشويات ووجبات سريعة',
    primaryServiceId: 'restaurant',
    serviceIds: ['restaurant'],
    restaurantCategory: 'مطاعم',
    ratePerKm: 700,
    sections: [
      { id: 'hira_grill', name_ar: 'مشويات', nameAr: 'مشويات', sort_order: 0 },
      { id: 'hira_drinks', name_ar: 'مشروبات', nameAr: 'مشروبات', sort_order: 1 },
    ],
    products: [
      { id: 'hira_grill_01', section_id: 'hira_grill', name_ar: 'كباب لحم', price: 8000 },
      { id: 'hira_grill_02', section_id: 'hira_grill', name_ar: 'تكة دجاج', price: 7000 },
      { id: 'hira_grill_03', section_id: 'hira_grill', name_ar: 'صحن مشاوي', price: 15000 },
      { id: 'hira_drink_01', section_id: 'hira_drinks', name_ar: 'عصير برتقال', price: 2000 },
      { id: 'hira_drink_02', section_id: 'hira_drinks', name_ar: 'ماء', price: 500 },
    ],
  },
  {
    phone: '07700000002',
    storeName: 'مطعم حيرة — برجر',
    description: 'مطعم تجريبي — برجر ووجبات',
    primaryServiceId: 'restaurant',
    serviceIds: ['restaurant'],
    restaurantCategory: 'مطاعم',
    ratePerKm: 700,
    sections: [{ id: 'hira_burger', name_ar: 'برجر', nameAr: 'برger', sort_order: 0 }],
    products: [
      { id: 'hira_burger_01', section_id: 'hira_burger', name_ar: 'برجر كلاسيك', price: 6500 },
      { id: 'hira_burger_02', section_id: 'hira_burger', name_ar: 'برجر دجاج', price: 5500 },
      { id: 'hira_burger_03', section_id: 'hira_burger', name_ar: 'بطاطا', price: 2500 },
    ],
  },
  {
    phone: '07700000003',
    storeName: 'متجر حيرة — بقالة',
    description: 'متجر تجريبي — مواد غذائية ومنزلية',
    primaryServiceId: 'shopping',
    serviceIds: ['shopping'],
    restaurantCategory: '',
    ratePerKm: 700,
    sections: [{ id: 'hira_grocery', name_ar: 'بقالة', nameAr: 'بقالة', sort_order: 0 }],
    products: [
      { id: 'hira_shop_01', section_id: 'hira_grocery', name_ar: 'رز 5kg', price: 6000, category: 'shopping' },
      { id: 'hira_shop_02', section_id: 'hira_grocery', name_ar: 'زيت نباتي', price: 4500, category: 'shopping' },
      { id: 'hira_shop_03', section_id: 'hira_grocery', name_ar: 'سكر 1kg', price: 1500, category: 'shopping' },
      { id: 'hira_shop_04', section_id: 'hira_grocery', name_ar: 'شاي', price: 2000, category: 'shopping' },
    ],
  },
];

async function upsertStore(def) {
  const phoneKey = await resolvePhoneKey(def.phone);
  console.log('\n—', def.storeName, phoneKey);

  await ensureAppUser(phoneKey, {
    role: 'merchant',
    full_name: def.storeName,
  });
  await saveAppUser(phoneKey, {
    role: 'merchant',
    full_name: def.storeName,
  });

  const saved = await saveMerchantProfile(phoneKey, {
    store_name: def.storeName,
    name: def.storeName,
    description: def.description,
    address: ADDRESS,
    latitude: LAT,
    longitude: LNG,
    lat: LAT,
    lng: LNG,
    primary_service_id: def.primaryServiceId,
    service_ids: def.serviceIds,
    active_service_id: def.primaryServiceId,
    restaurant_category: def.restaurantCategory || undefined,
    product_sections: def.sections,
    productSections: def.sections,
    rate_per_km: def.ratePerKm,
    ratePerKm: def.ratePerKm,
    whatsapp: def.phone,
    show_phone_to_customers: true,
    is_open: true,
    isOpen: true,
    is_approved: true,
    isApproved: true,
    approval_status: 'approved',
    is_bazaar_member: false,
    _adminModerationBypass: true,
  });

  const currentState = (await getUserState(phoneKey)) || {};
  await saveUserState(phoneKey, {
    userRole: 'merchant',
    accountType: 'marketplace',
    merchantProfileComplete: true,
    merchantStore: {
      ...(currentState.merchantStore || {}),
      name: def.storeName,
      store_name: def.storeName,
      phone: phoneKey,
      address: ADDRESS,
      latitude: LAT,
      longitude: LNG,
      primary_service_id: def.primaryServiceId,
      service_ids: def.serviceIds,
      is_open: true,
      is_approved: true,
      rate_per_km: def.ratePerKm,
    },
  });

  let count = 0;
  for (const item of def.products) {
    await saveMerchantProduct(phoneKey, {
      id: item.id,
      name_ar: item.name_ar,
      nameAr: item.name_ar,
      name_en: item.name_ar,
      description_ar: '',
      description_en: '',
      price: item.price,
      category: item.category || def.primaryServiceId,
      service_id: def.primaryServiceId,
      serviceId: def.primaryServiceId,
      section_id: item.section_id,
      sectionId: item.section_id,
      image: '',
      is_approved: true,
      isApproved: true,
      approval_status: 'approved',
      _adminModerationBypass: true,
    });
    count += 1;
  }

  console.log('  ✓ profile +', count, 'products', saved?.store_name);
}

async function main() {
  assertSupabaseAdmin();
  for (const store of DEMO_STORES) {
    await upsertStore(store);
  }
  console.log('\n✓ Demo data ready — phones 07700000001..03');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
