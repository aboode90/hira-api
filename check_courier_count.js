require('dotenv').config();
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)[1];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  const pool = new Pool({
    connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 15000,
  });

  const client = await pool.connect();
  try {
    const couriers = await client.query('SELECT phone, display_name, approval_status, is_approved FROM courier_profiles ORDER BY updated_at DESC');
    console.log(`\n=== مندوبو التوصيل (${couriers.rows.length}) ===`);
    couriers.rows.forEach(r => {
      console.log(`  ${r.phone} | ${r.display_name || '(بدون اسم)'} | الحالة: ${r.approval_status} | مفعّل: ${r.is_approved}`);
    });

    const appState = await client.query("SELECT phone, state->'courierProfile'->>'name' as name, state->>'courierProfileComplete' as complete, state->>'adminPreRegisteredCourier' as preReg FROM app_state WHERE state ? 'courierProfile' ORDER BY updated_at DESC");
    console.log(`\n=== app_state (${appState.rows.length}) ===`);
    appState.rows.forEach(r => {
      console.log(`  ${r.phone} | ${r.name || '(بدون اسم)'} | مكتمل: ${r.complete} | مسجل مسبقاً: ${r.preReg}`);
    });

    const users = await client.query("SELECT phone, role, account_type FROM app_users WHERE role = 'customer' AND account_type = 'marketplace' ORDER BY updated_at DESC LIMIT 5");
    console.log(`\n=== آخر 5 مستخدمين ===`);
    users.rows.forEach(r => console.log(`  ${r.phone} | دور: ${r.role} | نوع: ${r.account_type}`));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => console.error('خطأ:', e.message));
