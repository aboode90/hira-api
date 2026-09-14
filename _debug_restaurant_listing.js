require('dotenv').config();
const { assertSupabaseAdmin, getPhoneVariants, selectMany } = require('./supabase_repo/common');
const merchants = require('./supabase_repo/merchants');
const sp = require('./supabase_repo/merchant_service_profiles');

const TARGET = '+9647732487645';

async function main() {
  const supabase = assertSupabaseAdmin();

  // 1. استدعاء القائمة الفعلية ومطابقتها
  const stores = await merchants.listRestaurantStores('');
  const targetListed = stores.filter(
    (s) => String(s?.phone || s?.profile?.phone || '').includes('7732487645')
  );
  console.log('listRestaurantStores total:', stores.length);
  console.log('target in list:', targetListed.length > 0);
  for (const s of stores.slice(0, 3)) {
    console.log('  listed:', JSON.stringify({ phone: s?.phone || s?.profile?.phone, name: s?.store_name || s?.storeName || s?.profile?.store_name }));
  }

  // 2. إعادة بناء خطوات الفلترة يدوياً
  const profiles = await selectMany('merchant_profiles', [], undefined, 2000);
  const profile = profiles.find((p) => String(p.phone).trim() === TARGET);
  if (!profile) {
    console.log('PROFILE NOT FOUND in merchant_profiles for', TARGET);
    return;
  }
  console.log('\n--- profile checks ---');
  console.log('is_open:', profile.is_open, '| frozen:', merchants.isMerchantFrozen ? merchants.isMerchantFrozen(profile) : 'n/a');
  console.log('isMerchantApproved:', merchants.isMerchantApproved(profile));
  console.log('serviceIds:', merchants.profileServiceIds(profile));
  console.log('serviceEnabled(restaurant):', merchants.isMerchantServiceEnabled(profile, 'restaurant'));
  console.log('qualifies:', merchants.merchantQualifiesForServiceListing(profile, 'restaurant'));

  // 3. service profiles
  const serviceProfilesByPhone = await sp.loadServiceProfilesByPhone();
  const variants = getPhoneVariants(TARGET);
  let rows = [];
  for (const v of variants) {
    const r = serviceProfilesByPhone.get(v);
    if (r && r.length) { rows = r; break; }
  }
  console.log('\nservice profile rows for target:', rows.length);
  for (const r of rows) {
    console.log('  row:', JSON.stringify({ service_id: r.service_id, sub: r.service_sub_category, is_approved: r.is_approved, approval_status: r.approval_status, store_name: r.store_name }));
  }
  const resolved = sp.resolveListingProfileFromRows(profile, 'restaurant', '', rows);
  console.log('resolveListingProfileFromRows result:', resolved ? JSON.stringify({ phone: resolved.phone, store_name: resolved.store_name }) : 'NULL');

  // 4. مقارنة بمطعم ظاهر (كفيل غير موجود؟ خذ أي restaurant ظاهر)
  const otherListed = stores.find((s) => {
    const p = String(s?.phone || s?.profile?.phone || '');
    return p !== TARGET;
  });
  console.log('\nsample listed restaurant:', JSON.stringify(otherListed ? { phone: otherListed?.phone || otherListed?.profile?.phone, name: otherListed?.store_name || otherListed?.profile?.store_name } : null));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
