/**
 * Seed default feature flags into app_configs (idempotent).
 * Usage: node backend/scripts/seed_feature_flags.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { getAdminFeatureFlags, saveFeatureFlags, defaultFlagsMap } = require('../services/feature_flags_service');
const { getAllConfigs } = require('../services/app_config_service');

async function main() {
  const configs = await getAllConfigs();
  const existing = configs['feature_flags'];
  if (existing?.flags && Object.keys(existing.flags).length > 0) {
    console.log('feature_flags already populated — skipping.');
    return;
  }
  await saveFeatureFlags({ flags: defaultFlagsMap() });
  const result = await getAdminFeatureFlags();
  console.log('Seeded', Object.keys(result.flags).length, 'feature flags');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
