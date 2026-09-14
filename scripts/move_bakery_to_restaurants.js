/**
 * نقل المخابز والمعجنات من التسوق إلى قسم المطاعم والكافيهات.
 * - merchant_products: category product + bakery → restaurant
 * - merchant_profiles: service_sub_category bakery → restaurant_category مخابز ومعجنات
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { assertSupabaseAdmin } = require('../supabase_repo/common');

const BAKERY_VENUE = 'مخابز ومعجنات';

(async () => {
  const supabase = assertSupabaseAdmin();

  // 1) منتجات
  const { data: products, error: pErr } = await supabase
    .from('merchant_products')
    .update({ category: 'restaurant', sub_category: 'bakery' })
    .eq('sub_category', 'bakery')
    .select('id, phone, category');
  if (pErr) throw new Error(`products: ${pErr.message}`);
  console.log('products bakery→restaurant:', (products || []).length);

  // أيضاً أي منتج bakery بأي category
  const { data: products2, error: pErr2 } = await supabase
    .from('merchant_products')
    .update({ category: 'restaurant' })
    .eq('sub_category', 'bakery')
    .neq('category', 'restaurant')
    .select('id');
  if (pErr2) console.warn('products2:', pErr2.message);
  else console.log('products force category restaurant:', (products2 || []).length);

  // 2) ملفات التجار المصنّفة bakery
  const { data: profiles, error: prErr } = await supabase
    .from('merchant_profiles')
    .select('phone, primary_service_id, service_ids, service_sub_category, restaurant_category')
    .eq('service_sub_category', 'bakery');
  if (prErr) throw new Error(`profiles query: ${prErr.message}`);

  let profileUpdated = 0;
  for (const row of profiles || []) {
    const ids = Array.isArray(row.service_ids)
      ? row.service_ids.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!ids.includes('restaurant')) ids.push('restaurant');
    // أزل product من الأساسي إن كان مخبز فقط
    const patch = {
      primary_service_id: 'restaurant',
      service_ids: ids,
      restaurant_category: BAKERY_VENUE,
      service_sub_category: null,
    };
    const { error } = await supabase
      .from('merchant_profiles')
      .update(patch)
      .eq('phone', row.phone);
    if (error) {
      console.error('profile fail', row.phone, error.message);
      continue;
    }
    profileUpdated += 1;
  }
  console.log('profiles bakery→restaurant venue:', profileUpdated);

  // 3) ملفات قد يكون لديها منتجات bakery دون service_sub_category
  const bakeryPhones = new Set((products || []).map((p) => String(p.phone || '').trim()).filter(Boolean));
  let extra = 0;
  for (const phone of bakeryPhones) {
    const { data: row, error } = await supabase
      .from('merchant_profiles')
      .select('phone, primary_service_id, service_ids, restaurant_category, service_sub_category')
      .eq('phone', phone)
      .maybeSingle();
    if (error || !row) continue;
    const venue = String(row.restaurant_category || '').trim();
    if (venue === BAKERY_VENUE) continue;
    const ids = Array.isArray(row.service_ids)
      ? row.service_ids.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!ids.includes('restaurant')) ids.push('restaurant');
    const { error: upErr } = await supabase
      .from('merchant_profiles')
      .update({
        primary_service_id: 'restaurant',
        service_ids: ids,
        restaurant_category: BAKERY_VENUE,
        service_sub_category: null,
      })
      .eq('phone', phone);
    if (!upErr) extra += 1;
  }
  console.log('profiles from bakery products:', extra);

  // تحقق
  const { count: leftShopping } = await supabase
    .from('merchant_products')
    .select('id', { count: 'exact', head: true })
    .eq('sub_category', 'bakery')
    .eq('category', 'product');
  const { count: bakeryRestaurant } = await supabase
    .from('merchant_products')
    .select('id', { count: 'exact', head: true })
    .eq('sub_category', 'bakery')
    .eq('category', 'restaurant');
  console.log({ leftInShopping: leftShopping, bakeryRestaurantProducts: bakeryRestaurant });
  console.log('DONE');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
