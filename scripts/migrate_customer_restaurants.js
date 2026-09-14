/**
 * ترحيل مطاعم الزبون من merchant_profiles → customer_restaurant_profiles
 * + منيو restaurant من merchant_products → customer_restaurant_products
 * بدون حذف المصدر.
 *
 * Usage: cd backend && node scripts/migrate_customer_restaurants.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { assertSupabaseAdmin, saveRow, nowIso } = require('../supabase_repo/common');

const DRY_RUN = process.argv.includes('--dry-run');

function restaurantIdForPhone(phone) {
  return `restaurant::${String(phone || '').trim()}`;
}

async function main() {
  const supabase = assertSupabaseAdmin();

  const { data: profiles, error } = await supabase
    .from('merchant_profiles')
    .select('*')
    .limit(8000);
  if (error) throw error;

  const restaurantPhones = [];
  for (const row of profiles || []) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    const ids = Array.isArray(row.service_ids)
      ? row.service_ids.map(String)
      : [];
    const primary = String(row.primary_service_id || '').trim();
    if (ids.includes('restaurant') || primary === 'restaurant') {
      restaurantPhones.push(phone);
    }
  }

  let profilesMigrated = 0;
  let productsMigrated = 0;
  const errors = [];

  for (const phone of restaurantPhones) {
    const profile = (profiles || []).find((p) => String(p.phone) === phone) || {};
    const id = restaurantIdForPhone(phone);
    const row = {
      id,
      owner_phone: phone,
      store_name: String(profile.store_name || profile.name || phone).trim() || phone,
      description: profile.description || '',
      address: profile.address || '',
      restaurant_category: profile.restaurant_category || null,
      restaurant_cuisine: profile.restaurant_cuisine || profile.service_sub_category || null,
      service_sub_category: profile.service_sub_category || null,
      whatsapp: profile.whatsapp || phone,
      open_time: profile.open_time || '',
      close_time: profile.close_time || '',
      latitude: profile.latitude ?? null,
      longitude: profile.longitude ?? null,
      cover_image_url: profile.cover_image_url || null,
      logo_image_url: profile.logo_image_url || null,
      profile_image_base64: profile.profile_image_base64 || null,
      is_open: profile.is_open !== false,
      is_approved: Boolean(profile.is_approved),
      approval_status: profile.approval_status || 'pending',
      is_frozen: Boolean(profile.is_frozen),
      legacy_phone: phone,
      migrated_from: 'merchant_profiles',
      created_at: profile.created_at || nowIso(),
      updated_at: nowIso(),
    };
    try {
      if (!DRY_RUN) await saveRow('customer_restaurant_profiles', row, 'id');
      profilesMigrated += 1;
    } catch (err) {
      errors.push({ phone, type: 'profile', message: err?.message || String(err) });
      continue;
    }

    const { data: products, error: pErr } = await supabase
      .from('merchant_products')
      .select('*')
      .eq('phone', phone)
      .eq('category', 'restaurant')
      .limit(2000);
    if (pErr) {
      errors.push({ phone, type: 'products_fetch', message: pErr.message });
      continue;
    }
    for (const product of products || []) {
      const productRow = {
        id: String(product.id),
        restaurant_id: id,
        owner_phone: phone,
        name_ar: product.name_ar,
        name_en: product.name_en,
        description_ar: product.description_ar,
        description_en: product.description_en,
        price: product.price,
        category: 'restaurant',
        service_id: 'restaurant',
        sub_category: product.sub_category,
        section_id: product.section_id,
        is_available: product.is_available !== false,
        stock_quantity: product.stock_quantity,
        image: product.image,
        image_url: product.image_url,
        image_base64: product.image_base64,
        is_approved: Boolean(product.is_approved),
        approval_status: product.approval_status || 'pending',
        rejection_message_ar: product.rejection_message_ar,
        rejected_at: product.rejected_at,
        times_ordered: product.times_ordered || 0,
        legacy_id: String(product.id),
        migrated_from: 'merchant_products',
        created_at: product.created_at || nowIso(),
        updated_at: nowIso(),
      };
      try {
        if (!DRY_RUN) await saveRow('customer_restaurant_products', productRow, 'id');
        productsMigrated += 1;
      } catch (err) {
        errors.push({
          phone,
          id: product.id,
          type: 'product',
          message: err?.message || String(err),
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        restaurantPhones: restaurantPhones.length,
        profilesMigrated,
        productsMigrated,
        errorCount: errors.length,
        errors: errors.slice(0, 30),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
