/**
 * دمج قسم الاكسسوارات داخل الكوزمتك:
 * - merchant_products.sub_category: accessories → cosmetics
 * - used_accessories → used_cosmetics
 * - merchant_profiles.service_sub_category + store_data
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { assertSupabaseAdmin } = require('../supabase_repo/common');

async function updateProducts(supabase, from, to) {
  const { data, error } = await supabase
    .from('merchant_products')
    .update({ sub_category: to })
    .eq('sub_category', from)
    .select('id');
  if (error) throw new Error(`products ${from}→${to}: ${error.message}`);
  return (data || []).length;
}

async function migrateProfiles(supabase) {
  const { data: rows, error } = await supabase
    .from('merchant_profiles')
    .select('phone, service_sub_category, store_data')
    .or('service_sub_category.eq.accessories,store_data.cs.{"service_sub_category":"accessories"}');
  if (error) {
    // fallback: fetch all with accessories in service_sub_category only
    const { data: direct, error: err2 } = await supabase
      .from('merchant_profiles')
      .select('phone, service_sub_category, store_data')
      .eq('service_sub_category', 'accessories');
    if (err2) throw new Error(`profiles query: ${err2.message}`);
    return migrateProfileRows(supabase, direct || []);
  }
  return migrateProfileRows(supabase, rows || []);
}

async function migrateProfileRows(supabase, rows) {
  let updated = 0;
  for (const row of rows) {
    const store = row.store_data && typeof row.store_data === 'object' ? { ...row.store_data } : {};
    const storeSub = String(
      store.service_sub_category ||
        store.serviceSubCategory ||
        store.subCategoryId ||
        store.sub_category_id ||
        '',
    ).trim();
    const profileSub = String(row.service_sub_category || '').trim();
    const needs =
      profileSub === 'accessories' ||
      storeSub === 'accessories';
    if (!needs) continue;

    if (profileSub === 'accessories') {
      store.service_sub_category = 'cosmetics';
      store.serviceSubCategory = 'cosmetics';
      store.subCategoryId = 'cosmetics';
    } else if (storeSub === 'accessories') {
      store.service_sub_category = 'cosmetics';
      store.serviceSubCategory = 'cosmetics';
      store.subCategoryId = 'cosmetics';
    }

    const patch = {
      store_data: store,
    };
    if (profileSub === 'accessories') {
      patch.service_sub_category = 'cosmetics';
    }

    const { error } = await supabase
      .from('merchant_profiles')
      .update(patch)
      .eq('phone', row.phone);
    if (error) {
      console.error('profile update failed', row.phone, error.message);
      continue;
    }
    updated += 1;
  }
  return updated;
}

(async () => {
  const supabase = assertSupabaseAdmin();

  const productsMoved = await updateProducts(supabase, 'accessories', 'cosmetics');
  console.log('products accessories→cosmetics:', productsMoved);

  const usedMoved = await updateProducts(supabase, 'used_accessories', 'used_cosmetics');
  console.log('products used_accessories→used_cosmetics:', usedMoved);

  // profiles with accessories subcategory
  const { data: accessoryProfiles, error: pErr } = await supabase
    .from('merchant_profiles')
    .select('phone, service_sub_category, store_data')
    .eq('service_sub_category', 'accessories');
  if (pErr) throw new Error(pErr.message);
  const profilesMoved = await migrateProfileRows(supabase, accessoryProfiles || []);
  console.log('profiles service_sub_category accessories→cosmetics:', profilesMoved);

  // also scan a broader set where store_data may still say accessories
  const { data: productMerchants, error: mErr } = await supabase
    .from('merchant_profiles')
    .select('phone, service_sub_category, store_data')
    .eq('primary_service_id', 'product')
    .limit(2000);
  if (mErr) {
    console.warn('broad profile scan skipped:', mErr.message);
  } else {
    const leftover = (productMerchants || []).filter((row) => {
      const store = row.store_data && typeof row.store_data === 'object' ? row.store_data : {};
      const storeSub = String(
        store.service_sub_category ||
          store.serviceSubCategory ||
          store.subCategoryId ||
          '',
      ).trim();
      return storeSub === 'accessories';
    });
    const extra = await migrateProfileRows(supabase, leftover);
    console.log('profiles store_data accessories→cosmetics:', extra);
  }

  console.log('DONE');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
