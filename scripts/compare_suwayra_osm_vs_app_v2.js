require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const {
  extractPlacesAround,
  listTaxiPlaces,
} = require('../services/taxi_places_config');

const CENTER = { latitude: 32.9256, longitude: 44.7766 };

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

async function extractAllCategories(radiusKm) {
  const typesList = [
    ['all'],
    ['shops'],
    ['education'],
    ['health'],
    ['religious'],
    ['food'],
    ['fuel'],
    ['services'],
  ];
  const byName = new Map();
  for (const types of typesList) {
    process.stdout.write(`OSM extract types=${types.join(',')} r=${radiusKm}km ... `);
    try {
      const rows = await extractPlacesAround({
        ...CENTER,
        radiusKm,
        types,
      });
      console.log(`${rows.length} named`);
      for (const row of rows) {
        const key = normalizeName(row.name);
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, row);
      }
    } catch (error) {
      console.log(`FAIL: ${error.message || error}`);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

async function main() {
  const radiusKm = Number(process.argv[2] || 18);
  console.log(`قضاء الصويرة ≈ دائرة ${radiusKm} كم حول المركز`);
  const osmPlaces = await extractAllCategories(radiusKm);
  const appList = await listTaxiPlaces();
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

  const summary = {
    osmNamedPlaces: osmPlaces.length,
    appSavedSuwayra: appPlaces.length,
    matchedSameName: inBoth.length,
    onlyInOsm: onlyOsm.length,
    onlyInApp: onlyApp.length,
    pctAppCoveredByOsm:
      appPlaces.length > 0
        ? Number(((inBoth.length / appPlaces.length) * 100).toFixed(1))
        : 0,
    pctOsmAlreadyInApp:
      osmPlaces.length > 0
        ? Number(((inBoth.length / osmPlaces.length) * 100).toFixed(1))
        : 0,
  };

  console.log('\n=== النتيجة ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nمشتركة (عينة 12):');
  console.log(inBoth.slice(0, 12).join('\n') || '-');
  console.log('\nفي الخريطة وغير محفوظة عندكم (عينة 15):');
  console.log(onlyOsm.slice(0, 15).join('\n') || '-');
  console.log('\nمحفوظة عندكم وغير مطابقة بالاسم في الخريطة (عينة 15):');
  console.log(onlyApp.slice(0, 15).join('\n') || '-');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
