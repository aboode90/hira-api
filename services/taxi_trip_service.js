/**
 * Taxi trip runtime — ETA, موقع الرحلة، إشعارات القرب/التأخر، انتهاء المهلة.
 */

const { nowIso } = require('../supabase_repo/common');

const PENDING_AUTO_CANCEL_MS = 300 * 1000;
const APPROACHING_KM = 0.1; // 100 متر
/** أقل مسافة مسموحة بين الانطلاق والوصول (100 متر). */
const MIN_TRIP_DISTANCE_KM = 0.1;
const LATE_ETA_FACTOR = 1.6;
const AVG_SPEED_KMH = 28;

/** يمنع إرسال نفس إشعار القرب/التأخر أكثر من مرة أثناء تحديثات موقع متزامنة. */
const notifyClaimLocks = new Set();

function claimTripNotify(key) {
  if (!key) return true;
  if (notifyClaimLocks.has(key)) return false;
  notifyClaimLocks.add(key);
  if (notifyClaimLocks.size > 4000) {
    notifyClaimLocks.clear();
    notifyClaimLocks.add(key);
  }
  return true;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateDrivingSeconds(distanceKm, avgKmh = AVG_SPEED_KMH) {
  const km = Number(distanceKm) || 0;
  if (km <= 0) return 60;
  return Math.max(60, Math.round((km / avgKmh) * 3600));
}

function computeLiveEta(driverLat, driverLng, targetLat, targetLng) {
  const lat1 = Number(driverLat);
  const lng1 = Number(driverLng);
  const lat2 = Number(targetLat);
  const lng2 = Number(targetLng);
  if (!lat1 || !lng1 || !lat2 || !lng2) {
    return { distanceKm: null, etaSeconds: null };
  }
  const distanceKm = Math.round(haversineDistance(lat1, lng1, lat2, lng2) * 100) / 100;
  return {
    distanceKm,
    etaSeconds: estimateDrivingSeconds(distanceKm),
  };
}

function sumWaypointDistanceKm(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const lat1 = Number(a?.lat ?? a?.latitude ?? 0);
    const lng1 = Number(a?.lng ?? a?.longitude ?? 0);
    const lat2 = Number(b?.lat ?? b?.latitude ?? 0);
    const lng2 = Number(b?.lng ?? b?.longitude ?? 0);
    if (!lat1 || !lng1 || !lat2 || !lng2) continue;
    total += haversineDistance(lat1, lng1, lat2, lng2);
  }
  return Math.round(total * 100) / 100;
}

function buildRoutePointsFromRequest(payload = {}) {
  const points = [];
  const push = (address, lat, lng) => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!la || !ln) return;
    points.push({
      address: String(address || '').trim(),
      lat: la,
      lng: ln,
    });
  };

  push(payload.pickupAddress, payload.pickupLat, payload.pickupLng);

  const waypoints = Array.isArray(payload.waypoints) ? payload.waypoints : [];
  for (const wp of waypoints) {
    push(wp.address ?? wp.addressAr, wp.lat ?? wp.latitude, wp.lng ?? wp.longitude);
  }

  push(payload.dropoffAddress, payload.dropoffLat, payload.dropoffLng);
  return points;
}

function attachLiveEtaToClientRequest(base) {
  if (!base) return base;
  const status = String(base.statusKey || '').trim();
  const driverLat = Number(base.driverLat ?? 0);
  const driverLng = Number(base.driverLng ?? 0);
  if (!driverLat || !driverLng) {
    base.liveEtaSeconds = null;
    base.liveEtaDistanceKm = null;
    return base;
  }

  let targetLat = 0;
  let targetLng = 0;
  if (status === 'picked_up') {
    targetLat = Number(base.dropoffLat ?? 0);
    targetLng = Number(base.dropoffLng ?? 0);
  } else if (['accepted', 'on_way'].includes(status)) {
    targetLat = Number(base.pickupLat ?? 0);
    targetLng = Number(base.pickupLng ?? 0);
  } else {
    base.liveEtaSeconds = null;
    base.liveEtaDistanceKm = null;
    return base;
  }

  const live = computeLiveEta(driverLat, driverLng, targetLat, targetLng);
  base.liveEtaSeconds = live.etaSeconds;
  base.liveEtaDistanceKm = live.distanceKm;
  return base;
}

