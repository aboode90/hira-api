/**
 * Taxi Matching Service
 *
 * يبحث عن سائق بديل بعد رفض السائق الحالي — بدون فلتر مسافة.
 */

const { getNearbyDrivers } = require('../supabase_repo/taxi');

/**
 * البحث عن أول سائق متاح بعد الرفض
 *
 * @param {string} requestId - معرف الطلب
 * @param {number} pickupLat - خط عرض موقع الالتقاط
 * @param {number} pickupLng - خط طول موقع الالتقاط
 * @param {string} taxiType - نوع التكسي
 * @param {string[]} rejectedByDrivers - قائمة السائقين الذين رفضوا
 * @param {string|Date} [createdAt] - وقت إنشاء الطلب (للتوافق — غير مستخدم للمسافة)
 * @returns {Promise<{ driverPhone: string|null, distanceKm: number|null }>}
 */
async function findNextAvailableDriver(
  requestId,
  pickupLat,
  pickupLng,
  taxiType,
  rejectedByDrivers = [],
  createdAt = null,
) {
  const excludeDrivers = rejectedByDrivers.filter(Boolean);

  const drivers = await getNearbyDrivers(
    pickupLat,
    pickupLng,
    taxiType,
    excludeDrivers,
    99999,
  );

  if (Array.isArray(drivers) && drivers.length > 0) {
    const best = drivers[0];
    return {
      driverPhone: best.phone || best.driverPhone,
      distanceKm: best.distanceKm,
    };
  }

  return { driverPhone: null, distanceKm: null };
}

module.exports = { findNextAvailableDriver };
