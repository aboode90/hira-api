const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getNeighborhoods, updateConfig } = require('./app_config_service');
const { resolveGoogleMapsUrl } = require('../lib/maps_url_resolver');

const DEFAULT_SERVICE_AREAS = [
  {
    id: 'suwayra',
    nameAr: 'الصويرة',
    governorateNameAr: 'واسط',
    centerLat: 32.9256,
    centerLng: 44.7766,
    enabled: true,
    isDefault: true,
  },
];

const PLACE_KINDS = new Set(['neighborhood', 'landmark', 'poi']);

function normalizeKind(value) {
  const key = String(value || 'poi').trim().toLowerCase();
  return PLACE_KINDS.has(key) ? key : 'poi';
}

function normalizeServiceAreas(config) {
  const raw = config?.serviceAreas;
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_SERVICE_AREAS;
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = normalizeServiceAreaId(item.id || item.nameAr);
      if (!id) return null;
      return {
        id,
        nameAr: String(item.nameAr || (id === 'suwayra' ? 'الصويرة' : id)).trim(),
        governorateNameAr: String(item.governorateNameAr || 'واسط').trim(),
        centerLat: Number(item.centerLat) || 32.9256,
        centerLng: Number(item.centerLng) || 44.7766,
        enabled: item.enabled !== false,
        isDefault: item.isDefault === true || id === 'suwayra',
      };
    })
    .filter(Boolean);
}

function normalizeNeighborhoodsConfig(config = {}) {
  const serviceAreas = normalizeServiceAreas(config);
  const places = normalizePlaces(config);
  return {
    ...config,
    schemaVersion: Number(config?.schemaVersion) >= 2 ? 2 : 2,
    updatedAt: config?.updatedAt || new Date().toISOString(),
    serviceAreas,
    places,
  };
}

function normalizePlaces(config) {
  const places = config?.places;
  const list = Array.isArray(places) ? places : [];
  return list.map((item) => normalizePlaceEntry(item)).filter(Boolean);
}

function normalizeServiceAreaId(value) {
  const key = String(value || '').trim();
  if (!key) return 'suwayra';
  if (key === 'الصويرة' || key === 'suwayra') return 'suwayra';
  return key;
}

function normalizePlaceEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name || item.titleAr || '').trim();
  if (!name) return null;
  const areaId = normalizeServiceAreaId(
    item.serviceAreaId || item.service_area_id || item.district
  );
  return {
    ...item,
    id: String(item.id || crypto.randomUUID()).trim(),
    name,
    latitude: Number(item.latitude ?? item.lat),
    longitude: Number(item.longitude ?? item.lng),
    serviceAreaId: areaId,
    serviceAreaNameAr:
      String(item.serviceAreaNameAr || item.service_area_name_ar || '').trim() ||
      (areaId === 'suwayra' ? 'الصويرة' : areaId),
    kind: normalizeKind(item.kind),
    quickPick: item.quickPick === true,
    enabled: item.enabled !== false,
    subtitle: item.subtitle ? String(item.subtitle).trim() : null,
    origin: String(item.origin || 'admin').trim() || 'admin',
    mapsUrl: String(item.mapsUrl || '').trim(),
    resolvedUrl: String(item.resolvedUrl || '').trim(),
  };
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMapsUrl(value) {
  return String(value || '').trim().toLowerCase().replace(/\/+$/, '');
}

function findDuplicatePlace(places, { name, mapsUrl }) {
  const normalizedName = normalizeName(name);
  const normalizedUrl = normalizeMapsUrl(mapsUrl);

  for (const item of places) {
    if (normalizeName(item?.name) === normalizedName) {
      return { reason: 'name', place: item };
    }

    const itemUrl = normalizeMapsUrl(item?.mapsUrl);
    if (normalizedUrl && itemUrl && normalizedUrl === itemUrl) {
      return { reason: 'url', place: item };
    }
  }

  return null;
}

function duplicateErrorMessage(duplicate) {
  const existingName = String(duplicate.place?.name || 'مكان موجود').trim();
  if (duplicate.reason === 'name') {
    return `المكان «${existingName}» مسجّل مسبقاً بنفس الاسم.`;
  }
  return `هذا الرابط مسجّل مسبقاً باسم «${existingName}».`;
}

async function listTaxiPlaces() {
  const config = await getNeighborhoods();
  const normalized = normalizeNeighborhoodsConfig(config);
  const needsPersist =
    !config?.schemaVersion ||
    Number(config.schemaVersion) < 2 ||
    !Array.isArray(config?.serviceAreas) ||
    (Array.isArray(config?.places) &&
      config.places.some((item) => item?.kind == null || item?.enabled == null));
  if (needsPersist) {
    await updateConfig('neighborhoods', normalized);
  }
  return {
    places: normalized.places,
    serviceAreas: normalized.serviceAreas,
    schemaVersion: normalized.schemaVersion,
    updatedAt: normalized.updatedAt,
    count: normalized.places.length,
  };
}

