const express = require('express');
const router = express.Router();
const { normalizeTaxiType } = require('../../services/taxi_pricing_service');
const repo = require('./repository/taxi');
const { getUserState } = require('../../supabase_repo/users');
const {
  getTaxiFavoritePlaces,
  saveTaxiFavoritePlace,
  deleteTaxiFavoritePlace,
} = require('../../supabase_repo/taxi_favorites');
const { requireOptionalAuthorizedPhone } = require('../../routes/_middleware');
const { resolvePhoneKey } = require('../../supabase_repo/common');

function formatRequestRow(row) {
  return repo.formatTaxiRequestForClient(row);
}

function formatDriverRequestRow(row) {
  return repo.formatTaxiRequestForDriver(row);
}

function hideCustomerPhone(request) {
  return repo.hideCustomerPhoneFromTaxiRequest(request);
}

async function formatRequestRowEnriched(row) {
  // بعد القبول يرى الكابتن رقم الزبون — إخفاء الرقم يحدث فقط في قائمة
  // الطلبات الواردة (قبل القبول) داخل getDriverIncomingRequests.
  return repo.enrichTaxiRequestForClient(row);
}

// POST /db/taxi/create - إنشاء طلب جديد (يحسب السعر تلقائياً)
router.post('/create', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await repo.createTaxiRequest(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('taxi create error:', error);
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({ message: error?.message || 'Failed to create taxi request.' });
  }
});

// GET /db/taxi/estimate-fare?distance=7&types=tuktuk,wazz,economic&tripType=one_way
router.get('/estimate-fare', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const distance = Number(req.query.distance) || 0;
    const { MIN_TRIP_DISTANCE_KM } = require('../../services/taxi_trip_service');
    if (distance <= 0) {
      return res.status(400).json({
        message: 'نقطة الوصول مطابقة لنقطة الانطلاق أو المسافة صفر. حدّد وجهة مختلفة.',
      });
    }
    if (distance < MIN_TRIP_DISTANCE_KM) {
      return res.status(400).json({
        message: 'المسافة قصيرة جداً (أقل من 100 متر). حدّد نقطة وصول أبعد.',
      });
    }
    const requestedTypes = String(req.query.types || 'economic')
      .split(',')
      .filter(Boolean)
      .map((t) => t.trim().toLowerCase());
    const tripType = String(req.query.tripType || 'one_way').trim();
    const fareOptions = {
      pickupAddress: String(req.query.pickupAddress || '').trim(),
      dropoffAddress: String(req.query.dropoffAddress || '').trim(),
      pickupLat: Number(req.query.pickupLat),
      pickupLng: Number(req.query.pickupLng),
      dropoffLat: Number(req.query.dropoffLat),
      dropoffLng: Number(req.query.dropoffLng),
    };
    const insideCityRaw = req.query.insideCity;
    if (insideCityRaw !== undefined && String(insideCityRaw).trim() !== '') {
      const normalized = String(insideCityRaw).trim().toLowerCase();
      fareOptions.insideCityTrip =
        normalized === '1' || normalized === 'true' || normalized === 'yes';
    }
    const {
      calculateFare,
      isEconomicOnlyDistance,
      isAllowedOnLongDistance,
      normalizeTaxiType,
    } = require('../../services/taxi_pricing_service');
    let types = requestedTypes.map((t) => normalizeTaxiType(t));
    if (isEconomicOnlyDistance(distance)) {
      types = types.filter((t) => isAllowedOnLongDistance(t));
      if (types.length === 0) types = ['economic', 'starx11'];
    }
    const results = {};
    let interGovernorate = false;
    for (const type of types) {
      const { fare, fareEconomic, fareSuper, interGovernorate: ig } =
        await calculateFare(distance, type, tripType, fareOptions);
      interGovernorate = Boolean(ig);
      results[type] = { fare, fareEconomic, fareSuper };
    }
    return res.json({ distance, tripType, interGovernorate, results });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Failed to estimate fare.' });
  }
});

// POST /db/taxi/accept - قبول السائق
router.post('/accept', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, driverName, vehicleModel, plateNumber, driverPhoto, carImage } = req.body || {};
    const result = await repo.acceptTaxiRequest(phone, requestId, {
      driverName,
      vehicleModel,
      plateNumber,
      driverPhoto,
      carImage,
    });
    // بعد قبول الكابتن للطلب يظهر له رقم الزبون للتواصل.
    return res.json(result);
  } catch (error) {
    console.error('taxi accept error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to accept taxi request.' });
  }
});

