#!/usr/bin/env node
/**
 * Applies supabase/20260822_merchant_service_profiles.sql
 *
 * Usage:
 *   node scripts/apply_merchant_service_profiles_sql.js
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
      'Add SUPABASE_DB_PASSWORD or DATABASE_URL to backend/.env',
    );
  }
  const ref = projectRefFromUrl(supabaseUrl);
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

async function main() {
  const { Client } = require('pg');
  const sqlPath = path.join(
    __dirname,
    '..',
    '..',
    'supabase',
    '20260822_merchant_service_profiles.sql',
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = new Client({
    connectionString: buildConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS count FROM merchant_service_profiles',
    );
    console.log('merchant_service_profiles migration applied. rows:', rows[0]?.count);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
