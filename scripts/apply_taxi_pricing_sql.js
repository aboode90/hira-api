#!/usr/bin/env node
/**
 * يطبّق supabase/20260718_taxi_pricing_long_distance.sql على قاعدة Supabase.
 *
 * أضف كلمة مرور قاعدة البيانات إلى backend/.env:
 *   SUPABASE_DB_PASSWORD=your_database_password
 *   (أو DATABASE_URL كاملاً)
 *
 * Usage:
 *   node scripts/apply_taxi_pricing_sql.js
 */
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

function projectRefFromUrl(url) {
  const host = new URL(normalizeSupabaseUrl(url)).hostname;
  return host.split('.')[0];
}

function buildConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  if (!password || !supabaseUrl) {
    throw new Error(
      'أضف SUPABASE_DB_PASSWORD أو DATABASE_URL إلى backend/.env (من Supabase → Settings → Database).'
    );
  }

  const ref = projectRefFromUrl(supabaseUrl);
  const encoded = encodeURIComponent(password);
  return `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`;
}

async function main() {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('ثبّت pg أولاً: npm install pg --save-dev');
    process.exit(1);
  }

  const sqlPath = path.join(
    __dirname,
    '..',
    '..',
    'supabase',
    '20260718_taxi_pricing_long_distance.sql'
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const connectionString = buildConnectionString();

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  console.log('Applying 20260718_taxi_pricing_long_distance.sql ...');
  await client.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(
      "SELECT value FROM public.app_configs WHERE key = 'taxi_pricing'"
    );
    console.log('Done. taxi_pricing is now:');
    console.log(JSON.stringify(rows[0]?.value ?? {}, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
