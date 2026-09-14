#!/usr/bin/env node
// LEGACY — bazaar removed from Talab app
/**
 * يرفع منتجات «اسواق ال حسوني» من قائمة الأسعار مع أقسام منظمة.
 * التشغيل من backend/:
 *   node scripts/upsert_hussaini_market.js
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
const { saveMerchantServiceProfile } = require('../supabase_repo/merchant_service_profiles');
const { getUserState, saveUserState } = require('../supabase_repo/users');

const PHONE = '07742554000';
const SUB_CATEGORY = 'food_items';

// نحافظ على قسم «حبوب» الموجود مسبقاً لعدم كسر المنتج الحالي «حبية الجود».
const SECTION_GRAIN = '1783712114315';

const SECTIONS = [
  {
    id: 'hussaini_nuts',
    name_ar: 'مكسرات وفستق',
    nameAr: 'مكسرات وفستق',
    sort_order: 0,
    sortOrder: 0,
  },
  {
    id: SECTION_GRAIN,
    name_ar: 'حبوب',
    nameAr: 'حبوب',
    sort_order: 1,
    sortOrder: 1,
  },
  {
    id: 'hussaini_dried',
    name_ar: 'زبيب ومجففات',
    nameAr: 'زبيب ومجففات',
    sort_order: 2,
    sortOrder: 2,
  },
  {
    id: 'hussaini_sweets',
    name_ar: 'حلويات',
    nameAr: 'حلويات',
    sort_order: 3,
    sortOrder: 3,
  },
  {
    id: 'hussaini_pickles',
    name_ar: 'طرشي ومخللات',
    nameAr: 'طرشي ومخللات',
    sort_order: 4,
    sortOrder: 4,
  },
  {
    id: 'hussaini_pastries',
    name_ar: 'معجنات وكعك',
    nameAr: 'معجنات وكعك',
    sort_order: 5,
    sortOrder: 5,
  },
  {
    id: 'hussaini_other',
    name_ar: 'أجبان ومنتجات أخرى',
    nameAr: 'أجبان ومنتجات أخرى',
    sort_order: 6,
    sortOrder: 6,
  },
];

const PRODUCTS = [
  { id: 'hussaini_01', section_id: 'hussaini_nuts', name_ar: 'كرزات مشكلة', price: 20000 },
  { id: 'hussaini_02', section_id: 'hussaini_nuts', name_ar: 'لوز حامض+ مالح', price: 18000 },
  { id: 'hussaini_03', section_id: 'hussaini_nuts', name_ar: 'لوز محمص', price: 16000 },
  { id: 'hussaini_04', section_id: 'hussaini_nuts', name_ar: 'لوز مشرح', price: 15000 },
  { id: 'hussaini_05', section_id: 'hussaini_nuts', name_ar: 'كاجو متبل', price: 18000 },
  { id: 'hussaini_06', section_id: 'hussaini_nuts', name_ar: 'كاجو', price: 20000 },
  { id: 'hussaini_07', section_id: 'hussaini_nuts', name_ar: 'فستق حلبي', price: 25000 },
  { id: 'hussaini_08', section_id: 'hussaini_nuts', name_ar: 'فستق عظم حامض +مالح', price: 20000 },
  { id: 'hussaini_09', section_id: 'hussaini_nuts', name_ar: 'فستق مقرمش', price: 6000 },
  { id: 'hussaini_10', section_id: 'hussaini_nuts', name_ar: 'فستق محمص', price: 5000 },
  { id: 'hussaini_11', section_id: 'hussaini_nuts', name_ar: 'جوز مفلس', price: 12000 },
  { id: 'hussaini_12', section_id: 'hussaini_nuts', name_ar: 'جوز عظم', price: 6000 },
  { id: 'hussaini_13', section_id: 'hussaini_nuts', name_ar: 'حب مشكل', price: 8000 },

  { id: 'hussaini_14', section_id: SECTION_GRAIN, name_ar: 'حب ابيض مالح', price: 10000 },
  { id: 'hussaini_15', section_id: SECTION_GRAIN, name_ar: 'حب ابيض فاهي', price: 8000 },
  { id: 'hussaini_16', section_id: SECTION_GRAIN, name_ar: 'حمص', price: 6000 },
  { id: 'hussaini_17', section_id: SECTION_GRAIN, name_ar: 'حب يقطين', price: 8000 },
  { id: 'hussaini_18', section_id: SECTION_GRAIN, name_ar: 'حب شمس', price: 5000 },
  { id: 'hussaini_19', section_id: SECTION_GRAIN, name_ar: 'حب فاهي', price: 8000 },
  { id: 'hussaini_20', section_id: SECTION_GRAIN, name_ar: 'ذرة مقرمشة', price: 6000 },
  { id: 'hussaini_21', section_id: SECTION_GRAIN, name_ar: 'حب احمر', price: 8000 },

  { id: 'hussaini_22', section_id: 'hussaini_dried', name_ar: 'زبيب خشن', price: 8000 },
  { id: 'hussaini_23', section_id: 'hussaini_dried', name_ar: 'زبيب طويل', price: 10000 },
  { id: 'hussaini_24', section_id: 'hussaini_dried', name_ar: 'جبس كبوس', price: 6000 },

  { id: 'hussaini_25', section_id: 'hussaini_sweets', name_ar: 'جكليت 7.5', price: 7500 },
  { id: 'hussaini_26', section_id: 'hussaini_sweets', name_ar: 'جكليت 4', price: 4000 },
  { id: 'hussaini_27', section_id: 'hussaini_sweets', name_ar: 'جكليت 3', price: 3000 },
  { id: 'hussaini_28', section_id: 'hussaini_sweets', name_ar: 'حلقوم', price: 3000 },
  { id: 'hussaini_29', section_id: 'hussaini_sweets', name_ar: 'بيتفور مشكل', price: 4000 },
  { id: 'hussaini_30', section_id: 'hussaini_sweets', name_ar: 'بيتفور علبة', price: 3500 },

  { id: 'hussaini_31', section_id: 'hussaini_pickles', name_ar: 'طرشي مزيت', price: 5000 },
  { id: 'hussaini_32', section_id: 'hussaini_pickles', name_ar: 'طرشي عادي', price: 3000 },
  { id: 'hussaini_33', section_id: 'hussaini_pickles', name_ar: 'طرشي مدبس', price: 4000 },
  { id: 'hussaini_34', section_id: 'hussaini_pickles', name_ar: 'طرشي مشكل', price: 4000 },
  { id: 'hussaini_35', section_id: 'hussaini_pickles', name_ar: 'زيتون', price: 4000 },
  { id: 'hussaini_36', section_id: 'hussaini_pickles', name_ar: 'خيار مي', price: 4000 },

  { id: 'hussaini_37', section_id: 'hussaini_pastries', name_ar: 'كعك سمسم', price: 3000 },
  { id: 'hussaini_38', section_id: 'hussaini_pastries', name_ar: 'كعك اصابع تمر', price: 4000 },
  { id: 'hussaini_39', section_id: 'hussaini_pastries', name_ar: 'كعك دهن', price: 3000 },

  { id: 'hussaini_40', section_id: 'hussaini_other', name_ar: 'كيمر عرب', price: 18000 },
  { id: 'hussaini_41', section_id: 'hussaini_other', name_ar: 'جبن عرب', price: 4000 },
  { id: 'hussaini_42', section_id: 'hussaini_other', name_ar: 'بيض حمام رؤيا', price: 6000 },
];

async function main() {
  assertSupabaseAdmin();
  const phoneKey = await resolvePhoneKey(PHONE);
  const existing = await getMerchantProfile(phoneKey);
  if (!existing) {
    throw new Error('Merchant profile not found for اسواق ال حسوني');
  }

  console.log('store:', existing.store_name);
  console.log('phoneKey:', phoneKey);

  const saved = await saveMerchantProfile(phoneKey, {
    product_sections: SECTIONS,
    productSections: SECTIONS,
    primary_service_id: 'product',
    primaryServiceId: 'product',
    active_service_id: 'product',
    activeServiceId: 'product',
    service_sub_category: SUB_CATEGORY,
    serviceSubCategory: SUB_CATEGORY,
  });

  await saveMerchantServiceProfile(phoneKey, 'product', {
    ...existing,
    product_sections: SECTIONS,
    productSections: SECTIONS,
  });

  await saveMerchantServiceProfile(phoneKey, 'bazar_ghaith', {
    ...existing,
    product_sections: SECTIONS,
    productSections: SECTIONS,
  });

  const currentState = (await getUserState(phoneKey)) || {};
  const currentStore = currentState.merchantStore || {};
  await saveUserState(phoneKey, {
    merchantStore: {
      ...currentStore,
      product_sections: SECTIONS,
      productSections: SECTIONS,
      primary_service_id: 'product',
      primaryServiceId: 'product',
      active_service_id: 'product',
      activeServiceId: 'product',
      service_sub_category: SUB_CATEGORY,
      serviceSubCategory: SUB_CATEGORY,
    },
  });

  console.log(
    'sections saved:',
    (saved?.product_sections || SECTIONS).map((s) => s.name_ar || s.nameAr),
  );

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
        category: 'product',
        service_id: 'product',
        serviceId: 'product',
        sub_category: SUB_CATEGORY,
        subCategory: SUB_CATEGORY,
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

  console.log('\nDone.');
  console.log(`products upserted from Excel: ${ok}`);
  console.log(`total products in DB: ${(listed || []).length}`);
}

main().catch((error) => {
  console.error('Fatal:', error?.message || error);
  process.exit(1);
});
