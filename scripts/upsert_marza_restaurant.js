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
  ensureAppUser,
  saveAppUser,
  saveUserState,
  getUserState,
} = require('../supabase_repo/users');

const PHONE = '07753848637';
const STORE_NAME = 'دجاج بيت مرزة';
const RESTAURANT_CATEGORY = 'مشاوي';
const ADDRESS = 'الصويرة';
const LAT = 32.9339;
const LNG = 44.7728;

const SECTIONS = [
  { id: 'marza_grilled', name_ar: 'دجاج مشوي', nameAr: 'دجاج مشوي', sort_order: 0, sortOrder: 0 },
  { id: 'marza_meals', name_ar: 'وجبات تمن ومرق', nameAr: 'وجبات تمن ومرق', sort_order: 1, sortOrder: 1 },
  { id: 'marza_shawarma', name_ar: 'شاورما دجاج', nameAr: 'شاورما دجاج', sort_order: 2, sortOrder: 2 },
  { id: 'marza_rizzo', name_ar: 'ريزو', nameAr: 'ريزو', sort_order: 3, sortOrder: 3 },
  { id: 'marza_cuts', name_ar: 'دجاج ذبح وأجزاء', nameAr: 'دجاج ذبح وأجزاء', sort_order: 4, sortOrder: 4 },
];

const PRODUCTS = [
  // دجاج مشوي
  { id: 'marza_grilled_01', section_id: 'marza_grilled', name_ar: 'دجاج شوي', price: 8000 },
  { id: 'marza_grilled_02', section_id: 'marza_grilled', name_ar: 'نص دجاج شوي', price: 4000 },
  { id: 'marza_grilled_03', section_id: 'marza_grilled', name_ar: 'دجاج محشي', price: 9000 },
  { id: 'marza_grilled_04', section_id: 'marza_grilled', name_ar: 'نص دجاج محشي', price: 4500 },
  // وجبات تمن ومرق
  { id: 'marza_meals_01', section_id: 'marza_meals', name_ar: 'تمن ومرق وسط', price: 4000 },
  { id: 'marza_meals_02', section_id: 'marza_meals', name_ar: 'تمن ومرق كبير', price: 6000 },
  { id: 'marza_meals_03', section_id: 'marza_meals', name_ar: 'دجاج مشوي مع التمن ومرق وسط', price: 12000 },
  { id: 'marza_meals_04', section_id: 'marza_meals', name_ar: 'دجاج مشوي مع التمن ومرق كبير', price: 14000 },
  { id: 'marza_meals_05', section_id: 'marza_meals', name_ar: 'نص دجاج مشوي مع التمن ومرق وسط', price: 8000 },
  { id: 'marza_meals_06', section_id: 'marza_meals', name_ar: 'نص دجاج مشوي مع التمن ومرق كبير', price: 10000 },
  { id: 'marza_meals_07', section_id: 'marza_meals', name_ar: 'دجاج محشي مع التمن ومرق وسط', price: 13000 },
  { id: 'marza_meals_08', section_id: 'marza_meals', name_ar: 'دجاج محشي مع التمن ومرق كبير', price: 15000 },
  { id: 'marza_meals_09', section_id: 'marza_meals', name_ar: 'نص دجاج محشي مع التمن ومرق وسط', price: 8500 },
  { id: 'marza_meals_10', section_id: 'marza_meals', name_ar: 'نص دجاج محشي مع التمن ومرق كبير', price: 10500 },
  // شاورما دجاج
  { id: 'marza_shawarma_01', section_id: 'marza_shawarma', name_ar: 'شاورما دجاج ذبح لفة', price: 1000 },
  { id: 'marza_shawarma_02', section_id: 'marza_shawarma', name_ar: 'كيلو شاورما دجاج ذبح', price: 20000 },
  // ريزو
  { id: 'marza_rizzo_01', section_id: 'marza_rizzo', name_ar: 'ريزو كص', price: 3000 },
  // دجاج ذبح وأجزاء
  { id: 'marza_cuts_01', section_id: 'marza_cuts', name_ar: 'صدر دجاج الكيلو', price: 5000 },
  { id: 'marza_cuts_02', section_id: 'marza_cuts', name_ar: 'افخاذ دجاج الكيلو', price: 5000 },
  { id: 'marza_cuts_03', section_id: 'marza_cuts', name_ar: 'اجنحه بكتف الكيلو', price: 5000 },
  { id: 'marza_cuts_04', section_id: 'marza_cuts', name_ar: 'اجنحه وركب الكيلو', price: 2500 },
  { id: 'marza_cuts_05', section_id: 'marza_cuts', name_ar: 'اكباد وحواصل منضفه الكيلو', price: 2500 },
  { id: 'marza_cuts_06', section_id: 'marza_cuts', name_ar: 'دجاج ذبح منضف الدجاجة', price: 5000 },
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
  console.log(existing ? 'existing merchant: ' + existing.store_name : 'no merchant profile yet');

  const saved = await saveMerchantProfile(phoneKey, {
    store_name: STORE_NAME,
    name: STORE_NAME,
    description: 'مطعم مشاوي — دجاج شوي ومحشي وشاورما ووجبات تمن ومرق',
    address: ADDRESS,
    latitude: LAT,
    longitude: LNG,
    lat: LAT,
    lng: LNG,
    primary_service_id: 'restaurant',
    service_ids: ['restaurant'],
    active_service_id: 'restaurant',
    restaurant_category: RESTAURANT_CATEGORY,
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
      description: 'مطعم مشاوي — دجاج شوي ومحشي وشاورما ووجبات تمن ومرق',
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
      restaurant_category: RESTAURANT_CATEGORY,
      restaurantCategory: RESTAURANT_CATEGORY,
      product_sections: SECTIONS,
      productSections: SECTIONS,
      is_open: true,
      isOpen: true,
      is_approved: true,
      isApproved: true,
    },
  });

  console.log('profile saved:', {
    phone: saved?.phone,
    store_name: saved?.store_name,
    primary_service_id: saved?.primary_service_id,
    restaurant_category: saved?.restaurant_category,
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
    console.log('  [' + item.section_id + '] ' + item.name_ar + ' — ' + item.price);
  }

  const supabase = assertSupabaseAdmin();
  const { data: listed, error } = await supabase
    .from('merchant_products')
    .select('id, name_ar, price, section_id, is_approved, is_available')
    .in('phone', getPhoneVariants(phoneKey))
    .order('section_id', { ascending: true });
  if (error) throw new Error(error.message);

  const appUser = await (async () => {
    const { getAppUser } = require('../supabase_repo/users');
    return getAppUser(phoneKey);
  })();

  console.log('\nDone.');
  console.log('app_user:', { phone: appUser?.phone, role: appUser?.role, account_type: appUser?.account_type });
  console.log('products upserted:', ok);
  console.log('products in DB for phone:', (listed || []).length);
  console.log('Login with OTP using:', PHONE);
}

main().catch((error) => {
  console.error('Fatal:', error?.message || error);
  process.exit(1);
});
