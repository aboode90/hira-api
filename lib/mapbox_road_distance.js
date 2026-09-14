/**
 * مسافة طريق عبر Mapbox Directions (بدون هندسة المسار).
 * للاستخدام في إشعارات الكابتن وغيرها حيث نحتاج الرقم فقط.
 */

const mapboxAccessToken = String(process.env.MAPBOX_ACCESS_TOKEN || '').trim();

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @returns {Promise<number|null>} مسافة الطريق بالكيلومتر، أو null عند الفشل.
 */
async function roadDistanceKm(origin, destination, { timeoutMs = 2500 } = {}) {
  const oLat = Number(origin?.lat ?? origin?.latitude);
  const oLng = Number(origin?.lng ?? origin?.longitude);
  const dLat = Number(destination?.lat ?? destination?.latitude);
  const dLng = Number(destination?.lng ?? destination?.longitude);
  if (!(oLat && oLng && dLat && dLng)) return null;
  if (!mapboxAccessToken) return null;

  const coordinates = `${oLng},${oLat};${dLng},${dLat}`;
  const params = new URLSearchParams({
    alternatives: 'false',
    overview: 'false',
    language: 'ar',
    continue_straight: 'false',
    access_token: mapboxAccessToken,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?${params}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const meters = Number(payload?.routes?.[0]?.distance);
    if (!Number.isFinite(meters) || meters <= 0) return null;
    return meters / 1000;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** نص عربي لمسافة الطريق بين الكابتن ونقطة الانطلاق. */
function formatDriverAwayRoadAr(km) {
  const value = Number(km);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 0.05) return 'الزبون بجانبك تقريباً';
  if (value < 1) {
    const meters = Math.max(50, Math.round(value * 1000));
    return `يبعد عنك ${meters} م (طريق)`;
  }
  const label =
    value < 10 ? `${value.toFixed(1)} كم` : `${Math.round(value)} كم`;
  return `يبعد عنك ${label} (طريق)`;
}

module.exports = {
  haversineKm,
  roadDistanceKm,
  formatDriverAwayRoadAr,
};
