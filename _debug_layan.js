require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  const t = await s
    .from('merchant_products')
    .select('id,name_ar,category,service_id,section_id,price')
    .eq('phone', '+9647741018605')
    .limit(50);
  console.log('PRODUCTS COUNT:', (t.data || []).length);
  for (const r of t.data || []) {
    console.log('  [' + r.category + '|' + r.service_id + '] ' + r.name_ar + ' (' + r.price + ')');
  }
})();
