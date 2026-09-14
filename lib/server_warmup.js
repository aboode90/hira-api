/**
 * تسخين كاش المسارات العامة عند إقلاع السيرفر — يقلّل بطء أول طلب (cold start).
 */

const logger = require('./logger');
const { remember, DEFAULT_TTLS } = require('./response_cache');
const { scheduleEdgeSnapshotPublish } = require('./edge_snapshots');
const {
  getHomeCategoriesConfig,
  getMarketplaceStats,
  listShoppingStores,
  listRestaurantStores,
  listCatalogProducts,
} = require('../supabase_repo');

async function warmupPublicCaches() {
  const startedAt = Date.now();
  const tasks = [
    remember('app:home-categories', DEFAULT_TTLS.homeCategories, getHomeCategoriesConfig),
    remember('marketplace:stats', DEFAULT_TTLS.marketplaceStats, getMarketplaceStats),
    remember('marketplace:shopping-stores:', DEFAULT_TTLS.storeLists, () =>
      listShoppingStores('')
    ),
    remember('marketplace:restaurant-stores:', DEFAULT_TTLS.storeLists, () =>
      listRestaurantStores('')
    ),
    remember('marketplace:catalog-products::', DEFAULT_TTLS.catalog, () =>
      listCatalogProducts('', '')
    ),
  ];

  const results = await Promise.allSettled(tasks);
  const failed = results.filter((item) => item.status === 'rejected').length;
  logger.info('Server cache warmup finished', {
    durationMs: Date.now() - startedAt,
    tasks: tasks.length,
    failed,
  });
}

function scheduleServerWarmup() {
  const enabled =
    String(process.env.ENABLE_SERVER_WARMUP || 'true').trim().toLowerCase() !== 'false';
  if (!enabled) return;

  setTimeout(() => {
    warmupPublicCaches()
      .then(() => {
        scheduleEdgeSnapshotPublish();
      })
      .catch((error) => {
        logger.warn('Server cache warmup error', { message: error?.message || error });
      });
  }, 250);
}

module.exports = {
  warmupPublicCaches,
  scheduleServerWarmup,
};