async function addTaxiPlaceFromMapsUrl({
  mapsUrl,
  name,
  serviceAreaId = 'suwayra',
} = {}) {
  const resolved = await resolveGoogleMapsUrl(mapsUrl);
  const displayName = String(name || resolved.name || '').trim();
  if (!displayName) {
    throw new Error('تعذر استخراج اسم المكان — أدخل الاسم يدوياً.');
  }

  const config = await getNeighborhoods();
  const places = normalizePlaces(config);
  const duplicate = findDuplicatePlace(places, {
    name: displayName,
    mapsUrl,
  });
  if (duplicate) {
    const error = new Error(duplicateErrorMessage(duplicate));
    error.statusCode = 409;
    throw error;
  }

  const areaId = normalizeServiceAreaId(serviceAreaId);
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    name: displayName,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    mapsUrl: String(mapsUrl || '').trim(),
    resolvedUrl: resolved.resolvedUrl,
    serviceAreaId: areaId,
    serviceAreaNameAr: areaId === 'suwayra' ? 'الصويرة' : areaId,
    kind: 'poi',
    quickPick: false,
    enabled: true,
    subtitle: null,
    origin: 'admin',
    updatedAt: now,
    addedAt: now,
  };

  places.push(entry);
  await updateConfig(
    'neighborhoods',
    normalizeNeighborhoodsConfig({ ...config, places, updatedAt: now })
  );
  return { place: entry, places, updated: false };
}

async function deleteTaxiPlace(id) {
  const targetId = String(id || '').trim();
  if (!targetId) {
    throw new Error('معرّف المكان مطلوب.');
  }

  const config = await getNeighborhoods();
  const places = normalizePlaces(config);
  const next = places.filter((item) => String(item?.id || '') !== targetId);
  if (next.length === places.length) {
    throw new Error('المكان غير موجود.');
  }

  const now = new Date().toISOString();
  await updateConfig(
    'neighborhoods',
    normalizeNeighborhoodsConfig({ ...config, places: next, updatedAt: now })
  );
  return { places: next, count: next.length };
}

async function updateTaxiPlace(id, patch = {}) {
  const targetId = String(id || '').trim();
  if (!targetId) throw new Error('معرّف المكان مطلوب.');

  const config = await getNeighborhoods();
  const places = normalizePlaces(config);
  const index = places.findIndex((item) => String(item?.id || '') === targetId);
  if (index < 0) throw new Error('المكان غير موجود.');

  const current = places[index];
  const areaId = patch.serviceAreaId != null
    ? normalizeServiceAreaId(patch.serviceAreaId)
    : current.serviceAreaId;
  const next = {
    ...current,
    ...(patch.name != null ? { name: String(patch.name).trim() } : {}),
    ...(patch.latitude != null ? { latitude: Number(patch.latitude) } : {}),
    ...(patch.longitude != null ? { longitude: Number(patch.longitude) } : {}),
    ...(patch.kind != null ? { kind: normalizeKind(patch.kind) } : {}),
    ...(patch.quickPick != null ? { quickPick: patch.quickPick === true } : {}),
    ...(patch.enabled != null ? { enabled: patch.enabled !== false } : {}),
    ...(patch.subtitle != null
      ? { subtitle: patch.subtitle ? String(patch.subtitle).trim() : null }
      : {}),
    serviceAreaId: areaId,
    serviceAreaNameAr: areaId === 'suwayra' ? 'الصويرة' : areaId,
    updatedAt: new Date().toISOString(),
  };
  if (!next.name) throw new Error('اسم المكان مطلوب.');
  places[index] = next;

  const now = next.updatedAt;
  await updateConfig(
    'neighborhoods',
    normalizeNeighborhoodsConfig({ ...config, places, updatedAt: now })
  );
  return { place: next, places, count: places.length };
}

async function listServiceAreas() {
  const config = await getNeighborhoods();
  const normalized = normalizeNeighborhoodsConfig(config);
  return {
    serviceAreas: normalized.serviceAreas,
    updatedAt: normalized.updatedAt,
  };
}

async function saveServiceAreas(areas) {
  const list = Array.isArray(areas) ? areas : [];
  if (!list.length) throw new Error('يجب توفير منطقة خدمة واحدة على الأقل.');
  const config = await getNeighborhoods();
  const now = new Date().toISOString();
  const next = normalizeNeighborhoodsConfig({
    ...config,
    serviceAreas: list,
    updatedAt: now,
  });
  await updateConfig('neighborhoods', next);
  return { serviceAreas: next.serviceAreas, updatedAt: now };
}

// ── استخراج أماكن من منطقة عبر OpenStreetMap (Overpass API) ──

