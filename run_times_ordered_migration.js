require('dotenv').config();
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)[1];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const regions = [
  'aws-0-eu-central-1', 'aws-0-eu-west-1', 'aws-0-eu-west-2', 'aws-0-eu-west-3',
  'aws-0-us-east-1', 'aws-0-us-east-2', 'aws-0-us-west-1', 'aws-0-us-west-2',
  'aws-0-ap-southeast-1', 'aws-0-ap-southeast-2', 'aws-0-ap-northeast-1',
  'aws-0-ap-south-1', 'aws-0-sa-east-1', 'aws-0-ca-central-1',
];

async function tryHost(host) {
  const pool = new Pool({
    connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@${host}.pooler.supabase.com:6543/postgres`,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 12000,
  });
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    const check = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'merchant_products' AND column_name = 'times_ordered'
    `);
    if (check.rows.length === 0) {
      await client.query(`ALTER TABLE public.merchant_products ADD COLUMN IF NOT EXISTS times_ordered bigint NOT NULL DEFAULT 0;`);
      console.log(host, ': added column');
    } else {
      console.log(host, ': column already exists');
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_merchant_products_times_ordered ON public.merchant_products (times_ordered DESC);`);
    const verify = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'merchant_products' AND column_name = 'times_ordered'
    `);
    console.log(host, ': verify', JSON.stringify(verify.rows[0]));
    client.release();
    await pool.end();
    return true;
  } catch (e) {
    try { await pool.end(); } catch (_) {}
    return false;
  }
}

(async () => {
  for (const region of regions) {
    const ok = await tryHost(region);
    if (ok) { console.log('DONE via', region); process.exit(0); }
  }
  console.error('ALL REGIONS FAILED');
  process.exit(1);
})();