// POST /db/taxi/reject - رفض السائق
router.post('/reject', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId } = req.body || {};
    const result = await repo.rejectTaxiRequest(phone, requestId);
    return res.json(result);
  } catch (error) {
    console.error('taxi reject error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to reject taxi request.' });
  }
});

// POST /db/taxi/transfer - تحويل الرحلة بعد القبول إلى كباتن آخرين
router.post('/transfer', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, reason } = req.body || {};
    const result = await repo.transferTaxiRequest(phone, requestId, { reason });
    return res.json(hideCustomerPhone(result));
  } catch (error) {
    console.error('taxi transfer error:', error);
    const message = error?.message || 'Failed to transfer taxi request.';
    const status = /غير معيّنة|حالتها الحالية|تعذّر تحويل/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

// POST /db/taxi/driver-cancel — إلغاء فوري من الكابتن بعد القبول (سبب إلزامي)
router.post('/driver-cancel', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, reason } = req.body || {};
    const cancellations = require('../../supabase_repo/taxi_driver_cancellations');
    const result = await cancellations.driverCancelTaxiRequest(phone, requestId, reason);
    return res.json({
      ...hideCustomerPhone(result.trip),
      cancellation: result.cancellation,
    });
  } catch (error) {
    console.error('taxi driver-cancel error:', error);
    const message = error?.message || 'Failed to cancel taxi request.';
    const status =
      error?.statusCode ||
      (/سبب الإلغاء|غير معيّنة|حالتها الحالية|مجمّد|تعذّر إلغاء/.test(message) ? 400 : 500);
    return res.status(status).json({ message, code: error?.code || undefined });
  }
});

// GET /db/taxi/driver-penalty-status — حالة التجميد/العقوبات للكابتن
router.get('/driver-penalty-status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const cancellations = require('../../supabase_repo/taxi_driver_cancellations');
    const status = await cancellations.getDriverPenaltyStatus(phone);
    return res.json(status);
  } catch (error) {
    const { isTransientDbFailure } = require('../../lib/db_circuit');
    if (isTransientDbFailure(error)) {
      return res.json({ frozen: false, deferred: true });
    }
    console.error('taxi driver-penalty-status error:', error);
    return res.status(500).json({ message: error?.message || 'Failed.' });
  }
});

// POST /db/taxi/cancel - إلغاء من الزبون
router.post('/cancel', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, reason } = req.body || {};
    const result = await repo.cancelTaxiRequest(phone, requestId, reason);
    return res.json(result);
  } catch (error) {
    console.error('taxi cancel error:', error);
    const message = error?.message || 'Failed to cancel taxi request.';
    const status = /سبب الإلغاء|لا يمكن إلغاء/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

// POST /db/taxi/bump-fare - «أنا مستعجل»: +1000 د.ع أثناء انتظار كابتن
router.post('/bump-fare', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId } = req.body || {};
    const result = await repo.bumpCustomerTaxiFare(phone, requestId);
    return res.json(result);
  } catch (error) {
    console.error('taxi bump-fare error:', error);
    const message = error?.message || 'Failed to bump fare.';
    const status =
      error?.code === 'NOT_PENDING' ||
      error?.code === 'OPEN_TRIP' ||
      error?.code === 'BAZAAR' ||
      error?.code === 'MAX_BUMPS' ||
      /يمكن رفع|لا يمكن رفع|الحد الأقصى|غير مصرح|authorized|Request id/i.test(
        message,
      )
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

// POST /db/taxi/request-cancellation - طلب إلغاء بعد القبول (بانتظار موافقة السائق)
router.post('/request-cancellation', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, reason } = req.body || {};
    const result = await repo.requestTripCancellation(phone, requestId, reason);
    return res.json(result);
  } catch (error) {
    console.error('taxi request-cancellation error:', error);
    const message = error?.message || 'Failed to request cancellation.';
    const status = /سبب الإلغاء|لا يمكن طلب الإلغاء/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

// POST /db/taxi/driver-location - تحديث موقع السائق أثناء الرحلة
router.post('/driver-location', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, lat, lng } = req.body || {};
    const id = String(requestId || '').trim();
    await repo.updateDriverTripLocation(phone, id, Number(lat), Number(lng));
    const row = await require('../../supabase_repo/common').selectSingle('taxi_requests', 'id', id);
    return res.json(row ? await formatRequestRowEnriched(row) : null);
  } catch (error) {
    console.error('taxi driver-location error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to update driver location.' });
  }
});

