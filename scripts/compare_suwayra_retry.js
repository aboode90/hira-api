require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { extractPlacesAround, listTaxiPlaces } = require('../services/taxi_places_config');

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

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function extractRetry(types, radiusKm) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const rows = await extractPlacesAround({
        latitude: 32.9256,
        longitude: 44.7766,
        radiusKm,
        types,
      });
      return rows;
    } catch (error) {
      console.log(`  retry ${attempt} ${types}: ${error.message || error}`);
      await sleep(2000 * attempt);
    }
  }
  return [];
}

async function main() {
  const radiusKm = 18;
  const byName = new Map();
  const typeSets = [
    ['shops'],
    ['education'],
    ['health'],
    ['religious'],
    ['food'],
    ['fuel'],
    ['services'],
  ];
  for (const types of typeSets) {
    process.stdout.write(`${types[0]}... `);
    const rows = await extractRetry(types, radiusKm);
    console.log(rows.length);
    for (const row of rows) {
      const key = normalizeName(row.name);
      if (key && !byName.has(key)) byName.set(key, row);
    }
    await sleep(1500);
  }

  const osmPlaces = [...byName.values()];
  const appPlaces = ((await listTaxiPlaces()).places || []).filter(
    (p) => String(p.serviceAreaId || 'suwayra') === 'suwayra'
  );

  let matched = 0;
  const appKeys = new Set(appPlaces.map((p) => normalizeName(p.name)));
  for (const p of osmPlaces) {
    if (appKeys.has(normalizeName(p.name))) matched += 1;
  }

  console.log(
    JSON.stringify(
      {
        note: 'استخراج من OpenStreetMap (أماكن مسماة: محلات/تعليمارس/صحة/مساجد/مطاعم/وقود/خدمات) ضمن ~18كم حول مركز الصويرة',
        osmCount: osmPlaces.length,
        appSavedCount: appPlaces.length,
        sameNameMatch: matched,
        onlyOsmApprox: osmPlaces.length - matched,
        onlyAppApprox: appPlaces.length - matched,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
