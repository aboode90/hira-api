require('dotenv').config();
const m = require('./supabase_repo/merchants');

(async () => {
  const t0 = Date.now();
  const c1 = await m.buildProductOrderCounts();
  const first = Date.now() - t0;
  const t1 = Date.now();
  const c2 = await m.buildProductOrderCounts();
  const second = Date.now() - t1;
  console.log('first ms:', first, '| cached ms:', second, '| same instance:', c1 === c2);
  m.invalidateProductOrderCountsCache();
  const c3 = await m.buildProductOrderCounts();
  console.log('after invalidate, fresh:', c3 !== c2);
  console.log('size:', c3.size);
})();
