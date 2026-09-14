#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function normalizeSupabaseUrl(url) {
  let normalized = String(url || '').trim();
  if (normalized.endsWith('/rest/v1/')) normalized = normalized.slice(0, -'/rest/v1/'.length);
  else if (normalized.endsWith('/rest/v1')) normalized = normalized.slice(0, -'/rest/v1'.length);
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function buildConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  if (!password || !supabaseUrl) {
    throw new Error('أضف SUPABASE_DB_PASSWORD أو DATABASE_URL إلى backend/.env');
  }
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

async function main() {
  const { Client } = require('pg');
  const sqlPath = path.join(
    __dirname,
    '..',
    '..',
    'supabase',
    '20260828_backfill_default_suwayra_area.sql',
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = new Client({
    connectionString: buildConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  console.log('Applying 20260828_backfill_default_suwayra_area.sql ...');
  await client.connect();
  try {
    await client.query(sql);
    const customers = await client.query(`
      select
        count(*) filter (where coalesce(governorate, '') <> '') as with_gov,
        count(*) as total
      from customer_profiles
    `);
    const drivers = await client.query(`
      select
        count(*) filter (where coalesce(profile_payload->>'governorate', '') <> '') as with_gov,
        count(*) as total
      from driver_profiles
    `);
    console.log('customers', customers.rows[0]);
    console.log('drivers', drivers.rows[0]);
    console.log('Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
