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
      'أضف SUPABASE_DB_PASSWORD أو DATABASE_URL إلى backend/.env (من Supabase → Settings → Database).',
    );
  }

  const ref = projectRefFromUrl(supabaseUrl);
  const encoded = encodeURIComponent(password);
  return `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`;
}

async function main() {
  const { Client } = require('pg');
  const sqlPath = path.join(
    __dirname,
    '..',
    '..',
    'supabase',
    '20260828_delivery_assignee_cancellations.sql',
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = new Client({
    connectionString: buildConnectionString(),
    ssl: { rejectUnauthorized: false },
  });

  console.log('Applying 20260828_delivery_assignee_cancellations.sql ...');
  await client.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(`
      select to_regclass('public.delivery_assignee_cancellations') as table_name
    `);
    console.log('Done.', rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
