// LEGACY — bazaar removed from Talab app
require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  const t = await s
    .from('merchant_profiles')
    .select('phone,store_name,primary_service_id,service_ids,restaurant_category,service_enabled,is_bazaar_member');
  if (t.error) { console.log('ERR', t.error.message); return; }

  console.log('--- Bazaar members containing restaurant in service_ids ---');
  for (const m of (t.data || [])) {
    if (m.is_bazaar_member !== true) continue;
    const ids = Array.isArray(m.service_ids) ? m.service_ids : [];
    if (!ids.includes('restaurant')) continue;
    console.log(
      m.phone + ' | ' + m.store_name +
      ' | primary=' + m.primary_service_id +
      ' | restaurant_category=' + (m.restaurant_category || '-') +
      ' | enabled.restaurant=' + (m.service_enabled ? m.service_enabled.restaurant : '-')
    );
  }
})();
