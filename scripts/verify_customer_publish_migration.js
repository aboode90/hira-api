/**
 * تحقق بعد ترحيل نشر الزبون: مقارنة counts بين المصدر والهدف.
 *
 * Usage: cd backend && node scripts/verify_customer_publish_migration.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { assertSupabaseAdmin } = require('../supabase_repo/common');

async function count(table, apply = (q) => q) {
  const supabase = assertSupabaseAdmin();
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  q = apply(q);
  const { count: c, error } = await q;
  if (error) {
    if (/relation|does not exist|42P01/i.test(error.message)) {
      return { missing: true, count: 0 };
    }
    throw error;
  }
  return { missing: false, count: Number(c) || 0 };
}

async function sample(table, apply, limit = 3) {
  const supabase = assertSupabaseAdmin();
  let q = supabase.from(table).select('id,owner_phone,phone,category,domain,store_name,name_ar').limit(limit);
  q = apply(q);
  const { data, error } = await q;
  if (error) return [];
  return data || [];
}

async function main() {
  const report = { at: new Date().toISOString(), domains: {}, ok: true };

  report.domains.real_estate = {
    source: await count('merchant_products', (q) => q.eq('category', 'real_estate')),
    target: await count('customer_listings', (q) => q.eq('domain', 'real_estate')),
  };
  report.domains.used = {
    source: await count('merchant_products', (q) =>
      q.eq('category', 'used').eq('listing_mode', 'customer_used'),
    ),
    target: await count('customer_listings', (q) => q.eq('domain', 'used')),
  };
  report.domains.offers = {
    source: await count('merchant_products', (q) =>
      q.eq('category', 'offers').eq('listing_mode', 'customer_offer'),
    ),
    target: await count('customer_listings', (q) => q.eq('domain', 'offers')),
  };
  report.domains.professionals = {
    source: await count('merchant_service_profiles', (q) =>
      q.eq('service_id', 'professionals'),
    ),
    target: await count('customer_professional_profiles', (q) => q),
  };
  report.domains.restaurants = {
    sourceNote: 'profiles with restaurant in service_ids counted separately in migrate script',
    targetProfiles: await count('customer_restaurant_profiles', (q) => q),
    targetProducts: await count('customer_restaurant_products', (q) => q),
  };

  for (const [name, block] of Object.entries(report.domains)) {
    if (block.target?.missing || block.targetProfiles?.missing) {
      report.ok = false;
      block.status = 'TARGET_TABLE_MISSING';
      continue;
    }
    if (block.source && block.target && block.source.count > block.target.count) {
      report.ok = false;
      block.status = 'TARGET_BEHIND_SOURCE';
    } else if (block.source && block.target) {
      block.status = 'OK_OR_AHEAD';
    }
  }

  report.samples = {
    listings: await sample('customer_listings', (q) => q, 5),
    professionals: await sample('customer_professional_profiles', (q) => q, 3),
    restaurants: await sample('customer_restaurant_profiles', (q) => q, 3),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
