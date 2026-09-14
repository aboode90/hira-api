/**
 * Taxi Push Events
 * 
 * دوال إرسال الإشعارات الخاصة بخدمة التكسي.
 */

const { sendPushToPhone } = require('../push_events');
const { getDeviceTokensForPhone, removeDeviceTokens } = require('../supabase_repo');
const { sendPushToTokensDirect } = require('../services/notification_delivery');
const {
  roadDistanceKm,
  formatDriverAwayRoadAr,
} = require('../lib/mapbox_road_distance');

/**
 * بناء payload موحد للإشعارات
 */
function buildPushPayload({ title, body, data = {} }) {
  return {
    title,
    body,
    data: {
      category: 'taxi',
      ...data,
    },
  };
}

function pickupCoordsFromRequestMeta(requestMeta) {
  const lat = Number(
    requestMeta?.pickupLat ||
      requestMeta?.pickup_lat ||
      requestMeta?.payload?.pickupLat ||
      0,
  );
  const lng = Number(
    requestMeta?.pickupLng ||
      requestMeta?.pickup_lng ||
      requestMeta?.payload?.pickupLng ||
      0,
  );
  if (!(lat && lng)) return null;
  return { lat, lng };
}

function driverCoordsFromNearbyEntry(driver) {
  if (!driver || typeof driver !== 'object') return null;
  const lat = Number(
    driver.currentLat ?? driver.lat ?? driver.latitude ?? 0,
  );
  const lng = Number(
    driver.currentLng ?? driver.lng ?? driver.longitude ?? 0,
  );
  if (!(lat && lng)) return null;
  return { lat, lng };
}

function withAwayPrefix(body, awayLabel) {
  const label = String(awayLabel || '').trim();
  const base = String(body || '').trim();
  if (!label) return base;
  if (!base) return label;
  return `${label} · ${base}`;
}

async function resolveDriverAwayToPickup(phone, pickup, coordsHint) {
  if (!pickup) return { label: '', km: null };
  let coords = coordsHint || null;
  if (!coords) {
    try {
      const driverLocations = require('../domains/taxi/repository/driver_locations');
      const fresh = await driverLocations.getFreshDriverLocation(phone);
      if (fresh?.lat && fresh?.lng) {
        coords = { lat: Number(fresh.lat), lng: Number(fresh.lng) };
      }
    } catch (_) {}
  }
  if (!coords) return { label: '', km: null };
  const km = await roadDistanceKm(coords, pickup, { timeoutMs: 2500 });
  if (km == null || !Number.isFinite(km)) return { label: '', km: null };
  return { label: formatDriverAwayRoadAr(km), km };
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const results = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await worker(list[index], index);
    }
  };
  const pool = Math.min(Math.max(Number(concurrency) || 1, 1), list.length);
  await Promise.all(Array.from({ length: pool }, () => run()));
  return results;
}

async function collectTokensForPhones(phones) {
  const { resolvePhoneKey } = require('../supabase_repo/common');
  const uniquePhones = [...new Set(phones.map((p) => String(p || '').trim()).filter(Boolean))];
  if (uniquePhones.length === 0) return { tokens: [], phonesWithoutTokens: [] };

  const resolvedPhones = [];
  for (const phone of uniquePhones) {
    try {
      const key = await resolvePhoneKey(phone);
      resolvedPhones.push(String(key || phone).trim());
    } catch (_) {
      resolvedPhones.push(phone);
    }
  }
  const uniqueResolved = [...new Set(resolvedPhones.filter(Boolean))];

  const { getPhoneVariants } = require('../supabase_repo/common');
  const allVariants = uniqueResolved.flatMap((phone) => getPhoneVariants(phone));
  const uniqueVariants = [...new Set(allVariants)];

  if (uniqueVariants.length === 0) return { tokens: [], phonesWithoutTokens: uniqueResolved };

  try {
    const { selectMany } = require('../supabase_repo');
    const rows = await selectMany(
      'device_tokens',
      [{ method: 'in', column: 'phone', value: uniqueVariants }],
      { column: 'updated_at', ascending: false }
    );

    const tokens = [];
    const phonesWithoutTokens = [];

    const variantToTokens = {};
    for (const row of rows) {
      const token = String(row.token || '').trim();
      const phoneVal = String(row.phone || '').trim();
      if (token && phoneVal) {
        if (!variantToTokens[phoneVal]) variantToTokens[phoneVal] = [];
        variantToTokens[phoneVal].push(token);
      }
    }

    for (const phone of uniqueResolved) {
      const variants = getPhoneVariants(phone);
      const phoneTokens = [];
      for (const variant of variants) {
        if (variantToTokens[variant]) {
          phoneTokens.push(...variantToTokens[variant]);
        }
      }
      if (phoneTokens.length === 0) {
        phonesWithoutTokens.push(phone);
      } else {
        tokens.push(...phoneTokens);
      }
    }

    return { tokens: [...new Set(tokens)], phonesWithoutTokens };
  } catch (error) {
    console.error('taxi batch push token lookup error:', error?.message || error);
    // Fallback to legacy loop if batch fails
    const results = await Promise.allSettled(
      uniqueResolved.map(async (phone) => {
        const rows = await getDeviceTokensForPhone(phone);
        const phoneTokens = rows.map((row) => String(row.token || '').trim()).filter(Boolean);
        return { phone, tokens: phoneTokens };
      })
    );

    const tokens = [];
    const phonesWithoutTokens = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.tokens.length === 0) {
          phonesWithoutTokens.push(result.value.phone);
        }
        tokens.push(...result.value.tokens);
      } else {
        phonesWithoutTokens.push('unknown');
      }
    }
    return { tokens: [...new Set(tokens)], phonesWithoutTokens };
  }
}

