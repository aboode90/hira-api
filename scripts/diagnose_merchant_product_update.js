/**
 * Diagnose merchant product update failures (orphaned section_id, save path).
 * Uses backend/.env — does not print secrets.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  getSupabaseAdmin,
  assertSupabaseAdmin,
} = require('../supabase_repo/common');
const {
  saveMerchantProduct,
  getMerchantProfile,
  merchantProfileSections,
} = require('../supabase_repo/merchants');

function maskPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 6) return '***';
  return `${p.slice(0, 3)}****${p.slice(-2)}`;
}

async function main() {
  assertSupabaseAdmin();
  const supabase = getSupabaseAdmin();

  console.log('=== Merchant product update diagnosis ===\n');

  // 1) Load products with section_id
  const { data: products, error: prodErr } = await supabase
    .from('merchant_products')
    .select('id, phone, name_ar, price, section_id, category, service_id, image, image_base64, is_available')
    .not('section_id', 'is', null)
    .neq('section_id', '')
    .limit(2000);

  if (prodErr) {
    console.error('Failed to load products:', prodErr.message);
    process.exit(1);
  }

  console.log(`Products with non-empty section_id (sample cap 2000): ${products.length}`);

  // Load profiles for those phones
  const phones = [...new Set(products.map((p) => String(p.phone || '').trim()).filter(Boolean))];
  const { data: profiles, error: profErr } = await supabase
    .from('merchant_profiles')
    .select('phone, product_sections, primary_service_id, store_name')
    .in('phone', phones);

  if (profErr) {
    console.error('Failed to load profiles:', profErr.message);
    process.exit(1);
  }

  const profileByPhone = new Map();
  for (const p of profiles || []) {
    profileByPhone.set(String(p.phone || '').trim(), p);
  }

  const orphans = [];
  const validWithSection = [];
  for (const row of products) {
    const phone = String(row.phone || '').trim();
    const sectionId = String(row.section_id || '').trim();
    const profile = profileByPhone.get(phone);
    const sections = merchantProfileSections(profile || {});
    const known = sections.some((s) => String(s?.id ?? '').trim() === sectionId);
    if (!profile) {
      orphans.push({ ...row, reason: 'no_profile' });
    } else if (!known) {
      orphans.push({ ...row, reason: 'orphan_section', sectionCount: sections.length });
    } else {
      validWithSection.push(row);
    }
  }

  console.log(`\nOrphan section_id products: ${orphans.length}`);
  console.log(`Valid section_id products: ${validWithSection.length}`);

  const orphanPhones = [...new Set(orphans.map((o) => maskPhone(o.phone)))];
  console.log(`Sample orphan phones (masked, up to 15): ${orphanPhones.slice(0, 15).join(', ') || '(none)'}`);
  console.log('Sample orphans (up to 8):');
  for (const o of orphans.slice(0, 8)) {
    console.log(
      `  id=${o.id} phone=${maskPhone(o.phone)} section=${String(o.section_id).slice(0, 8)}… reason=${o.reason} cat=${o.category}`
    );
  }

  // 2) Pick a valid product and simulate name/price update via saveMerchantProduct
  const target = validWithSection[0] || products[0];
  if (!target) {
    console.log('\nNo products found to simulate update.');
    process.exit(0);
  }

  console.log(`\n=== Simulate saveMerchantProduct on id=${target.id} phone=${maskPhone(target.phone)} ===`);
  const profile = await getMerchantProfile(target.phone);
  const sections = merchantProfileSections(profile || {});
  const sectionId = String(target.section_id || '').trim();
  const sectionKnown = sections.some((s) => String(s?.id ?? '').trim() === sectionId);
  console.log(`section_id present: ${Boolean(sectionId)}, known in profile: ${sectionKnown}, profile sections: ${sections.length}`);

  const originalName = String(target.name_ar || '');
  const originalPrice = Number(target.price) || 0;
  const probeName = originalName.endsWith(' ·')
    ? originalName.slice(0, -2)
    : `${originalName} ·`;
  const probePrice = originalPrice;

  try {
    const saved = await saveMerchantProduct(target.phone, {
      id: target.id,
      name_ar: probeName,
      name_en: target.name_en,
      price: probePrice,
      category: target.category,
      service_id: target.service_id || target.category,
      section_id: target.section_id,
      image: target.image,
      is_available: target.is_available,
    });
    console.log('SAVE_OK', {
      id: saved?.id,
      name_ar: saved?.name_ar,
      price: saved?.price,
      section_id: saved?.section_id,
      is_approved: saved?.is_approved,
      approval_status: saved?.approval_status,
    });

    // Restore original name
    await saveMerchantProduct(target.phone, {
      id: target.id,
      name_ar: originalName,
      price: originalPrice,
      category: target.category,
      service_id: target.service_id || target.category,
      section_id: target.section_id,
      image: target.image,
      is_available: target.is_available,
    });
    console.log('RESTORE_OK');
  } catch (err) {
    console.error('SAVE_FAILED:', err?.message || err);
    console.error('stack:', err?.stack?.split('\n').slice(0, 5).join('\n'));
  }

  // 3) If orphans exist, try updating one (should succeed with current fix)
  if (orphans.length > 0) {
    const orphan = orphans.find((o) => o.reason === 'orphan_section') || orphans[0];
    console.log(`\n=== Simulate update on ORPHAN product id=${orphan.id} phone=${maskPhone(orphan.phone)} ===`);
    try {
      const saved = await saveMerchantProduct(orphan.phone, {
        id: orphan.id,
        name_ar: String(orphan.name_ar || 'test'),
        price: Number(orphan.price) || 0,
        category: orphan.category,
        service_id: orphan.service_id || orphan.category,
        section_id: orphan.section_id,
        image: orphan.image,
        is_available: orphan.is_available,
      });
      console.log('ORPHAN_SAVE_OK', {
        id: saved?.id,
        section_id: saved?.section_id,
        name_ar: saved?.name_ar,
        approval_status: saved?.approval_status,
      });
    } catch (err) {
      console.error('ORPHAN_SAVE_FAILED:', err?.message || err);
    }
  }

  // 4) Check columns / constraints hints
  const { data: one, error: oneErr } = await supabase
    .from('merchant_products')
    .select('*')
    .limit(1)
    .maybeSingle();
  if (!oneErr && one) {
    console.log('\nmerchant_products columns sample:', Object.keys(one).sort().join(', '));
  }

  // Count total products vs orphans more carefully with pagination note
  const { count: totalCount } = await supabase
    .from('merchant_products')
    .select('id', { count: 'exact', head: true });
  const { count: withSectionCount } = await supabase
    .from('merchant_products')
    .select('id', { count: 'exact', head: true })
    .not('section_id', 'is', null)
    .neq('section_id', '');

  console.log(`\nTotals: merchant_products=${totalCount}, with section_id=${withSectionCount}`);
  console.log(`Orphans in loaded sample: ${orphans.length} / ${products.length}`);
}

main().catch((e) => {
  console.error('FATAL:', e?.message || e);
  process.exit(1);
});
