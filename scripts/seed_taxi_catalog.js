/**
 * Seed taxi catalog from assets/config/taxi_catalog.json into production.
 * Usage:
 *   node backend/scripts/seed_taxi_catalog.js --dry-run
 *   node backend/scripts/seed_taxi_catalog.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { seedTaxiCatalogFromAsset } = require('../services/taxi_places_config');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const allowFar = process.argv.includes('--allow-far');
  const result = await seedTaxiCatalogFromAsset({ dryRun, allowFar });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