// POST /db/taxi/driver-presence-location - تحديث موقع السائق المتصل بدون تحميل app_state
router.post('/driver-presence-location', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await repo.updateDriverPresenceLocation(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    const { isTransientDbFailure } = require('../../lib/db_circuit');
    if (isTransientDbFailure(error)) {
      return res.json({ success: true, deferred: true });
    }
    console.error('taxi driver-presence-location error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to update driver presence location.' });
  }
});

// POST /db/taxi/status - تحديث حالة الرحلة
router.post('/status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, statusKey, collectedFare, fare } = req.body || {};
    const result = await repo.updateTaxiRequestStatus(phone, requestId, statusKey, {
      collectedFare: collectedFare ?? fare,
    });
    const row = await require('../../supabase_repo/common').selectSingle('taxi_requests', 'id', requestId);
    if (row) {
      return res.json(await formatRequestRowEnriched(row));
    }
    return res.json(formatRequestRow(result));
  } catch (error) {
    console.error('taxi status error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to update taxi request status.' });
  }
});

// GET /db/taxi/active - الطلب النشط للزبون
router.get('/active', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const phoneKey = await resolvePhoneKey(phone);
    const request = await repo.getCustomerActiveRequest(phoneKey);
    if (request) return res.json(await formatRequestRowEnriched(request));

    // إذا لم يكن هناك طلب نشط، نُرجع آخر طلب منتهٍ (ملغى/مكتمل) لمسح الحالة المحلية فوراً.
    const recent = await repo.getCustomerRecentRequest(phoneKey);
    if (!recent) return res.json(null);

    const meta = repo.readTaxiMeta(recent);
    if (meta.statusKey === 'cancelled' || meta.statusKey === 'completed') {
      const enriched = repo.formatTaxiRequestForClient(recent);
      return res.json(enriched);
    }
    return res.json(null);
  } catch (error) {
    console.error('taxi active error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get active request.' });
  }
});

// GET /db/taxi/driver-active - الطلب النشط للسائق
router.get('/driver-active', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await repo.getDriverActiveRequest(phone);
    if (!request) return res.json(null);
    return res.json(await formatRequestRowEnriched(request));
  } catch (error) {
    const { isTransientDbFailure } = require('../../lib/db_circuit');
    if (isTransientDbFailure(error)) return res.json(null);
    console.error('taxi driver-active error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get driver active request.' });
  }
});

// GET /db/taxi/pending-rating - آخر رحلة مكتملة بانتظار التقييم
router.get('/pending-rating', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await repo.getCustomerPendingRatingRequest(phone);
    if (!request) return res.json(null);
    return res.json(await formatRequestRowEnriched(request));
  } catch (error) {
    console.error('taxi pending-rating error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get pending rating.' });
  }
});

// POST /db/taxi/rate - تقييم السائق بعد الرحلة
router.post('/rate', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, rating, comment } = req.body || {};
    const result = await repo.rateTaxiRequest(phone, requestId, rating, comment);
    return res.json(result);
  } catch (error) {
    console.error('taxi rate error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to rate trip.' });
  }
});

// POST /db/taxi/complaint - شكوى زبون على كابتن بعد اكتمال الرحلة
router.post('/complaint', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, note } = req.body || {};
    const result = await repo.submitTaxiComplaint(phone, requestId, note);
    return res.json(result);
  } catch (error) {
    console.error('taxi complaint error:', error);
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({ message: error?.message || 'Failed to submit complaint.' });
  }
});

// POST /db/taxi/complaints - شكوى زبون على كابتن (كيان مستقل taxi_complaints)
router.post('/complaints', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { requestId, note, rating } = req.body || {};
    const result = await repo.createTaxiComplaint(phone, requestId, note, rating);
    return res.json(result);
  } catch (error) {
    console.error('taxi complaints create error:', error);
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({ message: error?.message || 'Failed to submit complaint.' });
  }
});

