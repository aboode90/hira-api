#!/usr/bin/env node
/**
 * تقرير سريع لمصادر Egress المحتملة (Base64 في DB، أحجام الجداول).
 *
 * Usage:
 *   node scripts/egress_diagnostics.js
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

function normalizeSupabaseUrl(url) {
  let normalized = String(url || '').trim();
  if (normalized.endsWith('/rest/v1/')) normalized = normalized.slice(0, -'/rest/v1/'.length);
  else if (normalized.endsWith('/rest/v1')) normalized = normalized.slice(0, -'/rest/v1'.length);
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

async function countBase64Rows(supabase, table, column) {
  const { count, error } = await supabase
    .from(table)
    .select(column, { count: 'exact', head: true })
    .not(column, 'is', null)
    .neq(column, '');
  if (error) return { error: error.message };
  return { count: count || 0 };
}

async function sampleBase64Length(supabase, table, column, limit = 5) {
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .not(column, 'is', null)
    .neq(column, '')
    .limit(limit);
  if (error) return { error: error.message };
  const lengths = (data || []).map((row) => String(row[column] || '').length);
  return { sampleLengths: lengths };
}

async function main() {
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  console.log('=== Alghaith egress diagnostics ===\n');

  const checks = [
    ['merchant_products', 'image_base64'],
    ['merchant_profiles', 'profile_image_base64'],
  ];

  for (const [table, column] of checks) {
    const total = await countBase64Rows(supabase, table, column);
    const sample = await sampleBase64Length(supabase, table, column);
    console.log(`${table}.${column}:`);
    if (total.error) {
      console.log(`  count error: ${total.error}`);
    } else {
      console.log(`  rows with data: ${total.count}`);
    }
    if (sample.sampleLengths) {
      console.log(`  sample char lengths: ${sample.sampleLengths.join(', ') || '—'}`);
    }
    console.log('');
  }

  const tables = ['merchant_products', 'merchant_profiles', 'app_state', 'customer_orders', 'chat_messages'];
  for (const table of tables) {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`${table}: count unavailable (${error.message})`);
    } else {
      console.log(`${table}: ${count ?? 0} rows`);
    }
  }

  console.log('\nNext steps if image_base64 counts are high:');
  console.log('  node scripts/migrate_base64_images_to_storage.js');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
