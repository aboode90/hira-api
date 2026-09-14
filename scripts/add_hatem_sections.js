const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolvePhoneKey, assertSupabaseAdmin } = require('../supabase_repo/common');
const { getMerchantProfile, saveMerchantProduct } = require('../supabase_repo/merchants');

const PHONE = '+9647712413427';

const SECTIONS = [
  { id: 's7_juice_time', name_ar: 'مشتقات عصير تايم', nameAr: 'مشتقات عصير تايم', sort_order: 6, sortOrder: 6 },
  { id: 's8_ice_cream', name_ar: 'المثلجات', nameAr: 'المثلجات', sort_order: 7, sortOrder: 7 },
];

const PRODUCTS = [
  // مشتقات عصير تايم (s7_juice_time)
  { id: 'hatem_jt_01', section_id: 's7_juice_time', name_ar: 'ميلك شيك جوكليت', price: 3000 },
  { id: 'hatem_jt_02', section_id: 's7_juice_time', name_ar: 'ميلك شيك اوريو', price: 3000 },
  { id: 'hatem_jt_03', section_id: 's7_juice_time', name_ar: 'ميلك شيك موز', price: 3000 },
  { id: 'hatem_jt_04', section_id: 's7_juice_time', name_ar: 'ميلك شيك فراولة', price: 3000 },
  { id: 'hatem_jt_05', section_id: 's7_juice_time', name_ar: 'أنشتاين', price: 3000 },
  { id: 'hatem_jt_06', section_id: 's7_juice_time', name_ar: 'ماهيتو', price: 2000 },
  { id: 'hatem_jt_07', section_id: 's7_juice_time', name_ar: 'بستاشيو الفستق الحلبي', price: 4000 },
  { id: 'hatem_jt_08', section_id: 's7_juice_time', name_ar: 'هرمون السعادة', price: 4000 },
  { id: 'hatem_jt_09', section_id: 's7_juice_time', name_ar: 'حفيد انشتاين', price: 3000 },
  { id: 'hatem_jt_10', section_id: 's7_juice_time', name_ar: 'سريلاك', price: 3000 },
  // المثلجات (s8_ice_cream)
  { id: 'hatem_ic_01', section_id: 's8_ice_cream', name_ar: 'سوفت بكست', price: 500 },
  { id: 'hatem_ic_02', section_id: 's8_ice_cream', name_ar: 'سوفت بسكت دبل', price: 1000 },
  { id: 'hatem_ic_03', section_id: 's8_ice_cream', name_ar: 'سوفت شعرية', price: 1500 },
  { id: 'hatem_ic_04', section_id: 's8_ice_cream', name_ar: 'كوب سوفت عائلي', price: 3000 },
  { id: 'hatem_ic_05', section_id: 's8_ice_cream', name_ar: 'دوندرمة فواكه كوب صغير', price: 1000 },
  { id: 'hatem_ic_06', section_id: 's8_ice_cream', name_ar: 'دوندرمة فواكه كوب', price: 2000 },
  { id: 'hatem_ic_07', section_id: 's8_ice_cream', name_ar: 'قوعة فواكه', price: 2500 },
  { id: 'hatem_ic_08', section_id: 's8_ice_cream', name_ar: 'قوقعة فستق', price: 3000 },
  { id: 'hatem_ic_09', section_id: 's8_ice_cream', name_ar: 'كوب دوندرمة فواكه عائلي', price: 3000 },
  { id: 'hatem_ic_10', section_id: 's8_ice_cream', name_ar: 'كوب دوندرمة فواكه عائلي كبير', price: 5000 },
  { id: 'hatem_ic_11', section_id: 's8_ice_cream', name_ar: 'كوب فستق حلبي صغير', price: 1500 },
  { id: 'hatem_ic_12', section_id: 's8_ice_cream', name_ar: 'كوب فستق حلبي عائلي', price: 4000 },
  { id: 'hatem_ic_13', section_id: 's8_ice_cream', name_ar: 'كوب فستق حلبي عائلي كبير', price: 7000 },
  { id: 'hatem_ic_14', section_id: 's8_ice_cream', name_ar: 'أزبري', price: 750 },
  { id: 'hatem_ic_15', section_id: 's8_ice_cream', name_ar: 'أزبري سلاش', price: 1000 },
  { id: 'hatem_ic_16', section_id: 's8_ice_cream', name_ar: 'عصير رمان', price: 1000 },
  { id: 'hatem_ic_17', section_id: 's8_ice_cream', name_ar: 'عصير رمان إضافي', price: 1000 },
  { id: 'hatem_ic_18', section_id: 's8_ice_cream', name_ar: 'عصير زبيب', price: 1000 },
  { id: 'hatem_ic_19', section_id: 's8_ice_cream', name_ar: 'عصير رمان كيس عائلي', price: 3000 },
  { id: 'hatem_ic_20', section_id: 's8_ice_cream', name_ar: 'عصير زبيب كيس عائلي', price: 3000 },
];

async function main() {
  assertSupabaseAdmin();
  const phoneKey = await resolvePhoneKey(PHONE);
  console.log('phoneKey:', phoneKey);

  const profile = await getMerchantProfile(phoneKey);
  const existingSections = Array.isArray(profile?.product_sections)
    ? profile.product_sections
    : [];
  const seenIds = new Set(existingSections.map((s) => String(s.id || s.sectionId || '')));
  const mergedSections = [...existingSections];
  for (const section of SECTIONS) {
    if (!seenIds.has(section.id)) {
      mergedSections.push(section);
    }
  }
  console.log('sections before:', existingSections.length, 'after:', mergedSections.length);

  const supabase = assertSupabaseAdmin();
  const { data: savedProfile, error: profileError } = await supabase
    .from('merchant_profiles')
    .update({
      product_sections: mergedSections,
      updated_at: new Date().toISOString(),
    })
    .eq('phone', phoneKey)
    .select('phone,store_name,product_sections');
  if (profileError) throw new Error(profileError.message);
  console.log('profile updated:', JSON.stringify(savedProfile?.[0]?.product_sections?.map((s) => s.name_ar || s.nameAr)));

  const { error: spError } = await supabase
    .from('merchant_service_profiles')
    .update({ product_sections: mergedSections })
    .eq('phone', phoneKey)
    .eq('service_id', 'restaurant');
  if (spError) console.error('service profile sections update error:', spError.message);
  else console.log('service profile sections updated');

  let ok = 0;
  for (const item of PRODUCTS) {
    const result = await saveMerchantProduct(
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
      { adminSave: true }
    );
    if (!result) throw new Error('saveMerchantProduct returned no result for ' + item.name_ar);
    ok += 1;
    console.log(`  ✓ [${item.section_id}] ${item.name_ar} — ${item.price}`);
  }

  const { data: listed, error: listError } = await supabase
    .from('merchant_products')
    .select('id, name_ar, price, section_id, is_approved, is_available')
    .eq('phone', phoneKey)
    .in('section_id', ['s7_juice_time', 's8_ice_cream']);
  if (listError) throw new Error(listError.message);

  console.log('\nDone.');
  console.log('products upserted:', ok);
  console.log('products in DB for new sections:', (listed || []).length);
}

main().catch((error) => {
  console.error('Fatal:', error?.message || error);
  process.exit(1);
});
