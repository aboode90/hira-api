// LEGACY — bazaar removed from Talab app
require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  const t = await s
    .from('merchant_profiles')
    .select('phone,store_name,primary_service_id,service_ids,is_bazaar_member');
  if (t.error) { console.log('ERR', t.error.message); return; }

  for (const m of (t.data || [])) {
    const ids = Array.isArray(m.service_ids) ? m.service_ids : [];
    if (!ids.includes('restaurant')) continue;
    if (m.primary_service_id === 'restaurant') continue;
    // primary != restaurant لكن service_ids يحوي restaurant
    const prods = await s
      .from('merchant_products')
      .select('category')
      .in('phone', ['+964' + m.phone.replace(/\D/g, '').slice(-9), m.phone, m.phone.replace(/^\+/, '')].filter(Boolean))
      .limit(200);
    const catDist = {};
    for (const r of (prods.data || [])) {
      catDist[r.category || r.service_id] = (catDist[r.category || r.service_id] || 0) + 1;
    }
    console.log(
      m.phone + ' | ' + m.store_name +
      ' | primary=' + m.primary_service_id +
      ' | has_restaurant_in_ids=YES' +
      ' | product_cats=' + JSON.stringify(catDist)
    );
  }
})();
