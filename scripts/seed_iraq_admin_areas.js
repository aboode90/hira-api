/**
 * Seed iraq_admin_areas config from assets/config/iraq_admin_areas.json
 * Usage:
 *   node backend/scripts/seed_iraq_admin_areas.js [--force]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { getIraqAdminAreas, updateConfig } = require('../services/app_config_service');

async function main() {
  const force = process.argv.includes('--force');
  const filePath = path.resolve(__dirname, '../../assets/config/iraq_admin_areas.json');
  const seed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const current = await getIraqAdminAreas();
  const hasData =
    Array.isArray(current?.governorates) && current.governorates.length > 0;
  if (hasData && !force) {
    console.log('iraq_admin_areas already populated — use --force to overwrite.');
    return;
  }

  const payload = {
    ...seed,
    updatedAt: new Date().toISOString(),
  };
  await updateConfig('iraq_admin_areas', payload);
  console.log('Seeded iraq_admin_areas with', payload.governorates?.length, 'governorates');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