// GET /db/taxi/complaints?page=1 - قائمة شكاوى للأدمن (كيان مستقل)
router.get('/complaints', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await repo.listTaxiComplaints(phone, {
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 25),
    });
    return res.json(result);
  } catch (error) {
    console.error('taxi complaints list error:', error);
    const message = error?.message || 'Failed to load complaints.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// PUT /db/taxi/complaints/:id/resolve - حل شكوى (أدمن)
router.put('/complaints/:id/resolve', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await repo.resolveTaxiComplaint(phone, req.params.id, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('taxi complaints resolve error:', error);
    const message = error?.message || 'Failed to resolve complaint.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// GET /db/taxi/history - تاريخ رحلات الزبون (افتراضي آخر 10، والباقي عبر offset)
router.get('/history', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const limit = req.query?.limit;
    const offset = req.query?.offset;
    const page = await repo.getCustomerHistory(phone, { limit, offset });
    const items = (page.items || []).map(formatRequestRow);
    return res.json({
      items,
      hasMore: page.hasMore === true,
      limit: page.limit,
      offset: page.offset,
      stats: page.stats || null,
    });
  } catch (error) {
    console.error('taxi history error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get history.' });
  }
});

// GET /db/taxi/driver-history - تاريخ رحلات السائق
router.get('/driver-history', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    // getDriverHistory يعيد طلبات مُنسَّقة ومُثرية باسم الزبون
    const requests = await repo.getDriverHistory(phone);
    return res.json(requests || []);
  } catch (error) {
    console.error('taxi driver-history error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get driver history.' });
  }
});

// POST /db/taxi/driver-status - تحديث حالة اتصال السائق (متصل/غير متصل)
router.post('/driver-status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const isOnline = req.body?.isOnline === true;
    const manual = req.body?.manual === true;
    if (!isOnline && !manual) {
      return res.json({ success: true, phone, isOnline: true, ignored: 'offline_requires_manual' });
    }
    const result = await repo.setDriverOnlineStatus(phone, isOnline);
    return res.json(result);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    console.error('taxi driver-status error:', error);
    return res.status(status).json({
      message: error?.message || 'Failed to update driver status.',
      code: error?.code || undefined,
    });
  }
});

// GET /db/taxi/admin/drivers-push-health — مراقبة الكباتن المتصلين بلا توكن إشعارات
router.get('/admin/drivers-push-health', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../../supabase_repo/users');
    await assertAdminAccess(phone);

    const { assertSupabaseAdmin, getPhoneVariants } = require('../../supabase_repo/common');
    const { getDeviceTokensForPhone } = require('../../supabase_repo/push_notifications');
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase
      .from('driver_locations')
      .select('phone, driver_name, taxi_type, is_online, available, updated_at')
      .eq('is_online', true)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const rows = [];
    for (const row of data || []) {
      const driverPhone = String(row.phone || '').trim();
      if (!driverPhone) continue;
      const tokens = await getDeviceTokensForPhone(driverPhone);
      const tokenCount = (tokens || []).filter((t) => String(t.token || '').trim()).length;
      const platforms = [
        ...new Set((tokens || []).map((t) => String(t.platform || 'unknown'))),
      ];
      rows.push({
        phone: driverPhone,
        name: String(row.driver_name || '').trim(),
        taxiType: String(row.taxi_type || '').trim(),
        updatedAt: row.updated_at || null,
        hasPushToken: tokenCount > 0,
        tokenCount,
        platforms,
        phoneVariantsSample: getPhoneVariants(driverPhone).slice(0, 2),
      });
    }

    const missing = rows.filter((r) => !r.hasPushToken);
    return res.json({
      onlineCount: rows.length,
      missingPushCount: missing.length,
      missing,
      online: rows,
    });
  } catch (error) {
    console.error('taxi drivers-push-health error:', error);
    const message = error?.message || 'Failed to load drivers push health.';
    const status = /admin/i.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// GET /db/taxi/nearby-drivers - البحث عن سائقين قريبين
router.get('/nearby-drivers', async (req, res) => {
  try {
    const { lat, lng, taxiType } = req.query;
    const pickupLat = Number(req.query.pickupLat ?? lat ?? 0);
    const pickupLng = Number(req.query.pickupLng ?? lng ?? 0);
    const drivers = await repo.getNearbyDrivers(
      pickupLat,
      pickupLng,
      String(taxiType || 'economic').trim(),
      [],
      10
    );
    return res.json(drivers);
  } catch (error) {
    console.error('taxi nearby-drivers error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get nearby drivers.' });
  }
});

