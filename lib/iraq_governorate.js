/**
 * استخراج محافظة العراق من عنوان أو إحداثيات — لتمييز أجرة المدينة عن أجرة المحافظات.
 */

const GOVERNORATE_ALIASES = [
  ['بغداد', ['بغداد', 'baghdad']],
  ['البصرة', ['البصرة', 'البصره', 'basra', 'basrah']],
  ['نينوى', ['نينوى', 'nineveh', 'ninawa']],
  ['أربيل', ['أربيل', 'اربيل', 'هولير', 'erbil', 'hawler']],
  ['السليمانية', ['السليمانية', 'السليمانيه', 'sulaymaniyah', 'slemani']],
  ['دهوك', ['دهوك', 'duhok', 'dahuk']],
  ['كركوك', ['كركوك', 'kirkuk']],
  ['ديالى', ['ديالى', 'ديالي', 'diyala']],
  ['صلاح الدين', ['صلاح الدين', 'صلاح الدين', 'saladin', 'salah al din']],
  ['الأنبار', ['الأنبار', 'الانبار', 'anbar', 'al anbar']],
  ['بابل', ['بابل', 'babil', 'babylon']],
  ['كربلاء', ['كربلاء', 'كربلاء المقدسة', 'karbala']],
  ['النجف', ['النجف', 'النجف الأشرف', 'najaf']],
  ['واسط', ['واسط', 'wasit']],
  ['ذي قار', ['ذي قار', 'ذي قار', 'dhi qar', 'dhiqar']],
  ['ميسان', ['ميسان', 'maysan', 'misan']],
  ['المثنى', ['المثنى', 'muthanna']],
];

const CITY_TO_GOVERNORATE = [
  { gov: 'واسط', names: ['الصويرة', 'الصويره', 'الكوت', 'النعمانية', 'الحي', 'العزيزية', 'بدرة'] },
  { gov: 'كربلاء', names: ['كربلاء', 'الهندية'] },
  { gov: 'بابل', names: ['الحلة', 'حلة', 'المحاويل', 'المسيب', 'الهاشمية'] },
  { gov: 'النجف', names: ['النجف', 'الكوفة', 'المناذرة'] },
  { gov: 'بغداد', names: ['بغداد', 'الكاظمية', 'الأعظمية', 'الكرخ', 'الرصافة'] },
  { gov: 'البصرة', names: ['البصرة'] },
  { gov: 'نينوى', names: ['الموصل'] },
  { gov: 'أربيل', names: ['أربيل', 'اربيل'] },
  { gov: 'السليمانية', names: ['السليمانية'] },
  { gov: 'دهوك', names: ['دهوك'] },
  { gov: 'كركوك', names: ['كركوك'] },
  { gov: 'ديالى', names: ['بعقوبة'] },
  { gov: 'صلاح الدين', names: ['تكريت', 'سامراء'] },
  { gov: 'الأنبار', names: ['الرمادي', 'الفلوجة'] },
  { gov: 'ذي قار', names: ['الناصرية'] },
  { gov: 'ميسان', names: ['العمارة'] },
  { gov: 'المثنى', names: ['السماوة'] },
  { gov: 'القادسية', names: ['الديوانية'] },
];

