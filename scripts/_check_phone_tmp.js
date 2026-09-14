const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing env'); process.exit(1); }
  const supabase = createClient(url, key);
  const raw = '07746269390';
  const uniq = [...new Set([raw, `+964${raw.replace(/^0/, '')}`, `964${raw.replace(/^0/, '')}`, `+${raw}`, raw.replace(/^0/, '')])];

  for (const table of ['app_users', 'courier_profiles', 'driver_profiles', 'customer_profiles', 'merchant_profiles']) {
    const { data, error } = await supabase.from(table).select('*').in('phone', uniq).limit(3);
    if (error) { console.log(`[${table}] ERR:`, error.message); continue; }
    if (data && data.length) {
      for (const row of data) {
        if (table === 'app_users') {
          console.log(`[${table}] FOUND phone=${row.phone} role=${row.role} account_type=${row.account_type} is_active=${row.is_active}`);
        } else {
          console.log(`[${table}] FOUND phone=${row.phone} approved=${row.is_approved} available=${row.available} suspended=${row.is_suspended} status=${row.approval_status}`);
        }
      }
    } else {
      console.log(`[${table}] none`);
    }
  }

  const { data: stateRows, error: sErr } = await supabase
    .from('app_state')
    .select('phone, state')
    .in('phone', uniq)
    .limit(3);
  if (sErr) console.log('[app_state] ERR:', sErr.message);
  else {
    console.log('[app_state] rows:', (stateRows || []).length);
    for (const row of stateRows || []) {
      const s = row.state || {};
      console.log('  phone:', row.phone, '| has courierProfile:', Boolean(s.courierProfile), '| keys:', Object.keys(s).join(', '));
    }
  }

  const { data: tokens, error: tErr } = await supabase
    .from('device_tokens')
    .select('phone, platform, updated_at')
    .in('phone', uniq)
    .limit(5);
  if (tErr) console.log('[device_tokens] ERR:', tErr.message);
  else console.log('[device_tokens] count:', (tokens || []).length, JSON.stringify((tokens || []).map((t) => t.platform)));

  const { data: orders, error: oErr } = await supabase
    .from('customer_orders')
    .select('id, order_number, status_key, delivery_status_key, courier_phone, created_at')
    .in('courier_phone', uniq)
    .order('created_at', { ascending: false })
    .limit(10);
  if (oErr) console.log('[orders] ERR:', oErr.message);
  else console.log('[orders assigned] count:', (orders || []).length, JSON.stringify((orders || []).map((o) => ({ n: o.order_number, st: o.status_key, ds: o.delivery_status_key }))));
}

main().catch((e) => { console.error(e); process.exit(1); });
