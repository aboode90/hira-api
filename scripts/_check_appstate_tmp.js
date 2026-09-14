const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing env'); process.exit(1); }
  const supabase = createClient(url, key);
  const raw = '07804020545';
  const uniq = [...new Set([raw, `+964${raw.replace(/^0/, '')}`, `964${raw.replace(/^0/, '')}`, `+${raw}`, raw.replace(/^0/, '')])];

  const { data, error } = await supabase.from('app_state').select('*').in('phone', uniq).limit(3);
  if (error) { console.error('app_state ERR:', error.message); process.exit(1); }
  console.log('app_state rows:', (data || []).length);
  for (const row of data || []) {
    const s = row.state || {};
    console.log('phone:', row.phone);
    console.log('FULL state keys:', Object.keys(s).join(', '));
    console.log('FULL state JSON:', JSON.stringify(s).slice(0, 4000));
  }

  const { data: us, error: usErr } = await supabase.from('user_state').select('*').in('phone', uniq).limit(3);
  if (usErr) console.error('user_state ERR:', usErr.message);
  else {
    console.log('user_state rows:', (us || []).length);
    for (const row of us || []) {
      const s = row.state || row.profile || {};
      const cp = s.courierProfile;
      console.log('user_state phone:', row.phone);
      console.log('user_state keys:', Object.keys(s).join(', '));
      if (cp) {
        console.log('  courierProfile keys:', Object.keys(cp).join(', '));
        console.log('  name:', cp.name || cp.fullName || '');
        console.log('  approvalStatus:', cp.approvalStatus || cp.approval_status || '');
        console.log('  isApproved:', cp.isApproved ?? cp.is_approved ?? '');
        console.log('  available:', cp.available ?? '');
      }
    }
  }

  const { data: cpRows, error: cpErr } = await supabase
    .from('courier_profiles')
    .select('*')
    .ilike('phone', '%7804020545%')
    .limit(5);
  if (cpErr) console.error('courier_profiles ilike ERR:', cpErr.message);
  else {
    console.log('courier_profiles partial match:', (cpRows || []).length);
    for (const r of cpRows || []) console.log('  phone:', r.phone, '| name:', r.display_name || r.name || '', '| approved:', r.is_approved, '| available:', r.available);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
