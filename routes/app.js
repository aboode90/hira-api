const express = require('express');
const router = express.Router();
const {
  getAppUpdatePolicy,
  getHomeCategoriesConfig,
  getMaintenancePolicy,
  getProfessionalCategoriesConfig,
} = require('../supabase_repo');
const { remember, DEFAULT_TTLS, setCacheHeader } = require('../lib/response_cache');
const { getEdgeManifest } = require('../lib/edge_snapshots');

router.get('/update-policy', async (_req, res) => {
  try {
    const cached = await remember('app:update-policy', DEFAULT_TTLS.appPolicy, async () => {
      const policy = await getAppUpdatePolicy();
      const minBuildNumber = policy.forceUpdateEnabled
        ? policy.minBuildNumber
        : 1;
      return {
        ...policy,
        minBuildNumber,
        forceUpdate: policy.forceUpdateEnabled === true,
        optionalUpdateUsesStore: true,
      };
    });
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('app update policy error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to load app update policy.',
    });
  }
});

router.get('/maintenance', async (_req, res) => {
  try {
    const cached = await remember(
      'app:maintenance-policy',
      60_000,
      getMaintenancePolicy
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('app maintenance policy error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to load maintenance policy.',
    });
  }
});

router.get('/edge-manifest', async (_req, res) => {
  try {
    const manifest = getEdgeManifest();
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(manifest);
  } catch (error) {
    console.error('edge manifest error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to load edge manifest.',
    });
  }
});

router.get('/home-categories', async (_req, res) => {
  try {
    const cached = await remember(
      'app:home-categories',
      DEFAULT_TTLS.homeCategories,
      getHomeCategoriesConfig
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('home categories config error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to load home categories config.',
    });
  }
});

router.get('/professional-categories', async (_req, res) => {
  try {
    const cached = await remember(
      'app:professional-categories',
      DEFAULT_TTLS.homeCategories,
      getProfessionalCategoriesConfig
    );
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('professional categories config error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to load professional categories config.',
    });
  }
});

module.exports = router;