// GET /db/taxi/debug/active-drivers - تشخيص آمن لعدد السائقين المستهدفين والتوكنات
router.get('/debug/active-drivers', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertPlatformAdminAccess } = require('../../supabase_repo/admin');
    await assertPlatformAdminAccess(phone);
    const taxiType = normalizeTaxiType(req.query.taxiType || 'economic');
    const phones = await repo.getActiveDriverPhonesByTaxiType(taxiType);
    const { getDeviceTokensForPhone } = require('../../supabase_repo/push_notifications');
    const sample = [];
    for (const driverPhone of phones.slice(0, 20)) {
      const tokens = await getDeviceTokensForPhone(driverPhone);
      sample.push({
        phone: driverPhone,
        tokenCount: tokens.length,
        platforms: [...new Set(tokens.map((row) => String(row.platform || 'unknown')))],
      });
    }
    return res.json({ taxiType, count: phones.length, sample });
  } catch (error) {
    console.error('taxi debug active-drivers error:', error);
    const message = error?.message || 'Failed to debug active drivers.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// POST /db/taxi/debug/test-push - يرسل إشعار اختبار لحساب السائق الحالي بدون كشف التوكن
router.post('/debug/test-push', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { getDeviceTokensForPhone, removeDeviceTokens } = require('../../supabase_repo/push_notifications');
    const { sendPushToTokensDirect } = require('../../services/notification_delivery');
    const rows = await getDeviceTokensForPhone(phone);
    const tokens = rows.map((row) => String(row.token || '').trim()).filter(Boolean);
    const platforms = [...new Set(rows.map((row) => String(row.platform || 'unknown')))];
    const result = await sendPushToTokensDirect(tokens, {
      title: '🔔 اختبار إشعار التكسي',
      body: '✅ إذا رأيت هذا الإشعار مع الصوت، فإشعارات طلبات التكسي تعمل.',
      data: {
        category: 'taxi',
        audience: 'driver',
        eventKey: 'taxi:pool_new',
        orderId: `test-${Date.now()}`,
        requestId: `test-${Date.now()}`,
      },
      showSystemBanner: true,
    });
    if (result.invalidTokens?.length) {
      await removeDeviceTokens(result.invalidTokens);
    }
    const errorMessages = (result.errors || []).map((e) => `${e.code}: ${e.message}`);
    return res.json({
      hasToken: tokens.length > 0,
      tokenCount: tokens.length,
      platforms,
      sent: Number(result.sent || 0),
      failed: Number(result.failed || 0),
      invalidTokens: result.invalidTokens?.length || 0,
      errors: errorMessages,
    });
  } catch (error) {
    console.error('taxi debug test-push error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to test push.' });
  }
});

// GET /db/taxi/incoming-requests - الطلبات الواردة للسائق
// يقبل lat/lng من query params (موقع حالي) أو من ملف السائق المحفوظ
router.get('/incoming-requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;

    // محاولة استخدام الموقع المرسل من التطبيق أولاً
    let lat = Number(req.query.lat ?? 0);
    let lng = Number(req.query.lng ?? 0);

    // إذا لم يُرسَل الموقع، نجلبه من ملف السائق المحفوظ
    if (!lat || !lng) {
      const state = await getUserState(phone);
      const profile = state?.driverProfile;
      if (profile) {
        lat = Number(profile.latitude ?? profile.lat ?? 0);
        lng = Number(profile.longitude ?? profile.lng ?? 0);
      }
    }

    // بدون موقع صالح لا تُعرض طلبات بعيدة
    const taxiType = normalizeTaxiType(
      req.query.taxiType ||
      (await getUserState(phone))?.driverProfile?.taxiType ||
      'economic'
    );

    const requests = await repo.getDriverIncomingRequests(
      phone,
      lat || null,
      lng || null,
      taxiType,
    );
    return res.json(requests);
  } catch (error) {
    const { isTransientDbFailure } = require('../../lib/db_circuit');
    if (isTransientDbFailure(error)) return res.json([]);
    console.error('taxi incoming-requests error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get incoming requests.' });
  }
});

// GET /db/taxi/bazaar/incoming — طلبات تكسي توصيل البازار للسائقين المخصّصين
router.get('/bazaar/incoming', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requests = await repo.getDriverBazaarIncomingRequests(phone);
    return res.json(requests.map((item) => hideCustomerPhone(item)));
  } catch (error) {
    console.error('taxi bazaar incoming error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get bazaar requests.' });
  }
});

