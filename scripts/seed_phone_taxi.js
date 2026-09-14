/**
 * Seed empty phone_taxi config into app_configs (idempotent).
 * Usage: node backend/scripts/seed_phone_taxi.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const {
  getAllConfigs,
  updateConfig,
  getPhoneTaxiConfig,
  PHONE_TAXI_DEFAULTS,
} = require('../services/app_config_service');

async function main() {
  const configs = await getAllConfigs();
  if (configs['phone_taxi'] && typeof configs['phone_taxi'] === 'object') {
    const current = await getPhoneTaxiConfig();
    console.log('phone_taxi already present — numbers:', current.numbers.length);
    return;
  }
  await updateConfig('phone_taxi', { ...PHONE_TAXI_DEFAULTS });
  const saved = await getPhoneTaxiConfig();
  console.log('Seeded phone_taxi config. numbers:', saved.numbers.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
