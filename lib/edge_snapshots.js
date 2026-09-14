/**
 * نشر لقطات JSON عامة إلى R2 — تُخدم من Cloudflare Worker (/snapshots/v1/*)
 * لتسريع أول تحميل للكتالوج والمتاجر دون انتظار Railway.
 */

const logger = require('./logger');
const { isR2Configured, uploadJsonToR2 } = require('../services/r2_storage');
const {
  getHomeCategoriesConfig,
  getMarketplaceStats,
  listShoppingStores,
  listRestaurantStores,
  listCatalogProducts,
  listOfferCatalogProducts,
} = require('../supabase_repo');

const SNAPSHOT_PREFIX = 'snapshots/v1';

let lastManifest = {
  version: 1,
  publishedAt: null,
  snapshots: {},
};

function getEdgeManifest() {
  return lastManifest;
}

async function publishSnapshot(name, loader) {
  const data = await loader();
  const objectPath = `${SNAPSHOT_PREFIX}/${name}.json`;
  const publicUrl = await uploadJsonToR2({
    objectPath,
    data,
    cacheControl: 'public, max-age=120, s-maxage=300',
  });
  return {
    name,
    objectPath,
    publicUrl,
    itemCount: Array.isArray(data) ? data.length : null,
  };
}

async function publishAllEdgeSnapshots() {
  if (!isR2Configured()) {
    logger.info('Edge snapshots skipped — R2 is not configured.');
    return null;
  }

  const enabled =
    String(process.env.ENABLE_EDGE_SNAPSHOTS || 'true').trim().toLowerCase() !== 'false';
  if (!enabled) return null;

  const startedAt = Date.now();
  const tasks = [
    publishSnapshot('home-categories', getHomeCategoriesConfig),
    publishSnapshot('shopping-stores', () => listShoppingStores('')),
    publishSnapshot('restaurant-stores', () => listRestaurantStores('')),
    publishSnapshot('catalog-products', () => listCatalogProducts('', '')),
    publishSnapshot('offer-catalog-products', listOfferCatalogProducts),
    publishSnapshot('marketplace-stats', getMarketplaceStats),
  ];

  const results = await Promise.allSettled(tasks);
  const snapshots = {};
  let failed = 0;

  for (const result of results) {
    if (result.status === 'rejected') {
      failed += 1;
      logger.warn('Edge snapshot publish failed', {
        message: result.reason?.message || String(result.reason),
      });
      continue;
    }
    const entry = result.value;
    snapshots[entry.name] = {
      path: `/${entry.objectPath}`,
      publicUrl: entry.publicUrl,
      itemCount: entry.itemCount,
    };
  }

  const manifest = {
    version: 1,
    publishedAt: new Date().toISOString(),
    snapshots,
  };

  await uploadJsonToR2({
    objectPath: `${SNAPSHOT_PREFIX}/manifest.json`,
    data: manifest,
    cacheControl: 'public, max-age=60, s-maxage=120',
  });

  lastManifest = manifest;
  logger.info('Edge snapshots published', {
    durationMs: Date.now() - startedAt,
    snapshots: Object.keys(snapshots).length,
    failed,
  });

  return manifest;
}

function scheduleEdgeSnapshotPublish() {
  const enabled =
    String(process.env.ENABLE_EDGE_SNAPSHOTS || 'true').trim().toLowerCase() !== 'false';
  if (!enabled || !isR2Configured()) return;

  setTimeout(() => {
    publishAllEdgeSnapshots().catch((error) => {
      logger.warn('Edge snapshot publish error', { message: error?.message || error });
    });
  }, 1500);
}

module.exports = {
  getEdgeManifest,
  publishAllEdgeSnapshots,
  scheduleEdgeSnapshotPublish,
};
