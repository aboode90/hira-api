/**
 * جرد صفوف نشر الزبون في الجداول القديمة والجديدة (بدون تعديل بيانات).
 *
 * Usage:
 *   cd backend && node scripts/inventory_customer_publish.js
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env / .env
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { assertSupabaseAdmin } = require('../supabase_repo/common');

async function countEq(table, column, value) {
  const supabase = assertSupabaseAdmin();
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (column) q = q.eq(column, value);
  const { count, error } = await q;
  if (error) throw new Error(`${table}.${column}=${value}: ${error.message}`);
  return Number(count) || 0;
}

async function countFilter(table, apply) {
  const supabase = assertSupabaseAdmin();
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  q = apply(q);
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return Number(count) || 0;
}

async function tableExists(table) {
  try {
    const supabase = assertSupabaseAdmin();
    const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error && /relation|does not exist|42P01/i.test(error.message)) return false;
    if (error) throw error;
    return true;
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) return false;
    throw error;
  }
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    merchant_products: {},
    merchant_profiles: {},
    merchant_service_profiles: {},
    customer_tables: {},
  };

  report.merchant_products.real_estate = await countEq(
    'merchant_products',
    'category',
    'real_estate',
  );
  report.merchant_products.used_customer = await countFilter('merchant_products', (q) =>
    q.eq('category', 'used').eq('listing_mode', 'customer_used'),
  );
  report.merchant_products.offers_customer = await countFilter('merchant_products', (q) =>
    q.eq('category', 'offers').eq('listing_mode', 'customer_offer'),
  );
  report.merchant_products.restaurant_menu = await countEq(
    'merchant_products',
    'category',
    'restaurant',
  );

  report.merchant_profiles.restaurant_primary = await countEq(
    'merchant_profiles',
    'primary_service_id',
    'restaurant',
  );

  try {
    report.merchant_service_profiles.professionals = await countEq(
      'merchant_service_profiles',
      'service_id',
      'professionals',
    );
  } catch (error) {
    report.merchant_service_profiles.professionals = `error: ${error.message}`;
  }

  for (const table of [
    'customer_listings',
    'customer_professional_profiles',
    'customer_restaurant_profiles',
    'customer_restaurant_products',
  ]) {
    const exists = await tableExists(table);
    report.customer_tables[table] = { exists };
    if (!exists) continue;
    report.customer_tables[table].total = await countFilter(table, (q) => q);
  }

  if (report.customer_tables.customer_listings?.exists) {
    report.customer_tables.customer_listings.by_domain = {
      real_estate: await countEq('customer_listings', 'domain', 'real_estate'),
      used: await countEq('customer_listings', 'domain', 'used'),
      offers: await countEq('customer_listings', 'domain', 'offers'),
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