async function maybeNotifyProximityAndDelay(row, meta, nextPayload) {
  const push = require('../push/taxi_push_events');
  const status = String(meta.statusKey || '').trim();
  if (!['accepted', 'on_way'].includes(status)) return nextPayload;

  const requestId = String(row?.id || meta?.id || meta?.payload?.id || '').trim();
  const driverLat = Number(nextPayload.driverLat ?? 0);
  const driverLng = Number(nextPayload.driverLng ?? 0);
  const pickupLat = Number(meta.pickupLat ?? 0);
  const pickupLng = Number(meta.pickupLng ?? 0);
  if (!driverLat || !driverLng || !pickupLat || !pickupLng) return nextPayload;

  const distanceKm = haversineDistance(driverLat, driverLng, pickupLat, pickupLng);
  const acceptedAt = meta.payload.acceptedAt || meta.row?.accepted_at;
  const acceptedMs = acceptedAt ? Date.parse(acceptedAt) : NaN;
  const initialEta = Number(meta.payload.initialPickupEtaSeconds ?? 0);
  const elapsedSec = Number.isFinite(acceptedMs)
    ? Math.max(0, Math.round((Date.now() - acceptedMs) / 1000))
    : 0;

  const approachingAlready =
    Boolean(meta.payload.driverApproachingNotified) ||
    Boolean(nextPayload.driverApproachingNotified);
  if (distanceKm <= APPROACHING_KM && !approachingAlready) {
    const claimKey = requestId ? `approach:${requestId}` : '';
    if (claimTripNotify(claimKey)) {
      nextPayload.driverApproachingNotified = true;
      nextPayload.driverApproachingNotifiedAt = nowIso();
      try {
        await push.notifyDriverApproaching(
          meta.customerPhone,
          Math.round(distanceKm * 1000)
        );
      } catch (error) {
        console.error(
          'taxi approaching push error:',
          error?.message || error
        );
      }
    } else {
      nextPayload.driverApproachingNotified = true;
      if (!nextPayload.driverApproachingNotifiedAt) {
        nextPayload.driverApproachingNotifiedAt = nowIso();
      }
    }
  }

  const expectedEta = initialEta > 0
    ? initialEta
    : estimateDrivingSeconds(
        haversineDistance(
          Number(meta.payload.driverLatAtAccept ?? driverLat),
          Number(meta.payload.driverLngAtAccept ?? driverLng),
          pickupLat,
          pickupLng
        )
      );

  const lateAlready =
    Boolean(meta.payload.driverLateNotified) ||
    Boolean(nextPayload.driverLateNotified);
  if (
    expectedEta > 0 &&
    elapsedSec > Math.round(expectedEta * LATE_ETA_FACTOR) &&
    !lateAlready
  ) {
    const claimKey = requestId ? `late:${requestId}` : '';
    if (claimTripNotify(claimKey)) {
      // ثبّت العلم قبل الإرسال حتى لا يُعاد مع تحديثات الموقع المتزامنة.
      nextPayload.driverLateNotified = true;
      nextPayload.driverLateNotifiedAt = nowIso();
      try {
        await push.notifyDriverLate(
          meta.customerPhone,
          Math.max(1, Math.round(elapsedSec / 60))
        );
      } catch (error) {
        console.error('taxi driver-late push error:', error?.message || error);
      }
    } else {
      nextPayload.driverLateNotified = true;
      if (!nextPayload.driverLateNotifiedAt) {
        nextPayload.driverLateNotifiedAt = nowIso();
      }
    }
  }

  return nextPayload;
}

module.exports = {
  PENDING_AUTO_CANCEL_MS,
  MIN_TRIP_DISTANCE_KM,
  haversineDistance,
  estimateDrivingSeconds,
  computeLiveEta,
  sumWaypointDistanceKm,
  buildRoutePointsFromRequest,
  attachLiveEtaToClientRequest,
  maybeNotifyProximityAndDelay,
};
