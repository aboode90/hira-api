#!/usr/bin/env node
/**
 * دفعة أماكن تكسي محفوظة إضافية.
 *
 * Usage (from backend/):
 *   node scripts/add_saved_taxi_places_batch4.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { addTaxiPlaceFromMapsUrl, listTaxiPlaces } = require('../services/taxi_places_config');

const PLACES = [
  ['مكتب كرار للحاسبات', 'https://maps.app.goo.gl/bRPuR5gJzDBedbhk9'],
  ['سيدار للمفروشات', 'https://maps.app.goo.gl/JNv14SBiUAmYEQqD6?g_st=ac'],
  ['اعدادية سبل النجاح الاهلية للبنين', 'https://maps.app.goo.gl/v4dsn1Eh2fMHEyCn9?g_st=ac'],
  ['اعدادية مصباح الهدى للبنات', 'https://maps.app.goo.gl/UuWpqoxwQubD8sHR9?g_st=ac'],
  ['مكتب حسن هادي عبد الرزاق لصيانة الطابعات', 'https://maps.app.goo.gl/8Vz9JuiFox6DYk3r8?g_st=ac'],
  ['اسواق بيت الحاج حنطة', 'https://maps.app.goo.gl/ybQUugwcGDrBGKtu9'],
  ['موكب العقيله زينب (ع) عشيرت الشمامطه', 'https://maps.app.goo.gl/a65yBQ7jneCDtGX78'],
  ['مجزرة الصويرة', 'https://maps.app.goo.gl/5K9gRB31hsnAYYDaA?g_st=ac'],
  ['مجسر الصويرة', 'https://maps.app.goo.gl/uF4524TPfPvqLzTS7?g_st=ac'],
  ['مرقد الامام تاج الدين', 'https://maps.app.goo.gl/McRSpPj3Usk5K7MV6?g_st=ac'],
  ['حسينية بقيت الله', 'https://maps.app.goo.gl/UUV3tLUQVmDL4jqVA?g_st=ac'],
  ['حمزه زماني للاعلانات والترويج', 'https://maps.app.goo.gl/KsHcWsxLtuZm9cmFA'],
  ['الصويرة قرية العبيدية', 'https://maps.app.goo.gl/uF7VrA3gCCYnFbpf8?g_st=ac'],
];

function uniqueName(base, used) {
  let name = base;
  let n = 2;
  const key = (value) => String(value || '').trim().toLowerCase();
  while (used.has(key(name))) {
    name = `${base} (${n})`;
    n += 1;
  }
  used.add(key(name));
  return name;
}

async function main() {
  const existing = await listTaxiPlaces();
  const used = new Set(
    (existing.places || []).map((item) => String(item?.name || '').trim().toLowerCase()),
  );
  console.log(`existing places: ${existing.count || 0}`);

  const added = [];
  const skipped = [];
  const failed = [];

  for (const [baseName, mapsUrl] of PLACES) {
    const name = uniqueName(baseName, used);
    try {
      const result = await addTaxiPlaceFromMapsUrl({ mapsUrl, name });
      const place = result.place;
      added.push({
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
      });
      console.log(`OK  ${place.name}  ${place.latitude},${place.longitude}`);
      await new Promise((resolve) => setTimeout(resolve, 450));
    } catch (error) {
      used.delete(String(name || '').trim().toLowerCase());
      const message = error?.message || String(error);
      if (error?.statusCode === 409) {
        skipped.push({ name: baseName, mapsUrl, reason: message });
        console.log(`SKIP ${baseName}  ${message}`);
      } else {
        failed.push({ name: baseName, mapsUrl, reason: message });
        console.log(`FAIL ${baseName}  ${message}`);
      }
    }
  }

  console.log('\n---');
  console.log(`added=${added.length} skipped=${skipped.length} failed=${failed.length}`);
  if (failed.length) {
    console.log('\nFailed:');
    for (const item of failed) {
      console.log(`- ${item.name}: ${item.reason}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { PLACES };
