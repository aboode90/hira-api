require('dotenv').config();
const m = require('./supabase_repo/merchants');

(async () => {
  const counts = await m.buildProductOrderCounts();
  console.log('COUNTS SIZE:', counts.size);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [pid, c] of top) console.log(pid, '=', c);

  // تحقق من حقن الحقل في قائمة المطاعم
  const stores = await m.listRestaurantStores();
  const marza = stores.find((s) => String(s?.phone || s?.profile?.phone || '').includes('7753848637'));
  if (marza) {
    const withOrders = (marza.products || []).filter((p) => (p.timesOrdered || 0) > 0);
    console.log('MARZA products:', (marza.products || []).length, '| with timesOrdered>0:', withOrders.length);
    for (const p of withOrders) console.log('  ', p.name_ar, '=', p.timesOrdered);
  }
})();
