#!/usr/bin/env node
/**
 * بذور افتراضية بعد إنشاء الجداول (app_configs، مناطق العراق، feature flags).
 *
 * Usage: npm run seed-supabase
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function runScript(relativePath) {
  const scriptPath = path.join(__dirname, relativePath);
  console.log('\n—', relativePath);
  await require(scriptPath);
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('أضف SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY في backend/.env');
  }

  await runScript('seed_feature_flags.js');
  await runScript('seed_iraq_admin_areas.js');
  await runScript('seed_phone_taxi.js');
  console.log('\n✓ البذور الافتراضية جاهزة.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
