require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) {
  console.error('SUPABASE_URL not set');
  process.exit(1);
}
const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)[1];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const pool = new Pool({
  connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function run() {
  const client = await pool.connect();
  try {
    const sqlPath = path.join(__dirname, '..', 'supabase', '20260701_fix_courier_trigger_name.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    console.log('Migration applied successfully.');
  } catch (error) {
    console.error('Migration error:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
