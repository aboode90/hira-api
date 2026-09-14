require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  const t = await s
    .from('customer_orders')
    .select('id,status_key,merchant_phone,order_payload')
    .limit(5000);
  if (t.error) { console.log('ERR', t.error.message); return; }
  console.log('TOTAL ORDERS (limit 5000):', t.data.length);

  const byStatus = {};
  for (const r of t.data) {
    const st = String(r.status_key || r.status || 'unknown');
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  console.log('STATUS DIST:', JSON.stringify(byStatus));

  // اختبار: كم منتج لديه productId في lineItems
  let withPid = 0, totalItems = 0;
  for (const r of t.data) {
    const op = r.order_payload || {};
    const items = Array.isArray(op.lineItems) ? op.lineItems : (Array.isArray(op.items) ? op.items : []);
    for (const it of items) {
      totalItems++;
      if (it && (it.productId || it.product_id)) withPid++;
    }
  }
  console.log('TOTAL LINE ITEMS:', totalItems, '| with productId:', withPid);

  // هل كل المطاعم تضع productId؟
  const restaurantOrders = t.data.filter((r) => String(r.merchant_phone || '').includes('7753848637') || String(r.merchant_phone || '').includes('7712413427'));
  console.log('MARZA/HATEM ORDERS:', restaurantOrders.length);
})();