const OSM_CATEGORIES = {
  all: { regex: '^(amenity|shop|tourism|leisure|office)$', label: 'الكل' },
  education: { regex: '^(school|university|college|kindergarten|library)$', label: 'مدارس وجامعات' },
  health: { regex: '^(hospital|clinic|doctors|pharmacy|dentist)$', label: 'مستشفيات وعيادات' },
  religious: { regex: '^(place_of_worship|mosque)$', label: 'مساجد وأماكن دينية' },
  food: { regex: '^(restaurant|cafe|fast_food|bar)$', label: 'مطاعم ومقاهٍ' },
  shops: { regex: '^shops$', label: 'محلات وأسواق' },
  fuel: { regex: '^(fuel|charging_station)$', label: 'محطات وقود' },
  services: { regex: '^(police|fire_station|townhall|post_office|bank|atm)$', label: 'خدمات حكومية وبنوك' },
};

function buildOverpassQuery({ latitude, longitude, radiusKm, types }) {
  const radiusMeters = Math.max(200, Math.min(Number(radiusKm) || 5, 30) * 1000);
  const cats = Array.isArray(types) && types.length ? types : ['all'];
  const regexes = new Set();
  for (const cat of cats) {
    const entry = OSM_CATEGORIES[cat];
    if (entry) regexes.add(entry.regex);
  }
  const regex = [...regexes].join('|');

  // استعلام جامع: node + way لكل مجموعة tags ضمن دائرة.
  const blocks = [];
  if (regexes.has('^shops$')) {
    blocks.push(`node["shop"](around:${radiusMeters},${latitude},${longitude});`);
    blocks.push(`way["shop"](around:${radiusMeters},${latitude},${longitude});`);
  }
  const mainRegex = [...regexes].filter((r) => r !== '^shops$').join('|');
  if (mainRegex) {
    blocks.push(`node["amenity"~"${mainRegex}"](around:${radiusMeters},${latitude},${longitude});`);
    blocks.push(`way["amenity"~"${mainRegex}"](around:${radiusMeters},${latitude},${longitude});`);
    blocks.push(`node["tourism"~"${mainRegex}"](around:${radiusMeters},${latitude},${longitude});`);
    blocks.push(`node["leisure"~"${mainRegex}"](around:${radiusMeters},${latitude},${longitude});`);
  }
  return `[out:json][timeout:30];(${blocks.join('')});out center tags;`;
}

function extractName(tags) {
  const raw =
    tags?.name ||
    tags?.['name:ar'] ||
    tags?.brand ||
    tags?.operator ||
    '';
  const clean = String(raw || '').replace(/[\u200e\u200f]/g, '').trim();
  return clean;
}

function categoryOf(tags) {
  if (tags?.shop) return 'محل';
  if (tags?.amenity === 'school' || tags?.amenity === 'university' || tags?.amenity === 'college') return 'مدرسة/جامعة';
  if (tags?.amenity === 'hospital' || tags?.amenity === 'clinic' || tags?.amenity === 'doctors') return 'صحة';
  if (tags?.amenity === 'pharmacy') return 'صيدلية';
  if (tags?.amenity === 'mosque' || tags?.amenity === 'place_of_worship') return 'مسجد';
  if (tags?.amenity === 'restaurant' || tags?.amenity === 'fast_food') return 'مطعم';
  if (tags?.amenity === 'cafe') return 'مقهى';
  if (tags?.amenity === 'fuel') return 'محطة وقود';
  if (tags?.amenity === 'police') return 'شرطة';
  return 'أخرى';
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

async function extractPlacesAround({ latitude, longitude, radiusKm, types }) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('إحداثيات المركز مطلوبة.');
  }
  const query = buildOverpassQuery({ latitude: lat, longitude: lng, radiusKm, types });
  const body = new URLSearchParams({ data: query }).toString();

  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AlGhaithAdmin/1.0 (taxi places extraction)',
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `فشل الاتصال بمصدر الخرائط (${response.status}).`;
        continue;
      }
      const payload = await response.json();
      const elements = Array.isArray(payload.elements) ? payload.elements : [];

      const seen = new Set();
      const results = [];
      for (const el of elements) {
        const name = extractName(el?.tags);
        if (!name) continue;
        const latEl = Number(el?.lat ?? el?.center?.lat);
        const lngEl = Number(el?.lon ?? el?.center?.lon);
        if (!Number.isFinite(latEl) || !Number.isFinite(lngEl)) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          name,
          latitude: Number(latEl.toFixed(6)),
          longitude: Number(lngEl.toFixed(6)),
          category: categoryOf(el?.tags),
        });
      }
      results.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
      return results;
    } catch (error) {
      lastError = error?.message || String(error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || 'تعذر الاتصال بمصدر الخرائط.');
}

