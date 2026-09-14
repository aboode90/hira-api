/**
 * دمج أقسام الملابس الثلاثة داخل «الملابس»:
 * women_clothing / men_clothing / kids_clothing → clothing
 * used_* → used_clothing
 * + تحديث merchant_profiles.service_sub_category
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { assertSupabaseAdmin } = require('../supabase_repo/common');

const PRODUCT_MAP = [
  ['women_clothing', 'clothing'],
  ['men_clothing', 'clothing'],
  ['kids_clothing', 'clothing'],
  ['used_women_clothing', 'used_clothing'],
  ['used_men_clothing', 'used_clothing'],
  ['used_kids_clothing', 'used_clothing'],
];

async function updateProducts(supabase, from, to) {
  const { data, error } = await supabase
    .from('merchant_products')
    .update({ sub_category: to })
    .eq('sub_category', from)
    .select('id');
  if (error) throw new Error(`products ${from}→${to}: ${error.message}`);
  return (data || []).length;
}

async function updateProfiles(supabase, from, to) {
  const { data, error } = await supabase
    .from('merchant_profiles')
    .update({ service_sub_category: to })
    .eq('service_sub_category', from)
    .select('phone');
  if (error) throw new Error(`profiles ${from}→${to}: ${error.message}`);
  return (data || []).length;
}

(async () => {
  const supabase = assertSupabaseAdmin();

  for (const [from, to] of PRODUCT_MAP) {
    const n = await updateProducts(supabase, from, to);
    console.log(`products ${from}→${to}:`, n);
  }

  for (const from of ['women_clothing', 'men_clothing', 'kids_clothing']) {
    const n = await updateProfiles(supabase, from, 'clothing');
    console.log(`profiles ${from}→clothing:`, n);
  }

  // تحقق
  const left = [];
  for (const [from] of PRODUCT_MAP) {
    const { count } = await supabase
      .from('merchant_products')
      .select('id', { count: 'exact', head: true })
      .eq('sub_category', from);
    if (count) left.push(`${from}=${count}`);
  }
  const { count: clothingCount } = await supabase
    .from('merchant_products')
    .select('id', { count: 'exact', head: true })
    .eq('sub_category', 'clothing');
  console.log('clothing products now:', clothingCount);
  console.log('leftover legacy:', left.length ? left.join(', ') : 'none');
  console.log('DONE');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
