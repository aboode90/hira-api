const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE env');
    process.exit(1);
  }
  const supabase = createClient(url, key);
  let { data, error } = await supabase
    .from('customer_orders')
    .select('id, order_number, merchant_phone, phone, status_key, order_payload, created_at')
    .ilike('order_number', '%158759%')
    .limit(10);
  if (error) {
    console.error('Query by number error:', error.message);
  }
  if (!data || data.length === 0) {
    const r2 = await supabase
      .from('customer_orders')
      .select('id, order_number, merchant_phone, phone, status_key, order_payload, created_at')
      .ilike('order_payload', '%158759%')
      .limit(10);
    if (r2.error) console.error('Query by payload error:', r2.error.message);
    data = r2.data;
  }
  console.log('Found rows:', Array.isArray(data) ? data.length : 0);
  for (const row of data || []) {
    const p = row.order_payload || {};
    const mLat = Number(p.merchantLatitude || 0);
    const mLng = Number(p.merchantLongitude || 0);
    const cLat = Number(p.customerLatitude || 0);
    const cLng = Number(p.customerLongitude || 0);
    console.log('---');
    console.log('order_number:', row.order_number);
    console.log('merchant:', p.merchantStoreName || row.merchant_phone);
    console.log('items:', p.itemsNameAr);
    console.log('merchant coords:', mLat, mLng);
    console.log('customer coords:', cLat, cLng);
    const d = haversineKm(mLat, mLng, cLat, cLng);
    console.log('DISTANCE straight:', d.toFixed(2), 'km');
    console.log('DISTANCE road approx (x1.3):', (d * 1.3).toFixed(2), 'km');
    console.log('deliveryFeeIqd:', p.deliveryFeeIqd);
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