const CITY_COORDS = [
  { gov: 'واسط', lat: 32.9256, lng: 44.7766, r: 20 }, // الصويرة
  { gov: 'واسط', lat: 32.5055, lng: 45.819, r: 22 }, // الكوت
  { gov: 'واسط', lat: 32.548, lng: 45.408, r: 12 }, // النعمانية
  { gov: 'واسط', lat: 32.174, lng: 46.048, r: 12 }, // الحي
  { gov: 'واسط', lat: 32.91, lng: 44.53, r: 12 }, // العزيزية
  { gov: 'كربلاء', lat: 32.616, lng: 44.025, r: 20 },
  { gov: 'كربلاء', lat: 32.543, lng: 44.219, r: 10 }, // الهندية
  { gov: 'بابل', lat: 32.479, lng: 44.433, r: 18 }, // الحلة
  { gov: 'بابل', lat: 32.649, lng: 44.653, r: 12 }, // المحاويل
  { gov: 'بابل', lat: 32.503, lng: 44.347, r: 10 }, // المسيب
  { gov: 'النجف', lat: 32.025, lng: 44.336, r: 18 },
  { gov: 'النجف', lat: 32.03, lng: 44.4, r: 10 }, // الكوفة
  { gov: 'بغداد', lat: 33.315, lng: 44.366, r: 32 },
  { gov: 'البصرة', lat: 30.508, lng: 47.78, r: 22 },
  { gov: 'نينوى', lat: 36.335, lng: 43.118, r: 22 },
  { gov: 'أربيل', lat: 36.191, lng: 44.009, r: 18 },
  { gov: 'السليمانية', lat: 35.561, lng: 45.431, r: 18 },
  { gov: 'دهوك', lat: 36.867, lng: 43.008, r: 16 },
  { gov: 'كركوك', lat: 35.468, lng: 44.392, r: 16 },
  { gov: 'ديالى', lat: 33.746, lng: 44.644, r: 16 },
  { gov: 'صلاح الدين', lat: 34.596, lng: 43.678, r: 16 },
  { gov: 'صلاح الدين', lat: 34.198, lng: 43.873, r: 12 },
  { gov: 'الأنبار', lat: 33.426, lng: 43.3, r: 16 },
  { gov: 'الأنبار', lat: 33.35, lng: 43.786, r: 12 },
  { gov: 'ذي قار', lat: 31.058, lng: 46.257, r: 16 },
  { gov: 'ميسان', lat: 31.838, lng: 47.151, r: 16 },
  { gov: 'المثنى', lat: 31.309, lng: 45.28, r: 14 },
  { gov: 'القادسية', lat: 31.989, lng: 44.925, r: 14 },
];

function _normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u0640]/g, '')
    .trim();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function extractGovernorateFromText(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  // "باب بغداد" في كربلاء ليس محافظة بغداد.
  const normalized = _normalizeText(raw).replace(/باب\s*بغداد/g, ' ');

  const prefixed = raw.match(/محافظة\s+([^\s،,]+(?:\s+[^\s،,]+)?)/);
  if (prefixed) {
    const fromPrefix = extractGovernorateFromText(prefixed[1]);
    if (fromPrefix) return fromPrefix;
  }

  for (const row of CITY_TO_GOVERNORATE) {
    for (const name of row.names) {
      if (normalized.includes(_normalizeText(name))) return row.gov;
    }
  }

  for (const [canonical, aliases] of GOVERNORATE_ALIASES) {
    for (const alias of aliases) {
      if (normalized.includes(_normalizeText(alias))) return canonical;
    }
  }
  return '';
}

function extractGovernorateFromCoords(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  let best = '';
  let bestKm = Number.POSITIVE_INFINITY;
  for (const city of CITY_COORDS) {
    const km = haversineKm(latitude, longitude, city.lat, city.lng);
    if (km <= city.r && km < bestKm) {
      bestKm = km;
      best = city.gov;
    }
  }
  return best;
}

function resolveGovernorate({ address = '', lat, lng } = {}) {
  return extractGovernorateFromText(address) || extractGovernorateFromCoords(lat, lng) || '';
}

function shouldUseInterGovernorateRate({
  oneWayDistanceKm,
  pickupAddress = '',
  dropoffAddress = '',
  pickupLat,
  pickupLng,
  dropoffLat,
  dropoffLng,
  minKm = 50,
} = {}) {
  const distance = Number(oneWayDistanceKm);
  const threshold = Number(minKm);
  if (!Number.isFinite(distance) || !Number.isFinite(threshold) || distance <= threshold) {
    return false;
  }

  const pickup = resolveGovernorate({
    address: pickupAddress,
    lat: pickupLat,
    lng: pickupLng,
  });
  const dropoff = resolveGovernorate({
    address: dropoffAddress,
    lat: dropoffLat,
    lng: dropoffLng,
  });

  if (pickup && dropoff && pickup === dropoff) return false;
  if (pickup && dropoff && pickup !== dropoff) return true;
  return true;
}

module.exports = {
  extractGovernorateFromText,
  extractGovernorateFromCoords,
  resolveGovernorate,
  shouldUseInterGovernorateRate,
  haversineKm,
};
