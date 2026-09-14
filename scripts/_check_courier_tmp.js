const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing env'); process.exit(1); }
  const supabase = createClient(url, key);
  const raw = '07804020545';
  const variants = [
    raw,
    `+964${raw.replace(/^0/, '')}`,
    `964${raw.replace(/^0/, '')}`,
    `+${raw}`,
    raw.replace(/^0/, ''),
  ];
  const uniq = [...new Set(variants)];

  for (const table of ['app_users', 'courier_profiles', 'driver_profiles', 'customer_profiles', 'merchant_profiles']) {
    const { data, error } = await supabase.from(table).select('*').in('phone', uniq).limit(3);
    if (error) { console.log(`[${table}] ERR:`, error.message); continue; }
    if (data && data.length) {
      for (const row of data) {
        console.log(`[${table}] FOUND:`, JSON.stringify(row, null, 2).slice(0, 1200));
      }
    } else {
      console.log(`[${table}] none`);
    }
  }

  const { data: tokens, error: tErr } = await supabase
    .from('device_tokens')
    .select('phone, token, platform, updated_at')
    .in('phone', uniq)
    .limit(5);
  if (tErr) console.log('[device_tokens] ERR:', tErr.message);
  else console.log('[device_tokens]:', JSON.stringify(tokens, null, 2));

  const { data: byCourier, error: cErr } = await supabase
    .from('customer_orders')
    .select('id, order_number, status_key, delivery_status_key, courier_phone, created_at')
    .in('courier_phone', uniq)
    .order('created_at', { ascending: false })
    .limit(10);
  if (cErr) console.log('[by courier_phone] ERR:', cErr.message);
  else console.log('[orders assigned to this courier]:', (byCourier || []).length, JSON.stringify((byCourier || []).map((o) => ({ num: o.order_number, st: o.status_key, ds: o.delivery_status_key }))));

  const { data: byPayload, error: pErr } = await supabase
    .from('customer_orders')
    .select('id, order_number, status_key, delivery_status_key, created_at')
    .filter('order_payload', 'cs', raw.replace(/^0/, ''))
    .order('created_at', { ascending: false })
    .limit(5);
  if (pErr) console.log('[by payload contains] ERR:', pErr.message);
  else console.log('[orders payload contains 7804020545]:', (byPayload || []).map((o) => ({ num: o.order_number, st: o.status_key, ds: o.delivery_status_key })));
}

main().catch((e) => { console.error(e); process.exit(1); });
