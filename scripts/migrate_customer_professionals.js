/**
 * ترحيل المهنيين من merchant_service_profiles → customer_professional_profiles
 * بدون حذف المصدر.
 *
 * Usage: cd backend && node scripts/migrate_customer_professionals.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { assertSupabaseAdmin } = require('../supabase_repo/common');
const {
  upsertCustomerProfessional,
  professionalRowId,
} = require('../supabase_repo/customer_professional_store');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('merchant_service_profiles')
    .select('*')
    .eq('service_id', 'professionals')
    .limit(5000);
  if (error) throw error;

  let migrated = 0;
  let skipped = 0;
  const errors = [];

  for (const row of data || []) {
    const phone = String(row.phone || '').trim();
    const professionId = String(
      row.professional_category_id || row.service_sub_category || '',
    ).trim();
    if (!phone || !professionId) {
      skipped += 1;
      continue;
    }
    try {
      if (!DRY_RUN) {
        await upsertCustomerProfessional(
          {
            ...row,
            legacy_id: professionalRowId(phone, professionId),
            migrated_from: 'merchant_service_profiles',
          },
          phone,
          professionId,
        );
      }
      migrated += 1;
    } catch (err) {
      errors.push({ phone, professionId, message: err?.message || String(err) });
    }
  }

  console.log(JSON.stringify({ dryRun: DRY_RUN, scanned: (data || []).length, migrated, skipped, errors: errors.slice(0, 20), errorCount: errors.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
