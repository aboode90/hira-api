const express = require('express');
const router = express.Router();

const {
  getAllConfigs,
  updateConfig,
  getTaxiPricing,
  getTaxiConfig,
  getTaxiDeliveryConfig,
  getTaxiDeliveryPublicConfig,
  getPhoneTaxiConfig,
  getPhoneTaxiPublicConfig,
  normalizePhoneTaxiNumbers,
  getMapDefaults,
  getHomeCategories,
  getSubCategories,
  getNeighborhoods,
  getIraqAdminAreas,
  getNotificationTexts,
  getAppTheme,
  getCartConfig,
  getCategoryConfig,
  getDeliveryConfig,
  getServiceFees,
  getErrorMessages,
} = require('../services/app_config_service');

// ── Public: قراءة إعدادات محددة ────────────────────────────────────

router.get('/taxi-pricing', async (_req, res) => {
  try {
    const data = await getTaxiPricing();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/taxi-config', async (_req, res) => {
  try {
    const data = await getTaxiConfig();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/taxi-delivery', async (_req, res) => {
  try {
    const data = await getTaxiDeliveryPublicConfig();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/phone-taxi', async (_req, res) => {
  try {
    const data = await getPhoneTaxiPublicConfig();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/map-defaults', async (_req, res) => {
  try {
    const data = await getMapDefaults();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/home-categories', async (_req, res) => {
  try {
    const data = await getHomeCategories();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/sub-categories', async (_req, res) => {
  try {
    const data = await getSubCategories();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/neighborhoods', async (_req, res) => {
  try {
    const { normalizeNeighborhoodsConfig } = require('../services/taxi_places_config');
    const data = await getNeighborhoods();
    return res.json(normalizeNeighborhoodsConfig(data));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/iraq-admin-areas', async (_req, res) => {
  try {
    const data = await getIraqAdminAreas();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/notification-texts', async (_req, res) => {
  try {
    const data = await getNotificationTexts();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/app-theme', async (_req, res) => {
  try {
    const data = await getAppTheme();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/cart-config', async (_req, res) => {
  try { const data = await getCartConfig(); return res.json(data); }
  catch (error) { return res.status(500).json({ message: error.message }); }
});

router.get('/category-config', async (_req, res) => {
  try { const data = await getCategoryConfig(); return res.json(data); }
  catch (error) { return res.status(500).json({ message: error.message }); }
});

router.get('/delivery-config', async (_req, res) => {
  try { const data = await getDeliveryConfig(); return res.json(data); }
  catch (error) { return res.status(500).json({ message: error.message }); }
});

router.get('/service-fees', async (_req, res) => {
  try {
    const data = await getServiceFees();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/error-messages', async (_req, res) => {
  try { const data = await getErrorMessages(); return res.json(data); }
  catch (error) { return res.status(500).json({ message: error.message }); }
});

// ── Admin: قراءة/تعديل كل الإعدادات ──────────────────────────────────

router.get('/admin/configs', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await getAllConfigs();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.put('/admin/configs', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ message: 'Config key is required.' });
    const result = await updateConfig(key, value);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

const {
  listTaxiPlaces,
  addTaxiPlaceFromMapsUrl,
  deleteTaxiPlace,
  updateTaxiPlace,
  listServiceAreas,
  saveServiceAreas,
  extractPlacesAround,
  addTaxiPlacesBatch,
} = require('../services/taxi_places_config');

router.get('/admin/taxi-places', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await listTaxiPlaces();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.post('/admin/taxi-places/from-maps-url', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const { mapsUrl, name } = req.body || {};
    const result = await addTaxiPlaceFromMapsUrl({ mapsUrl, name });
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Failed to add taxi place.';
    const status =
      error?.statusCode ||
      (message.includes('مسجّل مسبقاً') ? 409 : null) ||
      (message.includes('رابط') || message.includes('اسم') ? 400 : 500);
    return res.status(status).json({ message });
  }
});

router.delete('/admin/taxi-places/:id', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await deleteTaxiPlace(req.params.id);
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Failed to delete taxi place.';
    const status = message.includes('غير موجود') ? 404 : 500;
    return res.status(status).json({ message });
  }
});

router.patch('/admin/taxi-places/:id', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await updateTaxiPlace(req.params.id, req.body || {});
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Failed to update taxi place.';
    const status = message.includes('غير موجود') ? 404 : 400;
    return res.status(status).json({ message });
  }
});

router.get('/admin/service-areas', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await listServiceAreas();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.put('/admin/service-areas', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const { serviceAreas } = req.body || {};
    const data = await saveServiceAreas(serviceAreas);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.get('/admin/iraq-admin-areas', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await getIraqAdminAreas();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.put('/admin/iraq-admin-areas', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const body = req.body || {};
    const governorates = body.governorates;
    if (!Array.isArray(governorates) || governorates.length === 0) {
      return res.status(400).json({ message: 'يجب توفير محافظة واحدة على الأقل.' });
    }
    const { updateConfig } = require('../services/app_config_service');
    const payload = {
      schemaVersion: 1,
      governorates,
      updatedAt: new Date().toISOString(),
    };
    await updateConfig('iraq_admin_areas', payload);
    return res.json(payload);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

const {
  getAdminFeatureFlags,
  saveFeatureFlags,
} = require('../services/feature_flags_service');

router.get('/admin/feature-flags', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await getAdminFeatureFlags();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.put('/admin/feature-flags', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await saveFeatureFlags(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// POST /db/app/config/admin/taxi-places/extract — استخراج أماكن من منطقة (Overpass)
router.post('/admin/taxi-places/extract', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const { latitude, longitude, radiusKm, types } = req.body || {};
    const results = await extractPlacesAround({
      latitude,
      longitude,
      radiusKm,
      types,
    });
    return res.json({ results, count: results.length });
  } catch (error) {
    const message = error?.message || 'Failed to extract places.';
    return res.status(400).json({ message });
  }
});

// POST /db/app/config/admin/taxi-places/batch — إضافة أماكن متعددة دفعة واحدة
router.post('/admin/taxi-places/batch', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const { places } = req.body || {};
    const result = await addTaxiPlacesBatch(places);
    return res.json(result);
  } catch (error) {
    const message = error?.message || 'Failed to add places.';
    return res.status(500).json({ message });
  }
});

router.get('/admin/taxi-delivery', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await getTaxiDeliveryConfig();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.put('/admin/taxi-delivery', async (_req, res) => {
  // LEGACY — taxi_delivery / bazaar product removed from Talab app.
  return res.status(410).json({
    message: 'خدمة تكسي البازار أُزيلت من التطبيق ولم تعد متاحة.',
    code: 'TAXI_DELIVERY_REMOVED',
  });
});

router.get('/admin/phone-taxi', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const data = await getPhoneTaxiConfig();
    return res.json(data);
  } catch (error) {
    return res.status(403).json({ message: error.message });
  }
});

router.put('/admin/phone-taxi', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('./_middleware');
    const { assertAdminPermission } = require('../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');

    const body = req.body || {};
    const current = await getPhoneTaxiConfig();
    const next = {
      enabled: body.enabled !== false,
      titleAr:
        String(body.titleAr || current.titleAr || '').trim() || current.titleAr,
      subtitleAr:
        String(body.subtitleAr || current.subtitleAr || '').trim() ||
        current.subtitleAr,
      numbers: normalizePhoneTaxiNumbers(body.numbers ?? current.numbers),
    };
    await updateConfig('phone_taxi', next);
    return res.json(next);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/admin/taxi-delivery/from-maps-url', async (_req, res) => {
  // LEGACY — taxi_delivery / bazaar product removed from Talab app.
  return res.status(410).json({
    message: 'خدمة تكسي البازار أُزيلت من التطبيق ولم تعد متاحة.',
    code: 'TAXI_DELIVERY_REMOVED',
  });
});

module.exports = router;
