/**
 * One-time export: parse Flutter dart catalogs → JSON seed files.
 * Run: node backend/scripts/export_taxi_catalog_from_dart.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function parseSuwayraPlaces(source, kind) {
  const re =
    /SuwayraPlace\s*\(\s*name:\s*'((?:\\'|[^'])*)'\s*,\s*latitude:\s*([\d.]+)\s*,\s*longitude:\s*([\d.]+)/g;
  const places = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    places.push({
      name: m[1].replace(/\\'/g, "'"),
      latitude: Number(m[2]),
      longitude: Number(m[3]),
      kind,
    });
  }
  return places;
}

function parseKnownPlaces(source) {
  const re =
    /displayName:\s*'((?:\\'|[^'])*)'\s*,\s*subtitle:\s*'((?:\\'|[^'])*)'\s*,\s*latLng:\s*LatLng\s*\(\s*([\d.]+)\s*,\s*([\d.]+)/g;
  const places = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    places.push({
      name: m[1].replace(/\\'/g, "'"),
      subtitle: m[2].replace(/\\'/g, "'"),
      latitude: Number(m[3]),
      longitude: Number(m[4]),
      kind: 'poi',
      quickPick: true,
    });
  }
  return places;
}

/** Fix Suwayra quick-picks where longitude was ~45.xx instead of ~44.xx */
function fixSuwayraLongitude(lat, lng) {
  if (lat >= 32.7 && lat <= 33.2 && lng >= 45.0 && lng <= 46.0) {
    return Number((lng - 1).toFixed(6));
  }
  return lng;
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

function buildIraqAdminAreas() {
  // Mirror lib/core/data/iraq_admin_areas.dart (Wasit tree)
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    governorates: [
      {
        id: 'wasit',
        nameAr: 'واسط',
        districts: [
          {
            id: 'kut',
            nameAr: 'الكوت',
            selectable: false,
            localities: [
              { id: 'kut_center', nameAr: 'مركز القضاء', selectable: false },
              { id: 'kut_sheikh_saad', nameAr: 'ناحية الشيخ سعد', selectable: false },
              { id: 'kut_wasit', nameAr: 'ناحية واسط', selectable: false },
              { id: 'kut_rural', nameAr: 'أرياف الكوت', selectable: false },
            ],
          },
          {
            id: 'suwayra',
            nameAr: 'الصويرة',
            selectable: true,
            localities: [
              { id: 'suwayra_center', nameAr: 'الصويرة', selectable: true },
              { id: 'suwayra_mazraa', nameAr: 'المزرعة', selectable: true },
              { id: 'suwayra_tanmiya', nameAr: 'التنمية', selectable: true },
              { id: 'suwayra_zubaydiya', nameAr: 'ناحية الزبيدية', selectable: false },
              { id: 'suwayra_shahimiya', nameAr: 'ناحية الشحيمية', selectable: false },
              { id: 'suwayra_rural', nameAr: 'أرياف الصويرة', selectable: false },
            ],
          },
          {
            id: 'aziziya',
            nameAr: 'العزيزية',
            selectable: false,
            localities: [
              { id: 'aziziya_center', nameAr: 'مركز القضاء', selectable: false },
              { id: 'aziziya_hafriya', nameAr: 'ناحية الحفرية', selectable: false },
              { id: 'aziziya_dabuni', nameAr: 'ناحية الدبوني', selectable: false },
              { id: 'aziziya_rural', nameAr: 'أرياف العزيزية', selectable: false },
            ],
          },
          {
            id: 'numaniya',
            nameAr: 'النعمانية',
            selectable: false,
            localities: [
              { id: 'numaniya_center', nameAr: 'مركز القضاء', selectable: false },
              { id: 'numaniya_ahrar', nameAr: 'ناحية الأحرار', selectable: false },
              { id: 'numaniya_rural', nameAr: 'أرياف النعمانية', selectable: false },
            ],
          },
          {
            id: 'hai',
            nameAr: 'الحي',
            selectable: false,
            localities: [
              { id: 'hai_center', nameAr: 'مركز القضاء', selectable: false },
              { id: 'hai_muwaffaqiya', nameAr: 'ناحية الموفقية', selectable: false },
              { id: 'hai_bashair', nameAr: 'ناحية البشائر', selectable: false },
              { id: 'hai_rural', nameAr: 'أرياف الحي', selectable: false },
            ],
          },
          {
            id: 'badra',
            nameAr: 'بدرة',
            selectable: false,
            localities: [
              { id: 'badra_center', nameAr: 'مركز القضاء', selectable: false },
              { id: 'badra_jassan', nameAr: 'ناحية جصان', selectable: false },
              { id: 'badra_zurbatiya', nameAr: 'ناحية زرباطية', selectable: false },
              { id: 'badra_rural', nameAr: 'أرياف بدرة', selectable: false },
            ],
          },
        ],
      },
    ],
  };
}

