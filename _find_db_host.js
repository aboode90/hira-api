require('dotenv').config();
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)[1];
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hosts = [
  `aws-0-eu-central-1.pooler.supabase.com`,
  `aws-0-eu-west-1.pooler.supabase.com`,
  `aws-0-eu-west-2.pooler.supabase.com`,
  `aws-0-eu-west-3.pooler.supabase.com`,
  `aws-0-us-east-1.pooler.supabase.com`,
  `aws-0-us-west-1.pooler.supabase.com`,
  `db.${projectRef}.supabase.co`,
];

async function tryHost(host) {
  const pool = new Pool({
    connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(key)}@${host}:6543/postgres?pgbouncer=true`,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 12000,
  });
  try {
    const r = await pool.query('SELECT 1 as ok');
    await pool.end();
    return r.rows[0].ok === 1;
  } catch (e) {
    try { await pool.end(); } catch (_) {}
    return false;
  }
}

(async () => {
  for (const host of hosts) {
    const ok = await tryHost(host);
    console.log(`${ok ? 'CONNECTED' : 'fail     '} -> ${host}`);
    if (ok) process.exit(0);
  }
  console.log('ALL FAILED');
  process.exit(1);
})();
