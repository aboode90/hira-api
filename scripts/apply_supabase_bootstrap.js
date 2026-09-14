#!/usr/bin/env node
/**
 * يطبّق ملفات SQL الأساسية على مشروع Supabase جديد (فارغ).
 *
 * أضف في backend/.env:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   SUPABASE_DB_PASSWORD=...   (من Settings → Database → password)
 *
 * Usage:
 *   npm run apply-supabase-bootstrap
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SUPABASE_DIR = path.join(__dirname, '..', '..', 'supabase');

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

function buildPgClientConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    };
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  if (!password || !supabaseUrl) {
    throw new Error(
      'أضف SUPABASE_DB_PASSWORD أو DATABASE_URL إلى backend/.env\n' +
        '(Supabase Dashboard → Settings → Database)',
    );
  }

  const ref = projectRefFromUrl(supabaseUrl);
  // أيرلندا (eu-west-1) — Session pooler يعمل حتى عند فشل db.* على IPv6
  const host =
    process.env.SUPABASE_DB_HOST || 'aws-1-eu-west-1.pooler.supabase.com';
  const port = Number(process.env.SUPABASE_DB_PORT || 5432);

  return {
    host,
    port,
    user: `postgres.${ref}`,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

function collectBootstrapFiles() {
  const dated = fs
    .readdirSync(SUPABASE_DIR)
    .filter((name) => /^202\d{5}_.*\.sql$/i.test(name))
    .sort();

  const legacy = [
    'add_otp_requests.sql',
    'add_device_tokens.sql',
    'add_taxi_requests.sql',
    'add_taxi_requests_v2.sql',
    'add_merchant_phone_to_orders.sql',
    'add_courier_phone_to_orders.sql',
    'add_push_inbox_state.sql',
    'chat_messages.sql',
    'voice_call_logs.sql',
  ].filter((name) => fs.existsSync(path.join(SUPABASE_DIR, name)));

  const tail = [
    'storage_uploads_bucket.sql',
    'harden_production_rls_v2.sql',
    'enable_taxi_realtime.sql',
    'enable_chat_realtime.sql',
    'enable_app_realtime.sql',
  ].filter((name) => fs.existsSync(path.join(SUPABASE_DIR, name)));

  const head = ['00_prerequisites.sql', 'schema.sql'].filter((name) =>
    fs.existsSync(path.join(SUPABASE_DIR, name)),
  );

  // Legacy base tables (taxi_requests, device_tokens, …) قبل migrations المؤرّخة
  return [...head, ...legacy, ...dated, ...tail].map((name) =>
    path.join(SUPABASE_DIR, name),
  );
}

async function applyFile(client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const name = path.basename(filePath);
  process.stdout.write(`→ ${name} ... `);
  try {
    await client.query(sql);
    console.log('OK');
  } catch (error) {
    console.log('FAIL');
    throw new Error(`${name}: ${error.message}`);
  }
}

async function main() {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('ثبّت pg: npm install pg');
    process.exit(1);
  }

  const files = collectBootstrapFiles();
  const client = new Client(buildPgClientConfig());

  console.log(`تطبيق ${files.length} ملف SQL على Supabase...\n`);
  await client.connect();
  try {
    for (const filePath of files) {
      await applyFile(client, filePath);
    }
    console.log('\nتم. شغّل: npm run check-supabase');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('\n' + (error.message || error));
  process.exit(1);
});
