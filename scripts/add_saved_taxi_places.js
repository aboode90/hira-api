#!/usr/bin/env node
/**
 * يضيف أماكن تكسي محفوظة من روابط Google Maps إلى إعداد neighborhoods.
 *
 * Usage (from backend/):
 *   node scripts/add_saved_taxi_places.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { addTaxiPlaceFromMapsUrl, listTaxiPlaces } = require('../services/taxi_places_config');

const PLACES = [
  ['دار السيد عبد الصاحب الموسوي لعلوم القرآن', 'https://maps.app.goo.gl/SFsjUShXfg18iCAx6?g_st=ac'],
  ['أسامة محمد مناحي', 'https://maps.app.goo.gl/si4FCWo9WYWP1Wbb6?g_st=ac'],
  ['ملعب اسعد وادي', 'https://maps.app.goo.gl/DPqve85Lzspx4m8a9'],
  ['كلية الكوت الجامعة /الصويرة', 'https://maps.app.goo.gl/CkjMzWMP3ovGZmJm8?g_st=ac'],
  ['مطعم و حدايق كورنيش الصويره', 'https://maps.app.goo.gl/rLjtmfUwUUn5fR7LA?g_st=ac'],
  ['مزرعة الحاج حيدر المياحي', 'https://maps.app.goo.gl/Aq8DbGGJGMhoawCJA?g_st=ac'],
  ['جامع وحسينية الصحابي الجليل سلمان المحمدي / بيت حسوني', 'https://maps.app.goo.gl/z5DZrUGvYpwbcVZj6'],
  ['حسين حميد محمد المعموري ( ابو مكي )', 'https://maps.app.goo.gl/VMVfEXLWQEc7C5eq9?g_st=ac'],
  ['حسينية ائمة البقيع', 'https://maps.app.goo.gl/tLGo4WzMoD1nqYbs6?g_st=ac'],
  ['حسين حميد محمد المعموري ( ابو مكي )', 'https://maps.app.goo.gl/Q1VAg9vsJYeLzRRA9'],
  ['مهدي مجبل عباس الزبيدي', 'https://maps.app.goo.gl/Cwe7VcNv2tTwgZNr6'],
  ['ياس المالكي ابو علاء', 'https://maps.app.goo.gl/WdqkyWTTBVH6yph59?g_st=ac'],
  ['مزرعه اللواء قيس', 'https://maps.app.goo.gl/brmiEe64UNPzDbPV7?g_st=ac'],
  ['مركز عقيل الدوغاني لخدمات الانترنت والحاسبات والموبايل', 'https://maps.app.goo.gl/zK4FoqPRtXKG2xSq7?g_st=ac'],
  ['مركز عقيل الدوغاني لخدمات الانترنت والحاسبات والموبايل', 'https://maps.app.goo.gl/KzQ2MSGfpysi37kb6?g_st=ac'],
  ['برج انترنيت يوسف الغراني', 'https://maps.app.goo.gl/WdjKNqUHzjPG1Ga57'],
  ['علي ناصريه', 'https://maps.google.com/?cid=4909927177786764&entry=gps'],
  ['اسواق بركاته الزاير', 'https://maps.app.goo.gl/uhSYenHGg5vLNPjK9'],
  ['مطعم صكبان السياحي', 'https://maps.app.goo.gl/GQofuafTF1zyAEsQ9'],
  ['محطة وقود المرايا المشيدة', 'https://maps.app.goo.gl/E6pwJaScHqJKhabJ7?g_st=ac'],
  ['اسماك و مشويات حمزه الاسدي', 'https://maps.app.goo.gl/fmW9tSg5eZJUMFQx7'],
  ['سواق ابو ليث الجميلي', 'https://maps.app.goo.gl/c9hQCKcnDaM7SzFk8'],
  ['اسواق علي عادل', 'https://maps.app.goo.gl/shXGrcGnn15k66vx5'],
  ['اسواق الملا ماء Ro', 'https://maps.app.goo.gl/dZcrQXH7AWGX5EyS9'],
  ['حقل دواجن لحم', 'https://maps.app.goo.gl/jPHaeAcBC6BvfnDe7'],
  ['المعهد التقني الصويرة', 'https://maps.app.goo.gl/A4xVZJRUrQBTMgir8?g_st=ac'],
  ['اسواق آل حسوني', 'https://maps.app.goo.gl/GvoJUE5wUyyBV2vW9?g_st=ac'],
  ['فلكة عبدالكريم قاسم الصويرة', 'https://maps.app.goo.gl/RR78CwrdQQE2p1fY8?g_st=ac'],
  ['مكتب إدارة منطقة بغداد السكنية', 'https://maps.app.goo.gl/T45SsvSqoZnecmLg6?g_st=ac'],
  ['معمل غاز الجوادين الاهلي', 'https://maps.app.goo.gl/m1N6Pf9Df3iCSNMQ8'],
  ['جامع الحاج أحمد العابد العكيدي', 'https://maps.app.goo.gl/AiHHyL7jaK5hWyd29?g_st=ac'],
  ['ميثاق الحلاق', 'https://maps.app.goo.gl/ZrSgPombmvs7hwTG9?g_st=ac'],
  ['مطعم وكافيه عبق الشام', 'https://maps.app.goo.gl/8MTSQx4DpdHKGcX56'],
  ['مرقد السيد نور', 'https://maps.app.goo.gl/7k3hSRJJkNVReCcEA'],
  ['ماركت ميرة', 'https://maps.app.goo.gl/TvmdUeqHAg7DtfAd8?g_st=ac'],
  ['مول ساحل العاج', 'https://maps.app.goo.gl/wYa2G6CTjFekzxXX9?g_st=ac'],
  ['مطعم دجلة الخير', 'https://maps.app.goo.gl/8K9SQxFTjEdEx5sb9'],
  ['صاج مرنوش', 'https://maps.app.goo.gl/16si1qU6m7dirS7L8'],
  ['لاند بركر', 'https://maps.app.goo.gl/RFPRmmcJH96Bn9y46?g_st=ac'],
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
      await new Promise((resolve) => setTimeout(resolve, 400));
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
