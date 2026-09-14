const express = require('express');
const router = express.Router();
const {
  listShoppingStores,
  listRestaurantStores,
  listServiceStores,
  listCatalogProducts,
  listOfferCatalogProducts,
  getMarketplaceStats,
  listRealEstateListings,
  listStoreProductsForCustomer,
  parseCompactFlag,
} = require('../supabase_repo');
const {
  parseQueryValue,
} = require('./_middleware');
const { remember, DEFAULT_TTLS, setCacheHeader } = require('../lib/response_cache');

router.get('/shopping-stores', async (req, res) => {
  try {
    const subCategoryId = String(parseQueryValue(req.query.subCategoryId) || '').trim();
    const compact = parseCompactFlag(parseQueryValue(req.query.compact));
    const cacheKey = `marketplace:shopping-stores:${subCategoryId}:c${compact ? 1 : 0}`;
    const cached = await remember(cacheKey, DEFAULT_TTLS.storeLists, () =>
      listShoppingStores(subCategoryId, { compact })
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list shopping-stores error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load shopping stores.' });
  }
});

router.get('/restaurant-stores', async (req, res) => {
  try {
    const subCategoryId = String(parseQueryValue(req.query.subCategoryId) || '').trim();
    const compact = parseCompactFlag(parseQueryValue(req.query.compact));
    const cacheKey = `marketplace:restaurant-stores:v5:${subCategoryId}:c${compact ? 1 : 0}`;
    const cached = await remember(cacheKey, DEFAULT_TTLS.storeLists, () =>
      listRestaurantStores(subCategoryId, { compact })
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list restaurant-stores error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load restaurant stores.' });
  }
});

router.get('/service-stores', async (req, res) => {
  try {
    const serviceId = String(parseQueryValue(req.query.serviceId) || '').trim();
    const productCategory = String(parseQueryValue(req.query.productCategory) || serviceId).trim();
    const subCategoryId = String(parseQueryValue(req.query.subCategoryId) || '').trim();
    const marketplaceCategory = String(
      parseQueryValue(req.query.marketplaceCategory) || ''
    ).trim();
    const compact = parseCompactFlag(parseQueryValue(req.query.compact));
    if (!serviceId) {
      return res.status(400).json({ message: 'serviceId is required.' });
    }
    const cacheKey = `marketplace:service-stores:${serviceId}:${productCategory}:${subCategoryId}:${marketplaceCategory}:c${compact ? 1 : 0}`;
    const cached = await remember(cacheKey, DEFAULT_TTLS.storeLists, () =>
      listServiceStores(
        serviceId,
        productCategory,
        subCategoryId,
        marketplaceCategory,
        { compact }
      )
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list service-stores error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load service stores.' });
  }
});

router.get('/store-products', async (req, res) => {
  try {
    const merchantPhone = String(
      parseQueryValue(req.query.merchantPhone) ||
        parseQueryValue(req.query.phone) ||
        ''
    ).trim();
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    const productCategory = String(parseQueryValue(req.query.productCategory) || '').trim();
    const subCategoryId = String(parseQueryValue(req.query.subCategoryId) || '').trim();
    const marketplaceCategory = String(
      parseQueryValue(req.query.marketplaceCategory) || ''
    ).trim();
    const cacheKey = `marketplace:store-products:${merchantPhone}:${productCategory}:${subCategoryId}:${marketplaceCategory}`;
    const cached = await remember(cacheKey, DEFAULT_TTLS.storeLists, () =>
      listStoreProductsForCustomer({
        merchantPhone,
        productCategory,
        subCategoryId,
        marketplaceCategory,
      })
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list store-products error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load store products.' });
  }
});

router.get('/catalog-products', async (req, res) => {
  try {
    const category = String(parseQueryValue(req.query.category) || '').trim();
    const subCategoryId = String(parseQueryValue(req.query.subCategoryId) || '').trim();
    const cacheKey = `marketplace:catalog-products:${category}:${subCategoryId}`;
    const cached = await remember(cacheKey, DEFAULT_TTLS.catalog, () =>
      listCatalogProducts(category, subCategoryId)
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list catalog error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load catalog.' });
  }
});

router.get('/offer-catalog-products', async (req, res) => {
  try {
    const cached = await remember(
      'marketplace:offer-catalog-products',
      DEFAULT_TTLS.catalog,
      listOfferCatalogProducts
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list offers-catalog error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load offers catalog.' });
  }
});

router.get('/marketplace-stats', async (req, res) => {
  try {
    const cached = await remember(
      'marketplace:stats',
      DEFAULT_TTLS.marketplaceStats,
      getMarketplaceStats
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('marketplace-stats error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load marketplace stats.' });
  }
});

router.get('/real-estate-listings', async (req, res) => {
  try {
    const subCategoryId = String(parseQueryValue(req.query.subCategoryId) || '').trim();
    const listingMode = String(parseQueryValue(req.query.listingMode) || '').trim();
    const neighborhood = String(parseQueryValue(req.query.neighborhood) || '').trim();
    const limitRaw = parseQueryValue(req.query.limit);
    const offsetRaw = parseQueryValue(req.query.offset);
    const limit = limitRaw !== '' && limitRaw != null ? Number(limitRaw) : 10;
    const offset = offsetRaw !== '' && offsetRaw != null ? Number(offsetRaw) : 0;
    const cacheKey = `marketplace:real-estate-listings:${subCategoryId}:${listingMode}:${neighborhood}:${limit}:${offset}`;
    const cached = await remember(cacheKey, 60, () =>
      listRealEstateListings(subCategoryId, listingMode, neighborhood, {
        limit,
        offset,
      })
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('list real-estate-listings error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load real estate listings.' });
  }
});

module.exports = router;
