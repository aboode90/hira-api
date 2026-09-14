require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  for (const phone of ['+9647722805954', '+9647741018605']) {
    const p = await s.from('merchant_products').select('category,service_id,name_ar').eq('phone', phone).limit(40);
    const cats = {};
    for (const r of p.data || []) {
      const k = r.category + '|' + r.service_id;
      cats[k] = (cats[k] || 0) + 1;
    }
    console.log(phone + ' PRODUCT CATEGORY DIST:', JSON.stringify(cats));
    console.log('  samples:', (p.data || []).slice(0, 5).map((r) => '[' + r.category + '] ' + r.name_ar).join(' ; '));
  }
})();
