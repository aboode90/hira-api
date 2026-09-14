/**
 * عند الاقتراب من الوجهة/الانطلاق على الجانب الآخر من الشارع قد يُطيل الموجّه
 * المسار لاستدارة قانونية بعيدة. نقصّ الذيل الطويل ونُنهي عند أقرب نقطة منطقية.
 */

const NEAR_DESTINATION_THRESHOLD_METERS = Number.parseInt(
  process.env.ROUTE_NEAR_DESTINATION_METERS || '450',
  10
);

const MIN_UTURN_SAVINGS_METERS = Number.parseInt(
  process.env.ROUTE_UTURN_MIN_SAVINGS_METERS || '120',
  10
);

/** أقصى طول للوصلة المستقيمة — رُفع ليشمل الشوارع المزدوجة والجزر الوسطية. */
const MAX_STRAIGHT_TAIL_METERS = Number.parseInt(
  process.env.ROUTE_MAX_STRAIGHT_TAIL_METERS || '180',
  10
);

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

function lerpPoint(a, b, t) {
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
}

function distanceAlongPolyline(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineDistanceMeters(points[i - 1], points[i]);
  }
  return total;
}

function findBestCutNearEndpoint(points, endpoint, thresholdMeters) {
  if (!Array.isArray(points) || points.length === 0) return null;

  const end = {
    latitude: Number(endpoint.latitude),
    longitude: Number(endpoint.longitude),
  };

  let accumulatedMeters = 0;
  let best = null;
  let bestCost = Number.POSITIVE_INFINITY;

  const consider = (sample, cutIndex, alongMeters) => {
    const toEnd = haversineDistanceMeters(sample, end);
    if (toEnd > thresholdMeters || toEnd > MAX_STRAIGHT_TAIL_METERS) return;
    const cost = alongMeters + toEnd;
    if (cost >= bestCost) return;
    bestCost = cost;
    best = {
      cutPoint: sample,
      trimmedDistance: alongMeters + toEnd,
      cutIndex,
    };
  };

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    consider(point, i, accumulatedMeters);

    if (i >= points.length - 1) continue;

    const next = points[i + 1];
    const segmentMeters = haversineDistanceMeters(point, next);
    if (segmentMeters <= 0) continue;

    const steps = Math.max(12, Math.ceil(segmentMeters / 8));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const sample = lerpPoint(point, next, t);
      consider(sample, i, accumulatedMeters + segmentMeters * t);
    }

    accumulatedMeters += segmentMeters;
  }

  return best;
}

function trimRouteNearDestination(
  points,
  destination,
  {
    thresholdMeters = NEAR_DESTINATION_THRESHOLD_METERS,
    durationSeconds = null,
    distanceMeters = null,
  } = {}
) {
  const normalizedPoints = Array.isArray(points)
    ? points
        .map((entry) => ({
          latitude: Number(entry.latitude),
          longitude: Number(entry.longitude),
        }))
        .filter(
          (entry) =>
            Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude)
        )
    : [];

  const dest = {
    latitude: Number(destination?.latitude),
    longitude: Number(destination?.longitude),
  };

  const originalDistance =
    Number.isFinite(distanceMeters) && distanceMeters > 0
      ? distanceMeters
      : distanceAlongPolyline(normalizedPoints);
  const originalDuration =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : null;

  if (
    normalizedPoints.length < 2 ||
    !Number.isFinite(dest.latitude) ||
    !Number.isFinite(dest.longitude)
  ) {
    return {
      points: normalizedPoints,
      distanceMeters: originalDistance,
      durationSeconds: originalDuration,
      trimmed: false,
    };
  }

  const cut = findBestCutNearEndpoint(
    normalizedPoints,
    dest,
    thresholdMeters
  );
  if (!cut) {
    return {
      points: normalizedPoints,
      distanceMeters: originalDistance,
      durationSeconds: originalDuration,
      trimmed: false,
    };
  }

  const savings = originalDistance - cut.trimmedDistance;
  if (savings < MIN_UTURN_SAVINGS_METERS) {
    return {
      points: normalizedPoints,
      distanceMeters: originalDistance,
      durationSeconds: originalDuration,
      trimmed: false,
    };
  }

  const head = normalizedPoints.slice(0, cut.cutIndex + 1);
  const lastHead = head[head.length - 1];
  const needCutPoint = haversineDistanceMeters(lastHead, cut.cutPoint) > 1;
  const trimmedPoints = needCutPoint
    ? [...head, cut.cutPoint, dest]
    : [...head, dest];

  let trimmedDuration = originalDuration;
  if (originalDuration != null && originalDistance > 0) {
    const ratio = Math.min(1, cut.trimmedDistance / originalDistance);
    trimmedDuration = Math.max(30, Math.round(originalDuration * ratio));
  }

  return {
    points: trimmedPoints,
    distanceMeters: cut.trimmedDistance,
    durationSeconds: trimmedDuration,
    trimmed: true,
  };
}

function trimRouteNearEndpoints(
  points,
  origin,
  destination,
  options = {}
) {
  const afterDropoff = trimRouteNearDestination(points, destination, options);
  if (!Array.isArray(afterDropoff.points) || afterDropoff.points.length < 2) {
    return afterDropoff;
  }

  const reversed = [...afterDropoff.points].reverse();
  const afterPickup = trimRouteNearDestination(reversed, origin, {
    ...options,
    distanceMeters: afterDropoff.distanceMeters,
    durationSeconds: afterDropoff.durationSeconds,
  });

  return {
    points: [...afterPickup.points].reverse(),
    distanceMeters: afterPickup.distanceMeters,
    durationSeconds: afterPickup.durationSeconds,
    trimmed: Boolean(afterDropoff.trimmed || afterPickup.trimmed),
  };
}

module.exports = {
  NEAR_DESTINATION_THRESHOLD_METERS,
  MIN_UTURN_SAVINGS_METERS,
  MAX_STRAIGHT_TAIL_METERS,
  haversineDistanceMeters,
  trimRouteNearDestination,
  trimRouteNearEndpoints,
};
