#!/usr/bin/env node
/**
 * فحص جاهزية Supabase — جداول أساسية + bucket uploads.
 *
 * Usage: node backend/scripts/check_supabase_setup.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const REQUIRED_TABLES = [
  'app_users',
  'merchant_profiles',
  'merchant_products',
  'customer_profiles',
  'customer_addresses',
  'customer_favorites',
  'customer_orders',
  'app_state',
  'otp_requests',
  'device_tokens',
  'taxi_requests',
  'taxi_driver_status',
  'driver_profiles',
  'courier_profiles',
  'chat_messages',
  'user_notifications',
  'notification_outbox',
  'media_assets',
  'merchant_offers',
  'admin_roles',
  'app_configs',
  'provider_wallets',
  'customer_loyalty_profiles',
  'customer_loyalty_coupons',
];

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('أضف SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY في backend/.env');
    process.exit(1);
  }

  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(url, key);

  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await client.from(table).select('*').limit(1);
    const message = error?.message || '';
    if (error && (error.code === 'PGRST205' || /schema cache|does not exist/i.test(message))) {
      missing.push(table);
    } else if (error) {
      console.warn(`⚠ ${table}: ${message}`);
    }
  }

  const { data: buckets, error: bucketError } = await client.storage.listBuckets();
  const hasUploads =
    !bucketError && Array.isArray(buckets) && buckets.some((b) => b.id === 'uploads');

  console.log(`\nSupabase: ${url}`);
  console.log(`الجداول المطلوبة: ${REQUIRED_TABLES.length - missing.length}/${REQUIRED_TABLES.length}`);
  if (missing.length) {
    console.log('\nجداول ناقصة:');
    missing.forEach((t) => console.log(`  - ${t}`));
    console.log('\nشغّل: npm run apply-supabase-bootstrap');
    process.exit(1);
  }

  console.log('bucket uploads:', hasUploads ? 'موجود' : 'ناقص — شغّل storage_uploads_bucket.sql');
  console.log('\n✓ قاعدة البيانات جاهزة أساسياً.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