// GET /db/taxi/bazaar/is-designated — هل السائق ضمن قائمة تكسي البازار؟
router.get('/bazaar/is-designated', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const designated = await repo.isDesignatedBazaarDriver(phone);
    return res.json({ designated: Boolean(designated) });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Failed.' });
  }
});

// GET /db/taxi/request/:id — جلب طلب واحد (للعرض الفوري عند فتح الإشعار)
router.get('/request/:id', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await repo.getTaxiRequestForActor(phone, req.params.id);
    return res.json(request);
  } catch (error) {
    return res.status(404).json({ message: error?.message || 'Request not found.' });
  }
});

// GET /db/taxi/nearby-count — عدد الكباتن المتاحين قرب نقطة معينة (لشاشة الزبون)
router.get('/nearby-count', async (req, res) => {
  try {
    const lat = Number(req.query.lat || 0);
    const lng = Number(req.query.lng || 0);
    const taxiType = normalizeTaxiType(
      req.query.taxiType || 'economic'
    );
    if (!lat || !lng) {
      return res.json({ count: 0, radiusKm: 0, within: 'any' });
    }
    const { findNearbyDrivers } = require('./repository/driver_locations');
    const drivers = await findNearbyDrivers({
      pickupLat: lat,
      pickupLng: lng,
      taxiType,
      radiusKm: 10,
      limit: 100,
    });
    return res.json({
      count: Array.isArray(drivers) ? drivers.length : 0,
      radiusKm: 10,
      within: taxiType,
    });
  } catch (error) {
    return res.json({ count: 0, radiusKm: 0, within: 'any' });
  }
});
router.get('/admin/metrics', async (req, res) => {
  try {
    const { authenticateBearerSession } = require('../../routes/_middleware');
    const { assertAdminPermission } = require('../../supabase_repo');
    const phone = authenticateBearerSession(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const { getTaxiMetrics } = require('../../services/taxi_metrics_service');
    return res.json(getTaxiMetrics());
  } catch (error) {
    return res.status(403).json({ message: error?.message || 'Admin access required.' });
  }
});

// POST /db/taxi/bazaar/complete-outbound — إكمال رحلة الذهاب وإنشاء طلب عودة مستقل
router.post('/bazaar/complete-outbound', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requestId = String(req.body?.requestId || req.body?.id || '').trim();
    if (!requestId) {
      return res.status(400).json({ message: 'Request id is required.' });
    }
    const collectedFare = req.body?.collectedFare ?? req.body?.fare;
    const result = await repo.completeBazaarOutbound(phone, requestId, {
      collectedFare,
    });
    return res.json(result);
  } catch (error) {
    console.error('taxi bazaar complete-outbound error:', error);
    const status = String(error?.message || '').includes('لا يمكنك')
      ? 403
      : 500;
    return res.status(status).json({ message: error?.message || 'Failed to complete outbound.' });
  }
});

// POST /db/taxi/bazaar/claim-return — التقاط عودة عبر كود 3 أرقام
router.post('/bazaar/claim-return', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { tripCode, driverName, vehicleModel, plateNumber, driverPhoto, carImage } =
      req.body || {};
    const result = await repo.claimBazaarReturnByCode(phone, tripCode, {
      driverName,
      vehicleModel,
      plateNumber,
      driverPhoto,
      carImage,
    });
    return res.json(hideCustomerPhone(result));
  } catch (error) {
    console.error('taxi bazaar claim-return error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to claim return.' });
  }
});

// GET /db/taxi/favorite-places — أماكن مفضلة للزبون
router.get('/favorite-places', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const places = await getTaxiFavoritePlaces(phone);
    return res.json(places);
  } catch (error) {
    console.error('taxi favorite-places get error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load favorite places.' });
  }
});

// PUT /db/taxi/favorite-places — حفظ/تحديث مكان مفضل
router.put('/favorite-places', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const places = await saveTaxiFavoritePlace(phone, req.body || {});
    return res.json(places);
  } catch (error) {
    console.error('taxi favorite-places save error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save favorite place.' });
  }
});

// DELETE /db/taxi/favorite-places/:id — حذف مكان مفضل
router.delete('/favorite-places/:id', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const places = await deleteTaxiFavoritePlace(phone, req.params.id);
    return res.json(places);
  } catch (error) {
    console.error('taxi favorite-places delete error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete favorite place.' });
  }
});

module.exports = router;
