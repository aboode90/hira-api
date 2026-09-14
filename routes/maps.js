const express = require('express');
const router = express.Router();
const { trimRouteNearEndpoints } = require('../lib/route_destination_trim');

// ── Config ──────────────────────────────────────────────────────────────
const mapboxAccessToken = String(process.env.MAPBOX_ACCESS_TOKEN || '').trim();
const mapboxPublicToken = String(process.env.MAPBOX_PUBLIC_TOKEN || '').trim();

function resolvePublicMapboxToken() {
  if (mapboxPublicToken.startsWith('pk.')) return mapboxPublicToken;
  if (mapboxAccessToken.startsWith('pk.')) return mapboxAccessToken;
  return '';
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function geocodeAddressWithMapbox(addressText) {
  const address = String(addressText || '').trim();
  const query = encodeURIComponent(address);
  const params = new URLSearchParams({
    language: 'ar',
    country: 'iq',
    limit: '1',
    access_token: mapboxAccessToken,
  });
  const response = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?${params.toString()}`
  );
  if (!response.ok) {
    throw new Error(`Mapbox geocoding failed with status ${response.status}`);
  }
  const payload = await response.json();
  const feature = Array.isArray(payload?.features) ? payload.features[0] : null;
  const center = Array.isArray(feature?.center) ? feature.center : null;
  if (!center || center.length < 2) {
    throw new Error('Could not geocode one of the addresses.');
  }
  const longitude = Number(center[0]);
  const latitude = Number(center[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Invalid coordinates from geocoding result.');
  }
  return { latitude, longitude };
}

const POI_MAX_DISTANCE_METERS = 120;

async function mapboxGeocode(path, params) {
  const search = new URLSearchParams({
    language: 'ar',
    access_token: mapboxAccessToken,
    ...params,
  });
  const response = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${path}.json?${search.toString()}`
  );
  if (!response.ok) {
    throw new Error(`Mapbox geocoding failed with status ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.features) ? payload.features : [];
}

function featureContextName(feature, prefixes) {
  const context = Array.isArray(feature?.context) ? feature.context : [];
  for (const prefix of prefixes) {
    const match = context.find((entry) =>
      String(entry?.id || '').startsWith(`${prefix}.`)
    );
    if (match?.text) return String(match.text).trim();
  }
  return '';
}

function buildFeatureLabel(feature) {
  const name = String(feature?.text || '').trim();
  const area = featureContextName(feature, [
    'neighborhood',
    'locality',
    'place',
  ]);
  if (!name) return String(feature?.place_name || '').trim();
  if (area && area !== name) return `${name}، ${area}`;
  return name;
}

function haversineDistanceMeters(origin, destination) {
  const earthRadiusMeters = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(destination.latitude);
  const deltaLat = toRadians(destination.latitude - origin.latitude);
  const deltaLng = toRadians(destination.longitude - origin.longitude);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeRouteProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  if (profile === 'walking' || profile === 'pedestrian') return 'walking';
  if (profile === 'cycling' || profile === 'bike' || profile === 'bicycle') {
    return 'cycling';
  }
  if (profile === 'delivery' || profile === 'courier' || profile === 'motorbike') {
    return 'delivery';
  }
  return 'driving';
}

async function computeDrivingRoute(origin, destination) {
  const coordinates =
    `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  const params = new URLSearchParams({
    alternatives: 'true',
    overview: 'full',
    geometries: 'geojson',
    language: 'ar',
    access_token: mapboxAccessToken,
    continue_straight: 'false',
    // unrestricted على الطرفين يمنع فرض وصول من جهة الرصيف (استدارة طويلة).
    approaches: 'unrestricted;unrestricted',
  });
  const response = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?${params.toString()}`
  );

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `Mapbox directions failed with status ${response.status}`);
  }

  const payload = await response.json();
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  if (routes.length === 0) {
    throw new Error('No route geometry available between the selected points.');
  }

  // تحويل كل المسارات (الرئيسية + البدائل) إلى نقاط موحدة
  const mapped = routes.map((route) => {
    const geometry = route?.geometry;
    const routeCoordinates = Array.isArray(geometry?.coordinates)
      ? geometry.coordinates
      : [];
    const points = routeCoordinates.map((entry) => ({
      latitude: Number(entry[1]),
      longitude: Number(entry[0]),
    }));
    const rawDistance = Number(route.distance) || 0;
    const rawDuration = Math.round(Number(route.duration) || 0);
    const trimmed = trimRouteNearEndpoints(points, origin, destination, {
      distanceMeters: rawDistance,
      durationSeconds: rawDuration,
    });
    return {
      points: trimmed.points,
      distanceMeters: trimmed.distanceMeters,
      durationSeconds: trimmed.durationSeconds ?? rawDuration,
      trimmedNearDestination: trimmed.trimmed,
    };
  });

  // ترتيب من الأقصر إلى الأطول
  mapped.sort(
    (a, b) => (Number(a.distanceMeters) || Infinity) - (Number(b.distanceMeters) || Infinity)
  );

  return mapped;
}

async function computeRoadDistanceMeters(origin, destination, profile = 'driving') {
  const coordinates =
    `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  const params = new URLSearchParams({
    alternatives: 'false',
    overview: 'false',
    language: 'ar',
    access_token: mapboxAccessToken,
  });
  if (profile === 'driving') {
    params.set('continue_straight', 'false');
  }
  const response = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordinates}?${params.toString()}`
  );

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `Mapbox directions failed with status ${response.status}`);
  }

  const payload = await response.json();
  const route = Array.isArray(payload?.routes) ? payload.routes[0] : null;
  if (!route || typeof route.distance !== 'number') {
    throw new Error('No routes available between the selected points.');
  }
  return {
    distanceMeters: route.distance,
    duration: String(route.duration || ''),
    profile,
  };
}

async function computeDeliveryDistanceMeters(origin, destination) {
  const straightMeters = haversineDistanceMeters(origin, destination);
  const fallbackMeters = straightMeters * 1.18;
  const minimumMeters = straightMeters * 1.05;
  const candidates = [];

  for (const profile of ['cycling', 'walking', 'driving']) {
    try {
      const route = await computeRoadDistanceMeters(origin, destination, profile);
      if (Number.isFinite(route.distanceMeters) && route.distanceMeters > 0) {
        candidates.push(route);
      }
    } catch (error) {
      console.warn(`delivery distance ${profile} failed:`, error?.message || error);
    }
  }

  if (!candidates.length) {
    return {
      distanceMeters: fallbackMeters,
      duration: '',
      profile: 'straight-line-adjusted',
    };
  }

  const nonDrivingCandidates = candidates.filter((route) => route.profile !== 'driving');
  const sourceCandidates = nonDrivingCandidates.length ? nonDrivingCandidates : candidates;
  const shortest = sourceCandidates.reduce((best, route) =>
    route.distanceMeters < best.distanceMeters ? route : best
  );
  const cappedMeters = Math.max(shortest.distanceMeters, minimumMeters);
  const adjustedMeters = nonDrivingCandidates.length
    ? cappedMeters
    : Math.min(cappedMeters, fallbackMeters);

  return {
    distanceMeters: adjustedMeters,
    duration: shortest.duration,
    profile: shortest.profile,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────

router.get('/public-token', (_, res) => {
  const token = resolvePublicMapboxToken();
  if (!token) {
    return res.status(503).json({
      message: 'MAPBOX_PUBLIC_TOKEN is not configured on backend.',
    });
  }
  return res.json({ publicToken: token });
});

router.post('/reverse-geocode', async (req, res) => {
  try {
    if (!mapboxAccessToken) {
      return res.status(503).json({
        message: 'MAPBOX_ACCESS_TOKEN is not configured on backend.',
      });
    }

    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: 'latitude/longitude required.' });
    }

    const coords = `${longitude},${latitude}`;
    const origin = { latitude, longitude };

    const [poiFeatures, addressFeatures] = await Promise.all([
      mapboxGeocode(coords, { types: 'poi', limit: '5' }).catch(() => []),
      mapboxGeocode(coords, { limit: '1' }).catch(() => []),
    ]);

    let bestPoi = null;
    let bestPoiMeters = Number.POSITIVE_INFINITY;
    for (const feature of poiFeatures) {
      const center = Array.isArray(feature?.center) ? feature.center : null;
      if (!center || center.length < 2) continue;
      const meters = haversineDistanceMeters(origin, {
        latitude: Number(center[1]),
        longitude: Number(center[0]),
      });
      if (meters > POI_MAX_DISTANCE_METERS || meters >= bestPoiMeters) continue;
      bestPoiMeters = meters;
      bestPoi = feature;
    }

    const chosen = bestPoi || addressFeatures[0] || null;
    if (!chosen) {
      return res.status(404).json({ message: 'No place found for coordinates.' });
    }

    const center = Array.isArray(chosen.center) ? chosen.center : null;
    return res.json({
      name: buildFeatureLabel(chosen),
      address: String(chosen.place_name || '').trim(),
      isPoi: Boolean(bestPoi),
      latitude: bestPoi && center ? Number(center[1]) : latitude,
      longitude: bestPoi && center ? Number(center[0]) : longitude,
    });
  } catch (error) {
    console.error('reverse-geocode error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to reverse geocode coordinates.',
    });
  }
});

router.post('/place-search', async (req, res) => {
  try {
    if (!mapboxAccessToken) {
      return res.status(503).json({
        message: 'MAPBOX_ACCESS_TOKEN is not configured on backend.',
      });
    }

    const query = String(req.body?.query || '').trim();
    if (query.length < 2) return res.json({ results: [] });

    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const params = {
      country: 'iq',
      limit: '8',
      types: 'poi,address,neighborhood,locality,place',
      autocomplete: 'true',
    };
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      params.proximity = `${longitude},${latitude}`;
    }

    const [features, merchantResults] = await Promise.all([
      mapboxGeocode(encodeURIComponent(query), params).catch(() => []),
      searchRegisteredMerchants(query, latitude, longitude),
    ]);

    const results = features
      .map((feature) => {
        const center = Array.isArray(feature?.center) ? feature.center : null;
        if (!center || center.length < 2) return null;
        return {
          name: String(feature.text || '').trim(),
          address: String(feature.place_name || '').trim(),
          latitude: Number(center[1]),
          longitude: Number(center[0]),
          source: 'maps',
        };
      })
      .filter((entry) => entry && entry.name);

    // المتاجر المسجّلة أولاً (نتائج دقيقة من قاعدة البيانات).
    const merged = [...(merchantResults || []), ...results];
    const seen = new Set();
    const deduped = [];
    for (const entry of merged) {
      const key = String(entry?.name || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }

    return res.json({ results: deduped.slice(0, 12) });
  } catch (error) {
    console.error('place-search error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to search places.',
    });
  }
});

/** بحث في المتاجر المسجّلة (merchant_profiles) حسب الاسم — نتائج دقيقة محلية. */
async function searchRegisteredMerchants(query, fallbackLat, fallbackLng) {
  try {
    const { assertSupabaseAdmin } = require('../supabase_repo/common');
    const supabase = assertSupabaseAdmin();
    const { data, error } = await supabase
      .from('merchant_profiles')
      .select('store_name, address, latitude, longitude')
      .ilike('store_name', `%${query}%`)
      .limit(12);
    if (error) return [];
    const fbLat = Number.isFinite(Number(fallbackLat)) ? Number(fallbackLat) : 32.94;
    const fbLng = Number.isFinite(Number(fallbackLng)) ? Number(fallbackLng) : 44.78;
    return (data || [])
      .filter((m) => m.store_name)
      .map((m) => {
        const lat = Number(m.latitude);
        const lng = Number(m.longitude);
        // المتاجر بلا إحداثيات تُرجع بموقع الزبون كاحتياط (يُعدّل لاحقاً عند الاختيار).
        return {
          name: String(m.store_name).trim(),
          address: String(m.address || '').trim() || 'متجر مسجّل',
          latitude: Number.isFinite(lat) && lat ? lat : fbLat,
          longitude: Number.isFinite(lng) && lng ? lng : fbLng,
          source: 'merchant',
        };
      });
  } catch (_) {
    return [];
  }
}

router.post('/route-distance', async (req, res) => {
  try {
    if (!mapboxAccessToken) {
      return res.status(503).json({
        message: 'MAPBOX_ACCESS_TOKEN is not configured on backend.',
      });
    }

    const pickupAddress = String(req.body?.pickupAddress || '').trim();
    const dropoffAddress = String(req.body?.dropoffAddress || '').trim();
    const pickupLatitude = Number(req.body?.pickupLatitude);
    const pickupLongitude = Number(req.body?.pickupLongitude);
    const dropoffLatitude = Number(req.body?.dropoffLatitude);
    const dropoffLongitude = Number(req.body?.dropoffLongitude);
    const routeProfile = normalizeRouteProfile(req.body?.routeProfile);

    const hasPickupCoords =
      Number.isFinite(pickupLatitude) && Number.isFinite(pickupLongitude);
    const hasDropoffCoords =
      Number.isFinite(dropoffLatitude) && Number.isFinite(dropoffLongitude);

    const origin = hasPickupCoords
      ? { latitude: pickupLatitude, longitude: pickupLongitude }
      : pickupAddress
        ? await geocodeAddressWithMapbox(pickupAddress)
        : null;
    const destination = hasDropoffCoords
      ? { latitude: dropoffLatitude, longitude: dropoffLongitude }
      : dropoffAddress
        ? await geocodeAddressWithMapbox(dropoffAddress)
        : null;

    if (!origin || !destination) {
      return res.status(400).json({
        message:
          'Provide pickup/dropoff coordinates or valid addresses for both points.',
      });
    }

    const route =
      routeProfile === 'delivery'
        ? await computeDeliveryDistanceMeters(origin, destination)
        : routeProfile === 'driving'
          ? await computeDrivingRoute(origin, destination)
          : await computeRoadDistanceMeters(origin, destination, routeProfile);
    return res.json({
      distanceMeters: route.distanceMeters,
      distanceKm: route.distanceMeters / 1000,
      duration:
        routeProfile === 'driving'
          ? String(route.durationSeconds ?? '')
          : route.duration,
      routeProfile: routeProfile === 'driving' ? 'driving' : route.profile,
      trimmedNearDestination: Boolean(route.trimmedNearDestination),
    });
  } catch (error) {
    console.error('route-distance error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to compute route distance.',
    });
  }
});

router.post('/driving-route', async (req, res) => {
  try {
    if (!mapboxAccessToken) {
      return res.status(503).json({
        message: 'MAPBOX_ACCESS_TOKEN is not configured on backend.',
      });
    }

    const pickupAddress = String(req.body?.pickupAddress || '').trim();
    const dropoffAddress = String(req.body?.dropoffAddress || '').trim();
    const pickupLatitude = Number(req.body?.pickupLatitude);
    const pickupLongitude = Number(req.body?.pickupLongitude);
    const dropoffLatitude = Number(req.body?.dropoffLatitude);
    const dropoffLongitude = Number(req.body?.dropoffLongitude);

    const hasPickupCoords =
      Number.isFinite(pickupLatitude) && Number.isFinite(pickupLongitude);
    const hasDropoffCoords =
      Number.isFinite(dropoffLatitude) && Number.isFinite(dropoffLongitude);

    const origin = hasPickupCoords
      ? { latitude: pickupLatitude, longitude: pickupLongitude }
      : pickupAddress
        ? await geocodeAddressWithMapbox(pickupAddress)
        : null;
    const destination = hasDropoffCoords
      ? { latitude: dropoffLatitude, longitude: dropoffLongitude }
      : dropoffAddress
        ? await geocodeAddressWithMapbox(dropoffAddress)
        : null;

    if (!origin || !destination) {
      return res.status(400).json({
        message:
          'Provide pickup/dropoff coordinates or valid addresses for both points.',
      });
    }

    const routes = await computeDrivingRoute(origin, destination);
    const routesPayload = (Array.isArray(routes) ? routes : [routes]).map((route) => ({
      points: route.points,
      distanceMeters: route.distanceMeters,
      distanceKm: (Number(route.distanceMeters) || 0) / 1000,
      durationSeconds: route.durationSeconds,
      trimmedNearDestination: Boolean(route.trimmedNearDestination),
    }));
    return res.json({
      routes: routesPayload,
      // للتوافق القديم: المسار الأقصر
      points: routesPayload[0]?.points || [],
      distanceMeters: routesPayload[0]?.distanceMeters || 0,
      distanceKm: routesPayload[0]?.distanceKm || 0,
      durationSeconds: routesPayload[0]?.durationSeconds || 0,
      trimmedNearDestination: Boolean(routesPayload[0]?.trimmedNearDestination),
    });
  } catch (error) {
    console.error('driving-route error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to compute driving route.',
    });
  }
});

module.exports = router;
