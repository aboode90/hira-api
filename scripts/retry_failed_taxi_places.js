#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolveGoogleMapsUrl } = require('../lib/maps_url_resolver');
const {
  addTaxiPlaceFromMapsUrl,
  listTaxiPlaces,
  deleteTaxiPlace,
} = require('../services/taxi_places_config');

const RETRY = [
  ['مركز عقيل الدوغاني لخدمات الانترنت والحاسبات والموبايل', 'https://maps.app.goo.gl/zK4FoqPRtXKG2xSq7?g_st=ac'],
  ['مركز عقيل الدوغاني لخدمات الانترنت والحاسبات والموبايل', 'https://maps.app.goo.gl/KzQ2MSGfpysi37kb6?g_st=ac'],
  ['علي ناصريه', 'https://maps.google.com/?cid=4909927177786764&entry=gps'],
  ['اسماك و مشويات حمزه الاسدي', 'https://maps.app.goo.gl/fmW9tSg5eZJUMFQx7'],
  ['مول ساحل العاج', 'https://maps.app.goo.gl/wYa2G6CTjFekzxXX9?g_st=ac'],
  ['مطعم دجلة الخير', 'https://maps.app.goo.gl/8K9SQxFTjEdEx5sb9'],
  ['صاج مرنوش', 'https://maps.app.goo.gl/16si1qU6m7dirS7L8'],
  ['لاند بركر', 'https://maps.app.goo.gl/RFPRmmcJH96Bn9y46?g_st=ac'],
];

const ACCIDENTAL_DUPES = [
  'كلية الكوت الجامعة /الصويرة (2)',
  'مطعم و حدايق كورنيش الصويره (2)',
  'جامع وحسينية الصحابي الجليل سلمان المحمدي / بيت حسوني (2)',
  'مطعم صكبان السياحي (2)',
  'ماركت ميرة (2)',
  'حسين حميد محمد المعموري ( ابو مكي ) (2)',
];

async function main() {
  const listed = await listTaxiPlaces();
  const byName = new Map(
    (listed.places || []).map((item) => [String(item.name || '').trim(), item]),
  );

  for (const name of ACCIDENTAL_DUPES) {
    const place = byName.get(name);
    if (!place) continue;
    await deleteTaxiPlace(place.id);
    console.log(`DEL  ${name}`);
  }

  for (const [name, mapsUrl] of RETRY) {
    try {
      const resolved = await resolveGoogleMapsUrl(mapsUrl);
      console.log(`RES  ${name}  ${resolved.latitude},${resolved.longitude}  ${resolved.resolvedUrl}`);
      const result = await addTaxiPlaceFromMapsUrl({ mapsUrl, name });
      console.log(`OK   ${result.place.name}`);
    } catch (error) {
      console.log(`FAIL ${name}  ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
