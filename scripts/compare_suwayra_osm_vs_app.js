/**
 * مقارنة أماكن قضاء الصويرة من OpenStreetMap مع المحفوظ في التطبيق.
 *   node -r dotenv/config scripts/compare_suwayra_osm_vs_app.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { listTaxiPlaces } = require('../services/taxi_places_config');

const CENTER = { lat: 32.9256, lng: 44.7766 };
// تقريب يغطي قضاء الصويرة (المدينة + الزبيدية/الشحيمية والأرياف القريبة)
const RADIUS_KM = 20;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

function normalizeName(value) {
  return String(value || '')
    .replace(/[\u200e\u200f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');
}

function buildQuery(radiusKm) {
  const r = Math.round(Math.max(1, radiusKm) * 1000);
  const { lat, lng } = CENTER;
  return `[out:json][timeout:90];
(
  node["amenity"]["name"](around:${r},${lat},${lng});
  way["amenity"]["name"](around:${r},${lat},${lng});
  node["shop"]["name"](around:${r},${lat},${lng});
  way["shop"]["name"](around:${r},${lat},${lng});
  node["tourism"]["name"](around:${r},${lat},${lng});
  way["tourism"]["name"](around:${r},${lat},${lng});
  node["leisure"]["name"](around:${r},${lat},${lng});
  way["leisure"]["name"](around:${r},${lat},${lng});
  node["office"]["name"](around:${r},${lat},${lng});
  way["office"]["name"](around:${r},${lat},${lng});
  node["healthcare"]["name"](around:${r},${lat},${lng});
  node["craft"]["name"](around:${r},${lat},${lng});
  node["highway"="bus_stop"]["name"](around:${r},${lat},${lng});
);
out center tags;`;
}

function extractName(tags = {}) {
  return String(tags['name:ar'] || tags.name || tags.brand || tags.operator || '')
    .replace(/[\u200e\u200f]/g, '')
    .trim();
}

async function fetchOsmPlaces() {
  const query = buildQuery(RADIUS_KM);
  const body = new URLSearchParams({ data: query }).toString();
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AlGhaithCompare/1.0',
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status} @ ${endpoint}`;
        continue;
      }
      const payload = await response.json();
      const elements = Array.isArray(payload.elements) ? payload.elements : [];
      const seen = new Set();
      const results = [];
      for (const el of elements) {
        const name = extractName(el.tags);
        if (!name) continue;
        const key = normalizeName(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const lat = Number(el.lat ?? el.center?.lat);
        const lng = Number(el.lon ?? el.center?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        results.push({ name, latitude: lat, longitude: lng });
      }
      results.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
      return results;
    } catch (error) {
      lastError = error?.message || String(error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || 'Overpass failed');
}

async function main() {
  console.log(
    `استخراج أماكن OSM حول الصويرة (نصف قطر ${RADIUS_KM} كم ≈ قضاء الصويرة)...`
  );
  const [osmPlaces, appList] = await Promise.all([
    fetchOsmPlaces(),
    listTaxiPlaces(),
  ]);

  const appPlaces = (appList.places || []).filter(
    (p) => String(p.serviceAreaId || 'suwayra') === 'suwayra'
  );

  const osmByName = new Map(osmPlaces.map((p) => [normalizeName(p.name), p]));
  const appByName = new Map(appPlaces.map((p) => [normalizeName(p.name), p]));

  const inBoth = [];
  const onlyOsm = [];
  const onlyApp = [];

  for (const [key, place] of osmByName) {
    if (appByName.has(key)) inBoth.push(place.name);
    else onlyOsm.push(place.name);
  }
  for (const [key, place] of appByName) {
    if (!osmByName.has(key)) onlyApp.push(place.name);
  }

  inBoth.sort((a, b) => a.localeCompare(b, 'ar'));
  onlyOsm.sort((a, b) => a.localeCompare(b, 'ar'));
  onlyApp.sort((a, b) => a.localeCompare(b, 'ar'));

  const summary = {
    area: 'قضاء الصويرة — محافظة واسط',
    method: `OpenStreetMap named POIs within ${RADIUS_KM}km of Suwayra center`,
    osmCount: osmPlaces.length,
    appSavedCount: appPlaces.length,
    matchedByName: inBoth.length,
    onlyInOsm: onlyOsm.length,
    onlyInApp: onlyApp.length,
    matchRateApp:
      appPlaces.length > 0
        ? `${((inBoth.length / appPlaces.length) * 100).toFixed(1)}%`
        : 'n/a',
    matchRateOsm:
      osmPlaces.length > 0
        ? `${((inBoth.length / osmPlaces.length) * 100).toFixed(1)}%`
        : 'n/a',
  };

  console.log('\n=== ملخص ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nأمثلة مشتركة (أول 15):');
  console.log(inBoth.slice(0, 15).join('\n') || '(لا شيء)');
  console.log('\nفي OSM وغير محفوظة في التطبيق (أول 20):');
  console.log(onlyOsm.slice(0, 20).join('\n') || '(لا شيء)');
  console.log('\nمحفوظة في التطبيق وغير موجودة بنفس الاسم في OSM (أول 20):');
  console.log(onlyApp.slice(0, 20).join('\n') || '(لا شيء)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