async function addTaxiPlacesBatch(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const config = await getNeighborhoods();
  const places = normalizePlaces(config);
  const existingNames = new Set(places.map((p) => normalizeName(p.name)));
  const now = new Date().toISOString();
  const added = [];
  const skipped = [];
  for (const entry of list) {
    const name = String(entry?.name || '').trim();
    const lat = Number(entry?.latitude);
    const lng = Number(entry?.longitude);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push({ name, reason: 'invalid' });
      continue;
    }
    if (existingNames.has(normalizeName(name))) {
      skipped.push({ name, reason: 'duplicate' });
      continue;
    }
    const areaId = normalizeServiceAreaId(
      entry?.serviceAreaId || entry?.service_area_id || 'suwayra'
    );
    const item = {
      id: crypto.randomUUID(),
      name,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
      mapsUrl: '',
      resolvedUrl: '',
      serviceAreaId: areaId,
      serviceAreaNameAr: areaId === 'suwayra' ? 'الصويرة' : areaId,
      kind: normalizeKind(entry?.kind),
      quickPick: entry?.quickPick === true,
      enabled: entry?.enabled !== false,
      subtitle: entry?.subtitle ? String(entry.subtitle).trim() : null,
      origin: String(entry?.origin || 'admin').trim() || 'admin',
      updatedAt: now,
      addedAt: now,
    };
    places.push(item);
    existingNames.add(normalizeName(name));
    added.push(item);
  }
  await updateConfig(
    'neighborhoods',
    normalizeNeighborhoodsConfig({ ...config, places, updatedAt: now })
  );
  return { added, skipped, count: places.length };
}

function loadSeedCatalog() {
  const filePath = path.resolve(__dirname, '../../assets/config/taxi_catalog.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function seedTaxiCatalogFromAsset({ dryRun = false, allowFar = false } = {}) {
  const seed = loadSeedCatalog();
  const config = await getNeighborhoods();
  const existing = normalizePlaces(config);
  const byName = new Map(existing.map((p) => [normalizeName(p.name), p]));
  const actions = [];
  const now = new Date().toISOString();

  for (const seedPlace of seed.places || []) {
    const name = String(seedPlace.name || '').trim();
    if (!name) continue;
    const area = (seed.serviceAreas || DEFAULT_SERVICE_AREAS).find(
      (a) => a.id === (seedPlace.serviceAreaId || 'suwayra')
    ) || DEFAULT_SERVICE_AREAS[0];
    const dist = haversineKm(
      area.centerLat,
      area.centerLng,
      Number(seedPlace.latitude),
      Number(seedPlace.longitude)
    );
    if (dist > 30 && !allowFar) {
      actions.push({ action: 'SKIP_FAR', name, distKm: dist.toFixed(1) });
      continue;
    }

    const key = normalizeName(name);
    const match = byName.get(key);
    if (match) {
      actions.push({ action: 'MERGE', name });
      if (!dryRun) {
        match.kind = normalizeKind(seedPlace.kind || match.kind);
        if (seedPlace.quickPick) match.quickPick = true;
        if (seedPlace.subtitle && !match.subtitle) match.subtitle = seedPlace.subtitle;
        if (!match.origin || match.origin === 'builtin') {
          // admin coords win — only enrich metadata
        }
      }
      continue;
    }

    actions.push({ action: 'ADD', name });
    if (!dryRun) {
      const entry = normalizePlaceEntry({
        ...seedPlace,
        id: seedPlace.id || crypto.randomUUID(),
        origin: 'builtin',
        addedAt: seedPlace.addedAt || now,
        updatedAt: now,
      });
      existing.push(entry);
      byName.set(key, entry);
    }
  }

  if (!dryRun) {
    const merged = normalizeNeighborhoodsConfig({
      ...config,
      schemaVersion: 2,
      serviceAreas: seed.serviceAreas || config.serviceAreas,
      places: existing,
      updatedAt: now,
    });
    await updateConfig('neighborhoods', merged);
  }

  return {
    dryRun,
    actions,
    added: actions.filter((a) => a.action === 'ADD').length,
    merged: actions.filter((a) => a.action === 'MERGE').length,
    skipped: actions.filter((a) => a.action === 'SKIP_FAR').length,
    total: dryRun ? existing.length + actions.filter((a) => a.action === 'ADD').length : existing.length,
  };
}

module.exports = {
  listTaxiPlaces,
  addTaxiPlaceFromMapsUrl,
  deleteTaxiPlace,
  updateTaxiPlace,
  listServiceAreas,
  saveServiceAreas,
  extractPlacesAround,
  addTaxiPlacesBatch,
  normalizeNeighborhoodsConfig,
  seedTaxiCatalogFromAsset,
  OSM_CATEGORIES,
  DEFAULT_SERVICE_AREAS,
};