/**
 * إرسال إشعار لكل السائقين المتصلين من نفس النوع.
 * الأولوية للأقرب جغرافياً، ثم بقية السائقين المتصلين.
 */
async function notifyNewTaxiRequest(requestMeta, nearbyDrivers = [], options = {}) {
  const emptyAudit = {
    targetCount: 0,
    targets: [],
    fcmSent: 0,
    fcmFailed: 0,
  };
  const requestId = String(requestMeta?.id || requestMeta?.requestId || '').trim();
  if (!requestId) return emptyAudit;

  const serviceKind = String(requestMeta.serviceKind || options.serviceKind || '').trim();
  const isDelivery = serviceKind === 'taxi_delivery';
  const taxiTypeAr = { economic: 'تكسي', tuktuk: 'تكتك', wazz: 'واز', starx11: 'ستاركس 11' }[requestMeta.taxiType] || 'تكسي';
  const isAdminCustomer = Boolean(
    requestMeta?.isAdminCustomer ??
      requestMeta?.payload?.isAdminCustomer ??
      false
  );
  const isHurryBump =
    options.hurryBump === true ||
    requestMeta?.hurryBump === true ||
    String(options.trigger || '').trim() === 'hurry_bump';

  // بناء نص إشعار مفيد للكابتن (الأجرة + المسافة + العنوانين)
  const fareValue = Number(requestMeta.fare) || 0;
  const distanceValue = Number(requestMeta.distanceKm || requestMeta.distance_km) || 0;
  const pickupText = String(requestMeta.pickupAddress || requestMeta.pickup_address || '').trim();
  const dropoffText = String(requestMeta.dropoffAddress || requestMeta.dropoff_address || '').trim();
  const tripTypeRaw = String(
    requestMeta.tripType ||
      requestMeta.trip_type ||
      requestMeta.payload?.tripType ||
      '',
  ).trim();
  const serviceKindRaw = String(
    requestMeta.serviceKind ||
      requestMeta.payload?.serviceKind ||
      serviceKind ||
      '',
  ).trim();
  const tripModeRaw = String(
    requestMeta.tripMode || requestMeta.payload?.tripMode || '',
  ).trim();
  const isOpenTrip =
    serviceKindRaw === 'open_trip' || tripModeRaw === 'open';
  let tripKindAr = 'ذهاب فقط';
  if (isOpenTrip) {
    tripKindAr = 'رحلة مفتوحة';
  } else if (
    isDelivery ||
    tripTypeRaw === 'round_trip' ||
    tripTypeRaw === 'bazaar_round_trip' ||
    requestMeta.isRoundTrip === true ||
    requestMeta.payload?.isRoundTrip === true
  ) {
    tripKindAr = 'ذهاب وعودة';
  }

  const detailParts = [];
  detailParts.push(tripKindAr);
  if (distanceValue > 0) {
    detailParts.push(`المسافة: ${distanceValue.toFixed(1)} كم`);
  }
  // رحلة مفتوحة: لا نعرض 1500 في الإشعار — الأجرة تُحسب عند الإنهاء.
  if (fareValue > 0 && !isOpenTrip) {
    detailParts.push(`الأجرة: ${fareValue.toLocaleString('en-US')} د.ع`);
  }
  if (pickupText) detailParts.push(`من: ${pickupText}`);
  if (dropoffText) detailParts.push(`إلى: ${dropoffText}`);
  const richBody = detailParts.join(' · ');

  const driverPayload = buildPushPayload({
    title: isHurryBump
      ? isOpenTrip
        ? `⚡ مستعجل — رحلة مفتوحة`
        : `⚡ مستعجل — الأجرة ${fareValue.toLocaleString('en-US')} د.ع`
      : isAdminCustomer
        ? `🚕 طلب ${taxiTypeAr} · الادمن — ${tripKindAr}`
        : `🚕 طلب ${taxiTypeAr} — ${tripKindAr}`,
    body: isHurryBump
      ? isOpenTrip
        ? 'الزبون مستعجل — افتح الطلب'
        : `الزبون رفع الأجرة إلى ${fareValue.toLocaleString('en-US')} د.ع — افتح الطلب`
      : isAdminCustomer
        ? 'الادمن — افتح التطبيق لعرض التفاصيل.'
        : richBody
          ? richBody
          : 'لديك طلب خدمة توصيل، افتح التطبيق لعرض التفاصيل.',
    data: {
      audience: 'driver',
      eventKey: isHurryBump ? 'taxi:hurry_bump' : 'taxi:pool_new',
      orderId: requestId,
      requestId,
      // بيانات الطلب كاملة — لعرض فوري عند فتح الإشعار دون انتظار الخادم.
      requestNumber: String(
        requestMeta.payload?.requestNumber ||
          requestMeta.requestNumber ||
          ''
      ).trim(),
      customerName: String(
        requestMeta.payload?.customerName ||
          requestMeta.customerName ||
          ''
      ).trim(),
      pickupAddress: String(
        requestMeta.pickupAddress ||
          requestMeta.pickup_address ||
          requestMeta.payload?.pickupAddress ||
          ''
      ).trim(),
      dropoffAddress: String(
        requestMeta.dropoffAddress ||
          requestMeta.dropoff_address ||
          requestMeta.payload?.dropoffAddress ||
          ''
      ).trim(),
      pickupLat: String(
        requestMeta.pickupLat ||
          requestMeta.pickup_lat ||
          requestMeta.payload?.pickupLat ||
          '0'
      ),
      pickupLng: String(
        requestMeta.pickupLng ||
          requestMeta.pickup_lng ||
          requestMeta.payload?.pickupLng ||
          '0'
      ),
      dropoffLat: String(
        requestMeta.dropoffLat ||
          requestMeta.dropoff_lat ||
          requestMeta.payload?.dropoffLat ||
          '0'
      ),
      dropoffLng: String(
        requestMeta.dropoffLng ||
          requestMeta.dropoff_lng ||
          requestMeta.payload?.dropoffLng ||
          '0'
      ),
      fare: String(
        requestMeta.fare ||
          requestMeta.payload?.fare ||
          '0'
      ),
      fareEconomic: String(
        requestMeta.fareEconomic ||
          requestMeta.payload?.fareEconomic ||
          '0'
      ),
      fareSuper: String(
        requestMeta.fareSuper ||
          requestMeta.payload?.fareSuper ||
          '0'
      ),
      distanceKm: String(
        requestMeta.distanceKm ||
          requestMeta.distance_km ||
          requestMeta.payload?.distanceKm ||
          '0'
      ),
      taxiType: String(
        requestMeta.taxiType ||
          requestMeta.taxi_type ||
          requestMeta.payload?.taxiType ||
          'economic'
      ).trim(),
      noteAr: String(
        requestMeta.payload?.noteAr ||
          requestMeta.noteAr ||
          requestMeta.payload?.note ||
          ''
      ).trim(),
      isAdminCustomer: isAdminCustomer ? '1' : '0',
      serviceKind: isDelivery ? 'taxi_delivery' : '',
      tripType: String(
        requestMeta.tripType ||
          requestMeta.payload?.tripType ||
          'one_way',
      ).trim(),
      createdAt: String(
        requestMeta.createdAt ||
          requestMeta.payload?.createdAt ||
          requestMeta.created_at ||
          '',
      ).trim(),
      priorityCaptainPhone: String(
        requestMeta.payload?.priorityCaptainPhone ||
          requestMeta.priorityCaptainPhone ||
          '',
      ).trim(),
      priorityExclusiveUntil: String(
        requestMeta.payload?.priorityExclusiveUntil ||
          requestMeta.priorityExclusiveUntil ||
          '',
      ).trim(),
      priorityRadarOpened:
        requestMeta.payload?.priorityRadarOpened === true ||
        requestMeta.priorityRadarOpened === true
          ? '1'
          : '0',
      statusKey: 'pending',
      statusAr: String(
        requestMeta.payload?.statusAr ||
          requestMeta.statusAr ||
          'بانتظار سائق'
      ).trim(),
    },
  });

  console.log('[TAXI_PUSH] request', requestId,
    'fare=', requestMeta.fare,
    'distance=', requestMeta.distanceKm,
    'pickup=', requestMeta.pickupAddress,
    'dropoff=', requestMeta.dropoffAddress,
    'body=', driverPayload.body);

  const taxiType = String(requestMeta.taxiType || 'economic').trim();
  const excludePhones = Array.isArray(requestMeta.excludePhones) ? requestMeta.excludePhones : [];
  const excludeSet = new Set(excludePhones.map((p) => String(p || '').trim()).filter(Boolean));
  const seenPhones = new Set(excludeSet);
  const orderedPhones = [];
  const tierByPhone = new Map();

  const restrictToPhones = Array.isArray(options.restrictToPhones)
    ? options.restrictToPhones
    : null;

  if (restrictToPhones) {
    for (const phone of restrictToPhones) {
      const normalized = String(phone || '').trim();
      if (!normalized || seenPhones.has(normalized)) continue;
      seenPhones.add(normalized);
      orderedPhones.push(normalized);
      tierByPhone.set(normalized, 'designated');
    }
  } else {
    const nearbyList = Array.isArray(nearbyDrivers) ? nearbyDrivers : [];
    for (const driver of nearbyList) {
      const phone = String(driver?.driverPhone || driver?.phone || '').trim();
      if (!phone || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      orderedPhones.push(phone);
      tierByPhone.set(phone, String(driver?.tier || 'active_online'));
    }
  }

  // إشعار فوري إجباري لكل كباتن النوع المستهدفين (لا نقطع عند 40).
  const maxTargets = Math.min(
    Math.max(orderedPhones.length, restrictToPhones ? restrictToPhones.length : 0, 1),
    500,
  );
  const targetPhones = orderedPhones.slice(0, maxTargets);

  // إشعار داخلي + FCM لكل كابتن مع مسافة الطريق إلى نقطة الانطلاق.
  const pickupCoords = pickupCoordsFromRequestMeta(requestMeta);
  const coordsByPhone = new Map();
  for (const driver of Array.isArray(nearbyDrivers) ? nearbyDrivers : []) {
    const phone = String(driver?.driverPhone || driver?.phone || '').trim();
    const coords = driverCoordsFromNearbyEntry(driver);
    if (phone && coords) coordsByPhone.set(phone, coords);
  }

  const sendResults = await mapPool(targetPhones, 8, async (phone) => {
    const away = await resolveDriverAwayToPickup(
      phone,
      pickupCoords,
      coordsByPhone.get(phone) || null,
    );
    const body = withAwayPrefix(driverPayload.body, away.label);
    const data = {
      ...driverPayload.data,
      driverAwayKm:
        away.km != null && Number.isFinite(away.km)
          ? String(Math.round(away.km * 100) / 100)
          : '',
      driverAwayLabel: away.label || '',
    };

    try {
      const { insertUserNotificationsBulk } = require('../supabase_repo/user_notifications');
      const { nowIso } = require('../supabase_repo/common');
      await insertUserNotificationsBulk([
        {
          phone,
          title: driverPayload.title,
          body,
          audience: 'driver',
          category: 'taxi',
          event_key: isHurryBump
            ? `taxi:hurry_bump:${requestId}`
            : `taxi:pool_new:${requestId}`,
          is_read: false,
          created_at: nowIso(),
        },
      ]);
    } catch (_) {}

    try {
      const result = await sendPushToPhone(
        phone,
        buildPushPayload({
          title: driverPayload.title,
          body,
          data,
        }),
        { showSystemBanner: true, immediate: true },
      );
      return {
        phone,
        sent: Number(result?.sent || 0),
        failed: Number(result?.failed || 0),
        awayKm: away.km,
        reason: String(result?.reason || ''),
      };
    } catch (error) {
      console.warn(
        'taxi push per-driver error:',
        phone,
        error?.message || error,
      );
      return { phone, sent: 0, failed: 1, awayKm: away.km, reason: 'error' };
    }
  });

  const fcmSent = sendResults.reduce((sum, row) => sum + Number(row?.sent || 0), 0);
  const fcmFailed = sendResults.reduce(
    (sum, row) => sum + Number(row?.failed || 0),
    0,
  );
  const noTokenKeys = new Set(
    sendResults
      .filter((row) => String(row?.reason || '') === 'no_tokens')
      .map((row) => String(row?.phone || '').replace(/\D/g, '').slice(-10))
      .filter(Boolean),
  );

  console.log('taxi push notifyNewTaxiRequest summary:', {
    requestId,
    taxiType,
    serviceKind: serviceKind || 'standard',
    targets: targetPhones.length,
    sent: fcmSent,
    failed: fcmFailed,
    withAway: sendResults.filter((row) => row?.awayKm != null).length,
    targetPhones,
  });

  return {
    targetCount: targetPhones.length,
    targets: targetPhones.map((phone) => {
      const key = String(phone || '').replace(/\D/g, '').slice(-10);
      return {
        phone,
        tier: tierByPhone.get(phone) || 'active_online',
        deliveryStatus: key && noTokenKeys.has(key) ? 'no_token' : 'attempted',
      };
    }),
    fcmSent,
    fcmFailed,
  };
}

/**
 * إرسال إشعار لسائق واحد محدد (بعد رفض سابق أو مطابقة تلقائية).
 * لا يبحث عن سائقين إضافيين  Avoids notifying all active drivers on rejection.
 */
async function notifySingleDriver(requestMeta, driverPhone) {
  const emptyAudit = {
    targetCount: 0,
    targets: [],
    fcmSent: 0,
    fcmFailed: 0,
  };
  const requestId = String(requestMeta?.id || requestMeta?.requestId || '').trim();
  const phone = String(driverPhone || '').trim();
  if (!requestId || !phone) return emptyAudit;

  const tripTypeRaw = String(
    requestMeta.tripType ||
      requestMeta.trip_type ||
      requestMeta.payload?.tripType ||
      '',
  ).trim();
  const serviceKindRaw = String(
    requestMeta.serviceKind || requestMeta.payload?.serviceKind || '',
  ).trim();
  const tripModeRaw = String(
    requestMeta.tripMode || requestMeta.payload?.tripMode || '',
  ).trim();
  let tripKindAr = 'ذهاب فقط';
  if (serviceKindRaw === 'open_trip' || tripModeRaw === 'open') {
    tripKindAr = 'رحلة مفتوحة';
  } else if (
    serviceKindRaw === 'taxi_delivery' ||
    tripTypeRaw === 'round_trip' ||
    tripTypeRaw === 'bazaar_round_trip' ||
    requestMeta.isRoundTrip === true ||
    requestMeta.payload?.isRoundTrip === true
  ) {
    tripKindAr = 'ذهاب وعودة';
  }

  const payload = buildPushPayload({
    title: `🚕 طلب تكسي جديد — ${tripKindAr}`,
    body: `${tripKindAr} · من: ${requestMeta.pickupAddress || 'غير محدد'} → إلى: ${requestMeta.dropoffAddress || 'غير محدد'}`,
    data: {
      audience: 'driver',
      eventKey: 'taxi:pool_new',
      orderId: requestId,
      requestId,
      requestNumber: String(
        requestMeta.payload?.requestNumber || requestMeta.requestNumber || ''
      ).trim(),
      customerName: String(
        requestMeta.payload?.customerName || requestMeta.customerName || ''
      ).trim(),
      pickupAddress: String(
        requestMeta.pickupAddress ||
          requestMeta.pickup_address ||
          requestMeta.payload?.pickupAddress ||
          ''
      ).trim(),
      dropoffAddress: String(
        requestMeta.dropoffAddress ||
          requestMeta.dropoff_address ||
          requestMeta.payload?.dropoffAddress ||
          ''
      ).trim(),
      pickupLat: String(
        requestMeta.pickupLat ||
          requestMeta.pickup_lat ||
          requestMeta.payload?.pickupLat ||
          '0'
      ),
      pickupLng: String(
        requestMeta.pickupLng ||
          requestMeta.pickup_lng ||
          requestMeta.payload?.pickupLng ||
          '0'
      ),
      dropoffLat: String(
        requestMeta.dropoffLat ||
          requestMeta.dropoff_lat ||
          requestMeta.payload?.dropoffLat ||
          '0'
      ),
      dropoffLng: String(
        requestMeta.dropoffLng ||
          requestMeta.dropoff_lng ||
          requestMeta.payload?.dropoffLng ||
          '0'
      ),
      fare: String(requestMeta.fare || requestMeta.payload?.fare || '0'),
      fareEconomic: String(
        requestMeta.fareEconomic || requestMeta.payload?.fareEconomic || '0'
      ),
      fareSuper: String(
        requestMeta.fareSuper || requestMeta.payload?.fareSuper || '0'
      ),
      distanceKm: String(
        requestMeta.distanceKm ||
          requestMeta.distance_km ||
          requestMeta.payload?.distanceKm ||
          '0'
      ),
      taxiType: String(
        requestMeta.taxiType ||
          requestMeta.taxi_type ||
          requestMeta.payload?.taxiType ||
          'economic'
      ).trim(),
      noteAr: String(
        requestMeta.payload?.noteAr || requestMeta.noteAr || ''
      ).trim(),
      isAdminCustomer: requestMeta.isAdminCustomer ? '1' : '0',
      serviceKind: String(requestMeta.serviceKind || '').trim(),
      statusKey: 'pending',
      statusAr: String(
        requestMeta.payload?.statusAr ||
          requestMeta.statusAr ||
          'بانتظار سائق'
      ).trim(),
    },
  });

  const away = await resolveDriverAwayToPickup(
    phone,
    pickupCoordsFromRequestMeta(requestMeta),
    null,
  );
  const body = withAwayPrefix(payload.body, away.label);
  const data = {
    ...payload.data,
    driverAwayKm:
      away.km != null && Number.isFinite(away.km)
        ? String(Math.round(away.km * 100) / 100)
        : '',
    driverAwayLabel: away.label || '',
  };

  const { tokens } = await collectTokensForPhones([phone]);
  if (tokens.length === 0) {
    return {
      targetCount: 1,
      targets: [{ phone, tier: 'nearby', deliveryStatus: 'no_token' }],
      fcmSent: 0,
      fcmFailed: 0,
    };
  }

  const result = await sendPushToTokensDirect(tokens, {
    title: payload.title,
    body,
    data,
    showSystemBanner: true,
  });
  if (result.invalidTokens?.length) {
    await removeDeviceTokens(result.invalidTokens);
  }

  console.log('taxi push notifySingleDriver:', {
    requestId,
    driverPhone: phone,
    sent: result.sent,
    awayKm: away.km,
  });
  return {
    targetCount: 1,
    targets: [{ phone, tier: 'nearby', deliveryStatus: 'attempted' }],
    fcmSent: Number(result?.sent || 0),
    fcmFailed: Number(result?.failed || 0),
  };
}

/**
 * إشعار الزبون بقبول السائق
 */
function tripIds(requestId) {
  const id = String(requestId || '').trim();
  return id ? { orderId: id, requestId: id } : {};
}

async function notifyDriverAccepted(customerPhone, driverName, vehicleInfo, requestId) {
  if (!customerPhone) return;

  const payload = buildPushPayload({
    title: 'تم قبول طلبك',
    body: `وافق الكابتن ${driverName || ''} على طلبك وهو في الطريق إليك`,
    data: {
      eventKey: 'taxi:driver_accepted',
      audience: 'customer',
      driverName: String(driverName || '').trim(),
      vehicleInfo: String(vehicleInfo || '').trim(),
      ...tripIds(requestId),
    },
  });

  await sendPushToPhone(customerPhone, payload, { showSystemBanner: true, immediate: true });
}

/** إشعار الزبون بتحويل الرحلة لكابتن آخر من الإدارة. */
async function notifyAdminReassignedCaptain(
  customerPhone,
  driverName,
  vehicleInfo,
  requestId,
) {
  if (!customerPhone) return;
  const name = String(driverName || '').trim();
  const payload = buildPushPayload({
    title: 'تم تعيين كابتن جديد',
    body: name
      ? `الكابتن ${name} سيتابع رحلتك — تم التحديث من الإدارة`
      : 'تم تعيين كابتن جديد لرحلتك من الإدارة',
    data: {
      eventKey: 'taxi:admin_reassigned',
      audience: 'customer',
      driverName: name,
      vehicleInfo: String(vehicleInfo || '').trim(),
      ...tripIds(requestId),
    },
  });
  await sendPushToPhone(customerPhone, payload, { showSystemBanner: true, immediate: true });
}

/** إشعار الكابتn بأن الإدارة عيّنته للرحلة (ليس طلب pool عادي). */
async function notifyDriverAdminAssigned(requestMeta, driverPhone) {
  const emptyAudit = {
    targetCount: 0,
    targets: [],
    fcmSent: 0,
    fcmFailed: 0,
  };
  const requestId = String(requestMeta?.id || requestMeta?.requestId || '').trim();
  const phone = String(driverPhone || '').trim();
  if (!requestId || !phone) return emptyAudit;

  const requestNumber = String(
    requestMeta.requestNumber || requestMeta.payload?.requestNumber || '',
  ).trim();
  const pickupText = String(requestMeta.pickupAddress || requestMeta.payload?.pickupAddress || '').trim();
  const dropoffText = String(requestMeta.dropoffAddress || requestMeta.payload?.dropoffAddress || '').trim();

  const payload = buildPushPayload({
    title: '🚕 تم تعيينك للرحلة',
    body: requestNumber
      ? `عيّنتك الإدارة للرحلة ${requestNumber} — افتح التطبيق للمتابعة`
      : 'عيّنتك الإدارة لرحلة — افتح التطبيق للمتابعة',
    data: {
      audience: 'driver',
      eventKey: 'taxi:admin_assigned',
      orderId: requestId,
      requestId,
      requestNumber,
      pickupAddress: pickupText,
      dropoffAddress: dropoffText,
      pickupLat: String(requestMeta.pickupLat || requestMeta.payload?.pickupLat || '0'),
      pickupLng: String(requestMeta.pickupLng || requestMeta.payload?.pickupLng || '0'),
      dropoffLat: String(requestMeta.dropoffLat || requestMeta.payload?.dropoffLat || '0'),
      dropoffLng: String(requestMeta.dropoffLng || requestMeta.payload?.dropoffLng || '0'),
      fare: String(requestMeta.fare || requestMeta.payload?.fare || '0'),
      distanceKm: String(requestMeta.distanceKm || requestMeta.payload?.distanceKm || '0'),
      taxiType: String(requestMeta.taxiType || requestMeta.payload?.taxiType || 'economic'),
      serviceKind: String(requestMeta.serviceKind || requestMeta.payload?.serviceKind || ''),
      statusKey: String(requestMeta.statusKey || requestMeta.payload?.statusKey || 'accepted'),
    },
  });

  const { tokens } = await collectTokensForPhones([phone]);
  if (tokens.length === 0) {
    return {
      targetCount: 1,
      targets: [{ phone, tier: 'admin_assigned', deliveryStatus: 'no_token' }],
      fcmSent: 0,
      fcmFailed: 0,
    };
  }

  const result = await sendPushToTokensDirect(tokens, {
    title: payload.title,
    body: payload.body,
    data: payload.data,
    showSystemBanner: true,
  });
  if (result.invalidTokens?.length) {
    await removeDeviceTokens(result.invalidTokens);
  }

  return {
    targetCount: 1,
    targets: [{ phone, tier: 'admin_assigned', deliveryStatus: 'attempted' }],
    fcmSent: Number(result?.sent || 0),
    fcmFailed: Number(result?.failed || 0),
  };
}

/**
 * إشعار الزبون بوصول السائق
 */
async function notifyDriverArrived(customerPhone, requestId) {
  if (!customerPhone) return;
  const payload = buildPushPayload({
    title: 'وصل الكابتن',
    body: 'الكابتن في مكان الالتقاء وهو بانتظارك',
    data: {
      eventKey: 'taxi:driver_arrived',
      audience: 'customer',
      ...tripIds(requestId),
    },
  });

  await sendPushToPhone(customerPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

/**
 * إشعار الزبون أن السائق انطلق نحوه
 */
async function notifyDriverOnWay(customerPhone, requestId) {
  if (!customerPhone) return;
  const payload = buildPushPayload({
    title: 'الكابتن في الطريق',
    body: 'الكابتن في الطريق إليك الآن',
    data: { eventKey: 'taxi:driver_on_way', audience: 'customer', ...tripIds(requestId) },
  });
  await sendPushToPhone(customerPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

/**
 * إشعار الزبون ببدء الرحلة بعد الركوب
 */
async function notifyTripStarted(customerPhone, requestId) {
  if (!customerPhone) return;
  const payload = buildPushPayload({
    title: 'بدأت الرحلة',
    body: 'تم الاستلام — أنت في الطريق إلى الوجهة',
    data: { eventKey: 'taxi:trip_started', audience: 'customer', ...tripIds(requestId) },
  });
  await sendPushToPhone(customerPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

/**
 * إشعار الطرفين باكتمال الرحلة
 */
async function notifyTripCompleted(customerPhone, driverPhone, fare, requestId) {
  const fareLabel = Number(fare || 0).toLocaleString('en-US');
  const ids = tripIds(requestId);
  const customerPayload = buildPushPayload({
    title: 'اكتملت الرحلة',
    body: `وصلت بسلام — نتمنى لك يوماً رائعاً. الأجرة: ${fareLabel} د.ع`,
    data: {
      eventKey: 'taxi:trip_completed',
      audience: 'customer',
      fare: String(fare || '0'),
      ...ids,
    },
  });
  const driverPayload = buildPushPayload({
    title: 'اكتملت الرحلة',
    body: `تم إنهاء الرحلة بنجاح. الأجرة: ${fareLabel} د.ع`,
    data: {
      eventKey: 'taxi:trip_completed',
      audience: 'driver',
      fare: String(fare || '0'),
      ...ids,
    },
  });

  if (customerPhone) {
    try {
      await sendPushToPhone(customerPhone, customerPayload, {
        showSystemBanner: true,
        immediate: true,
      });
    } catch (error) {
      console.error(
        `taxi push notifyTripCompleted error for ${customerPhone}:`,
        error?.message || error
      );
    }
  }
  if (driverPhone) {
    try {
      await sendPushToPhone(driverPhone, driverPayload, {
        showSystemBanner: true,
        immediate: true,
      });
    } catch (error) {
      console.error(
        `taxi push notifyTripCompleted error for ${driverPhone}:`,
        error?.message || error
      );
    }
  }
}

/**
 * إشعار السائق بأنه تم رفضه (لن يُستخدم حالياً ولكن للتوثيق)
 */
async function notifyDriverRejected(driverPhone) {
  if (!driverPhone) return;

  const payload = buildPushPayload({
    title: '❌ تم رفضك',
    body: 'عذراً، تم تعيين سائق آخر لهذا الطلب',
    data: {
      audience: 'driver',
      eventKey: 'taxi:driver_rejected',
    },
  });

  await sendPushToPhone(driverPhone, payload);
}

async function notifyCancelRequested(driverPhone, customerPhone) {
  if (!driverPhone) return;
  const payload = buildPushPayload({
    title: 'طلب إلغاء من الزبون',
    body: 'يرجى الموافقة أو رفض طلب الإلغاء',
    data: {
      audience: 'driver',
      eventKey: 'taxi:cancel_requested',
    },
  });
  await sendPushToPhone(driverPhone, payload);
}

async function notifyCancellationApproved(customerPhone) {
  if (!customerPhone) return;
  const payload = buildPushPayload({
    title: 'تم إلغاء الرحلة',
    body: 'وافق السائق على إلغاء الرحلة',
    data: { eventKey: 'taxi:cancel_approved' },
  });
  await sendPushToPhone(customerPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

async function notifyCancellationRejected(customerPhone) {
  if (!customerPhone) return;
  const payload = buildPushPayload({
    title: 'استمرار الرحلة',
    body: 'رفض السائق طلب الإلغاء — الرحلة مستمرة',
    data: { eventKey: 'taxi:cancel_rejected' },
  });
  await sendPushToPhone(customerPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

async function notifyDriverRated(driverPhone, requestId) {
  if (!driverPhone) return;
  const id = String(requestId || '').trim();
  const payload = buildPushPayload({
    title: 'تم تقييمك بعد الرحلة',
    body: 'قيّمك الزبون بعد الرحلة — شكراً لخدمتك',
    data: {
      audience: 'driver',
      eventKey: `taxi:${id}:driver_rated`,
      orderId: id,
      requestId: id,
    },
  });
  await sendPushToPhone(driverPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

async function notifyTripCancelled(customerPhone, driverPhone, reason = '', requestId = '') {
  const trimmedReason = String(reason || '').trim();
  const id = String(requestId || '').trim();
  const reasonText = trimmedReason
    ? trimmedReason
    : 'تم إلغاء طلب التكسي';
  const send = async (phone, audience) => {
    if (!phone) return;
    const payload = buildPushPayload({
      title: 'تم إلغاء الرحلة',
      body: reasonText,
      data: {
        audience,
        eventKey: 'taxi:cancelled',
        reason: trimmedReason,
        cancelledBy: trimmedReason.includes('الزبون') ? 'customer' : '',
        orderId: id,
        requestId: id,
      },
    });
    try {
      await sendPushToPhone(phone, payload, {
        showSystemBanner: true,
        immediate: true,
      });
    } catch (error) {
      console.error(
        `taxi push notifyTripCancelled error for ${phone}:`,
        error?.message || error
      );
    }
  };
  await send(customerPhone, 'customer');
  await send(driverPhone, 'driver');
}

async function notifyDriversRequestCancelled(driverPhones, requestId, reason = '') {
  const id = String(requestId || '').trim();
  if (!id) return;
  const uniquePhones = [
    ...new Set((driverPhones || []).map((item) => String(item || '').trim()).filter(Boolean)),
  ];
  if (uniquePhones.length === 0) return;
  const payload = buildPushPayload({
    title: 'تم إلغاء الطلب',
    body: String(reason || '').trim() || 'ألغى الزبون الطلب',
    data: {
      audience: 'driver',
      eventKey: 'taxi:cancelled',
      cancelledBy: 'customer',
      orderId: id,
      requestId: id,
    },
  });
  await Promise.all(
    uniquePhones.map((phone) =>
      sendPushToPhone(phone, payload, {
        showSystemBanner: true,
        immediate: true,
      }).catch((error) => {
        console.error(
          `taxi push notifyDriversRequestCancelled error for ${phone}:`,
          error?.message || error,
        );
      }),
    ),
  );
}

async function notifyDriverApproaching(customerPhone, distanceMeters) {
  if (!customerPhone) return;
  const meters = Math.max(1, Number(distanceMeters) || 100);
  const payload = buildPushPayload({
    title: 'الكابتن قريب عليك',
    body: `الكابتن على بعد نحو ${meters} متر منك`,
    data: { eventKey: 'taxi:driver_approaching' },
  });
  await sendPushToPhone(customerPhone, payload, { showSystemBanner: true, immediate: true });
}

async function notifyReturnWaiting(customerPhone, driverPhone, waitingMinutes) {
  const title = 'انتظار العودة';
  const body = waitingMinutes ? `السائق ينتظرك للعودة — ${waitingMinutes} دقيقة` : 'السائق ينتظرك للعودة';
  const targets = [customerPhone, driverPhone].filter(Boolean);
  const data = { eventKey: 'taxi:return_waiting' };
  for (const phone of targets) {
    try {
      await sendPushToPhone(phone, buildPushPayload({ title, body, data }), {
        showSystemBanner: true,
        immediate: true,
      });
    } catch (e) {
      console.error('taxi push notifyReturnWaiting error:', e?.message || e);
    }
  }
}

async function notifyReturnOnWay(customerPhone, driverPhone) {
  const payload = buildPushPayload({
    title: 'في طريق العودة',
    body: 'السائق في طريق العودة إلى نقطة الانطلاق',
    data: { eventKey: 'taxi:return_on_way' },
  });
  const targets = [customerPhone, driverPhone].filter(Boolean);
  for (const phone of targets) {
    try {
      await sendPushToPhone(phone, payload, {
        showSystemBanner: true,
        immediate: true,
      });
    } catch (e) {
      console.error('taxi push notifyReturnOnWay error:', e?.message || e);
    }
  }
}

async function notifyReturnArrived(customerPhone, driverPhone) {
  const payload = buildPushPayload({
    title: 'وصل السائق',
    body: 'وصل السائق إلى نقطة الانطلاق للعودة',
    data: { eventKey: 'taxi:return_arrived' },
  });
  const targets = [customerPhone, driverPhone].filter(Boolean);
  for (const phone of targets) {
    try {
      await sendPushToPhone(phone, payload, {
        showSystemBanner: true,
        immediate: true,
      });
    } catch (e) {
      console.error('taxi push notifyReturnArrived error:', e?.message || e);
    }
  }
}

async function notifyDriverLate(customerPhone, minutesLate) {
  if (!customerPhone) return;
  const payload = buildPushPayload({
    title: 'تأخر السائق',
    body: `نعتذر عن التأخير — السائق متأخر نحو ${minutesLate} دقيقة`,
    data: { eventKey: 'taxi:driver_late' },
  });
  await sendPushToPhone(customerPhone, payload, {
    showSystemBanner: true,
    immediate: true,
  });
}

/**
 * إشعار الزبون أن السائق أعاد الطلب / حوّل الرحلة لكابتن آخر.
 */
async function notifyTripTransferredToPool(customerPhone, requestId) {
  if (!customerPhone) return;
  const id = String(requestId || '').trim();
  const payload = buildPushPayload({
    title: 'تم تحويل الرحلة لكابتن آخر',
    body: 'تم تحويل رحلتك إلى كابتن آخر — نبحث عن أقرب سائق متاح الآن',
    data: {
      eventKey: 'taxi:trip_transferred',
      orderId: id,
      requestId: id,
    },
  });
  await sendPushToPhone(customerPhone, payload, { showSystemBanner: true, immediate: true });
}

module.exports = {
  notifyNewTaxiRequest,
  notifySingleDriver,
  notifyDriverAdminAssigned,
  notifyAdminReassignedCaptain,
  notifyDriverAccepted,
  notifyDriverOnWay,
  notifyDriverArrived,
  notifyTripStarted,
  notifyTripCompleted,
  notifyDriverRejected,
  notifyCancelRequested,
  notifyCancellationApproved,
  notifyCancellationRejected,
  notifyTripCancelled,
  notifyDriversRequestCancelled,
  notifyDriverApproaching,
  notifyDriverLate,
  notifyTripTransferredToPool,
  notifyReturnWaiting,
  notifyReturnOnWay,
  notifyReturnArrived,
  notifyDriverRated,
};