function main() {
  const neighborhoodsSrc = read('lib/core/data/iraq_neighborhoods.dart');
  const extraSrc = read('lib/core/data/taxi_extra_places.dart');
  const knownSrc = read('lib/modules/taxi/data/taxi_known_places.dart');

  const centerLat = 32.9256;
  const centerLng = 44.7766;
  const now = new Date().toISOString();
  const seen = new Map();
  const places = [];
  const skipped = [];

  function addEntry(entry) {
    let lat = entry.latitude;
    let lng = fixSuwayraLongitude(lat, entry.longitude);
    const dist = haversineKm(centerLat, centerLng, lat, lng);
    if (dist > 30 && !entry.quickPick) {
      skipped.push({ name: entry.name, dist: dist.toFixed(1) });
    }
    if (dist > 30 && entry.quickPick) {
      skipped.push({ name: entry.name, dist: dist.toFixed(1), note: 'quickPick far — skipped' });
      return;
    }
    const key = entry.name.trim().toLowerCase();
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (entry.quickPick) existing.quickPick = true;
      if (entry.subtitle && !existing.subtitle) existing.subtitle = entry.subtitle;
      return;
    }
    const item = {
      id: crypto.randomUUID(),
      name: entry.name,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
      serviceAreaId: 'suwayra',
      serviceAreaNameAr: 'الصويرة',
      kind: entry.kind || 'poi',
      subtitle: entry.subtitle || null,
      quickPick: Boolean(entry.quickPick),
      enabled: true,
      origin: 'builtin',
      mapsUrl: '',
      resolvedUrl: '',
      addedAt: now,
      updatedAt: now,
    };
    seen.set(key, item);
    places.push(item);
  }

  for (const p of parseSuwayraPlaces(neighborhoodsSrc, 'neighborhood')) addEntry(p);
  for (const p of parseSuwayraPlaces(
    neighborhoodsSrc.slice(neighborhoodsSrc.indexOf('suwayraLandmarkPlaces')),
    'landmark'
  )) {
    addEntry(p);
  }
  for (const p of parseSuwayraPlaces(extraSrc, 'poi')) addEntry(p);
  for (const p of parseKnownPlaces(knownSrc)) addEntry(p);

  const catalog = {
    schemaVersion: 2,
    updatedAt: now,
    serviceAreas: [
      {
        id: 'suwayra',
        nameAr: 'الصويرة',
        governorateNameAr: 'واسط',
        centerLat: 32.9256,
        centerLng: 44.7766,
        enabled: true,
        isDefault: true,
      },
    ],
    places,
  };

  const adminAreas = buildIraqAdminAreas();
  const outDir = path.join(ROOT, 'assets/config');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'taxi_catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'iraq_admin_areas.json'),
    JSON.stringify(adminAreas, null, 2),
    'utf8'
  );

  console.log(`Exported ${places.length} places (${places.filter((p) => p.quickPick).length} quick picks)`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} far entries:`);
    for (const s of skipped.slice(0, 10)) console.log('  -', s.name, s.dist + 'km', s.note || '');
  }
}

main();
