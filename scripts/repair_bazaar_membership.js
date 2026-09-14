#!/usr/bin/env node
// LEGACY — bazaar removed from Talab app
/**
 * إصلاح أرشيفي: كل المتاجر التي لديها is_bazaar_member=true لكن
 * service_ids لا يحوي bazar_ghaith — تُضاف bazar_ghaith إلى service_ids
 * ويُنشأ صف merchant_service_profiles بغرض bazar_ghaith حتى تظهر في بازار طلب.
 * التشغيل من backend/:
 *   node scripts/repair_bazaar_membership.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { assertSupabaseAdmin, getPhoneVariants } = require('../supabase_repo/common');
const { saveMerchantProfile } = require('../supabase_repo/merchants');
const { saveMerchantServiceProfile } = require('../supabase_repo/merchant_service_profiles');

async function main() {
  assertSupabaseAdmin();
  const supabase = assertSupabaseAdmin();
  const { data: profiles, error } = await supabase
    .from('merchant_profiles')
    .select('phone,store_name,is_bazaar_member,service_ids,primary_service_id,is_open,is_approved,service_enabled');
  if (error) throw new Error(error.message);

  const members = (profiles || []).filter((p) => p.is_bazaar_member === true);
  console.log('profiles:', profiles.length, '| bazaar members:', members.length);

  let fixed = 0;
  let skipped = 0;
  for (const profile of members) {
    const phone = String(profile.phone || '').trim();
    const ids = Array.isArray(profile.service_ids)
      ? profile.service_ids.map((id) => String(id).trim()).filter(Boolean)
      : (() => {
          const primary = String(profile.primary_service_id || '').trim();
          return primary ? [primary] : [];
        })();

    const hasBazaar = ids.includes('bazar_ghaith');
    if (hasBazaar) {
      skipped += 1;
      continue;
    }

    const nextServiceIds = [...ids, 'bazar_ghaith'];
    await saveMerchantProfile(
      phone,
      {
        is_bazaar_member: true,
        service_ids: nextServiceIds,
        serviceIds: nextServiceIds,
        service_enabled: {
          ...(profile.service_enabled || {}),
          bazar_ghaith: true,
        },
        _adminModerationBypass: true,
      }
    );

    const storeName = String(profile.store_name || '').trim() || phone;
    await saveMerchantServiceProfile(
      phone,
      'bazar_ghaith',
      {
        store_name: storeName,
        is_approved: true,
        approval_status: 'approved',
        is_open: profile.is_open ?? true,
      },
      ''
    );

    fixed += 1;
    console.log(`  ✓ ${phone} | ${storeName} → added bazar_ghaith`);
  }

  console.log(`\nDone. fixed=${fixed}, skipped=${skipped}`);
}

main().catch((e) => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
