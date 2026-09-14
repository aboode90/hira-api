/**
 * ترحيل إعلانات الزبون (عقارات/مستعمل/عروض) من merchant_products → customer_listings.
 * Idempotent: لا يحذف المصدر، ويُعيد الكتابة بنفس id فقط.
 *
 * Usage:
 *   cd backend && node scripts/migrate_customer_listings.js
 *   cd backend && node scripts/migrate_customer_listings.js --dry-run
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { assertSupabaseAdmin } = require('../supabase_repo/common');
const {
  upsertCustomerListing,
  domainFromCategory,
  countCustomerListingsByDomain,
} = require('../supabase_repo/customer_listings');

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 500;

async function fetchPage(from, to) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('merchant_products')
    .select('*')
    .or(
      'category.eq.real_estate,and(category.eq.used,listing_mode.eq.customer_used),and(category.eq.offers,listing_mode.eq.customer_offer)',
    )
    .order('id', { ascending: true })
    .range(from, to);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function main() {
  const before = await countCustomerListingsByDomain();
  if (before.tableMissing) {
    console.error(
      'customer_listings missing. Apply supabase/20260902_customer_publish_decoupling.sql first.',
    );
    process.exit(1);
  }

  let offset = 0;
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  const errors = [];

  for (;;) {
    const rows = await fetchPage(offset, offset + PAGE - 1);
    if (!rows.length) break;
    for (const row of rows) {
      scanned += 1;
      const domain = domainFromCategory(row.category, row.listing_mode);
      if (!domain) {
        skipped += 1;
        continue;
      }
      const ownerPhone = String(row.phone || '').trim();
      if (!ownerPhone || !row.id) {
        skipped += 1;
        continue;
      }
      try {
        if (!DRY_RUN) {
          await upsertCustomerListing(row, {
            domain,
            ownerPhone,
            legacyId: String(row.id),
          });
        }
        migrated += 1;
      } catch (error) {
        errors.push({ id: row.id, message: error?.message || String(error) });
      }
    }
    offset += PAGE;
    if (rows.length < PAGE) break;
  }

  const after = DRY_RUN ? before : await countCustomerListingsByDomain();
  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        scanned,
        migrated,
        skipped,
        errors: errors.slice(0, 20),
        errorCount: errors.length,
        before,
        after,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
