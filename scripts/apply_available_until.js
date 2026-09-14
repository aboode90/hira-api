require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
const projectRef = String(supabaseUrl || '').match(/https:\/\/(.+)\.supabase\.co/)?.[1];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;

if (!projectRef) {
  console.error('SUPABASE_URL missing');
  process.exit(1);
}

const candidates = [];
if (process.env.DATABASE_URL) {
  candidates.push(process.env.DATABASE_URL);
}
if (dbPassword) {
  candidates.push(
    `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${projectRef}.supabase.co:5432/postgres`,
  );
  candidates.push(
    `postgresql://postgres.${projectRef}:${encodeURIComponent(dbPassword)}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  );
}
if (serviceRoleKey) {
  candidates.push(
    `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  );
  candidates.push(
    `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
  );
}

async function tryApply(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 8000,
  });
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE merchant_products
        ADD COLUMN IF NOT EXISTS available_until timestamptz
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_merchant_products_offers_expiry
        ON merchant_products (available_until)
        WHERE category = 'offers' AND available_until IS NOT NULL
    `);
    return true;
  } finally {
    client.release();
    await pool.end();
  }
}

async function run() {
  let lastError = null;
  for (const connectionString of candidates) {
    try {
      await tryApply(connectionString);
      console.log('available_until ready');
      return;
    } catch (error) {
      lastError = error;
      console.warn('try failed:', error.message);
    }
  }
  console.error(lastError?.message || 'No working DB connection');
  process.exit(1);
}

run();
