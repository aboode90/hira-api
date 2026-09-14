#!/usr/bin/env node
/**
 * دفعة أماكن تكسي محفوظة (صويرة وما حولها).
 *
 * Usage (from backend/):
 *   node scripts/add_saved_taxi_places_batch3.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { addTaxiPlaceFromMapsUrl, listTaxiPlaces } = require('../services/taxi_places_config');

const PLACES = [
  ['ربيضة', 'https://maps.app.goo.gl/XrbvhL1XHdzduEgY9'],
  ['فلكة كسار', 'https://maps.app.goo.gl/a9EDXP1UFQoo2GT36?g_st=ac'],
  ['مجمع سنتر الأسعار', 'https://maps.app.goo.gl/PtXgCY9QKv6xk5N38?g_st=ac'],
  ['مدرسة الربيع الابتدائية للبنات', 'https://maps.app.goo.gl/USpAxaqzbZoczvzP6?g_st=ac'],
  ['محطة وقود الصويرة الحكومية', 'https://maps.app.goo.gl/F6tttEbhyJ4ZUoSNA'],
  ['عيادة طب الاسنان', 'https://maps.app.goo.gl/CPFB2Yx6RYkq9nSF9?g_st=ac'],
  ['العالمي لكماليات السيارات', 'https://maps.app.goo.gl/CnBESPAGgK7gPCfg9?g_st=ac'],
  ['استاذ محمد فيزياء', 'https://maps.app.goo.gl/aEdp48dhsBG5v6QZ8?g_st=ac'],
  ['كوفي نضير', 'https://maps.app.goo.gl/Vji58e9QZXjwcJmF8?g_st=ac'],
  ['اسواق ابو العبد', 'https://maps.app.goo.gl/ZCQuXbT2xGS3sod76?g_st=ac'],
  ['شارع القاضي الصويرة', 'https://maps.app.goo.gl/BhNVoJwJVfW76L6e7'],
  ['مدرسة الاعمار الابتدائية', 'https://maps.app.goo.gl/hn2SodhGkTGrcj7VA?g_st=ac'],
  ['فرن صمون', 'https://maps.app.goo.gl/KduNYpk46DaDZN4A9?g_st=ac'],
  ['متنزه حي الزهراء', 'https://maps.app.goo.gl/bvPH1v37wCXnS2hr8?g_st=ac'],
  ['حسينية ألطاف ألسلطان موكب عزاء الضامن', 'https://maps.app.goo.gl/5CGGtuawHxJRRRCR7?g_st=ac'],
  ['عباس العبدلي ابو فرات', 'https://maps.app.goo.gl/QxcCm2ARo4T6FmhT8'],
  ['حي السلام، الصويرة، العراق', 'https://maps.app.goo.gl/UHQNRfxwanA2xDw37'],
  ['خليل خشان الكلابي', 'https://maps.app.goo.gl/XtG4ZkgyaLCb9SCL7'],
  ['فرن صمون', 'https://maps.app.goo.gl/K2n4hzMVyCvnPL52A?g_st=ac'],
  ['بيت حجي رسول', 'https://maps.app.goo.gl/X1CRi5giSDPReNwq5?g_st=ac'],
  ['وميض اياد الموسوي', 'https://maps.app.goo.gl/cqKZkBQgX58azucdA?g_st=ac'],
  ['حسوني ابن صويره', 'https://maps.app.goo.gl/Psng62ZkoGwaxBcbA?g_st=ac'],
  ['باقر ناجي', 'https://maps.app.goo.gl/yMY3UWWG7ivDb3kw8?g_st=ac'],
  ['بيت أنور عجيل', 'https://maps.app.goo.gl/2ZyUeZQedV1b9ANn8?g_st=ac'],
  ['عباس العبدلي ابو فرات', 'https://maps.app.goo.gl/ky4MnTfEecQddbRT7?g_st=ac'],
  ['افران الكوثر واثق', 'https://maps.google.com/?cid=2685712841804928833&entry=gps'],
  ['كيك الصويره', 'https://maps.google.com/?cid=2605983621713128642&entry=gps&g_st=ac'],
  ['كاظم عسكر ابو حيدر', 'https://maps.app.goo.gl/us1rhB5nZKN77yTg9'],
  ['عباس العبدلي ابو فرات', 'https://maps.app.goo.gl/iHsH5CgkNyDWGt3a8'],
  ['مركز هنداس الثقافي', 'https://maps.app.goo.gl/oVrbEekpnd3DczXW9'],
  ['كلية القوة الجوية العراقية', 'https://maps.app.goo.gl/UcF6oGtgZDZ5n12h6?g_st=ac'],
  ['اسواق بركاته الزاير', 'https://maps.app.goo.gl/rHtpVEtkGFMDiHkr7'],
  ['مكافحة ادغال', 'https://maps.app.goo.gl/Din2fKnx6HU9r6MF7?g_st=ac'],
  ['اسواق سيد محمد البعاج', 'https://maps.app.goo.gl/GrMBAcstoGmpxTG86?g_st=ac'],
  ['أبو ماهر للفواكه والخضار', 'https://maps.app.goo.gl/eqpPwjkd8LgNJN5J6?g_st=ac'],
  ['مركز صحي الخناسة', 'https://maps.app.goo.gl/RqvYGDvCWfdxryoD9?g_st=ac'],
  ['سريع اليوسفية الجديد', 'https://maps.app.goo.gl/z2ko8hZT9F7UXH656?g_st=ac'],
  ['Savira Resort - منتجع سافيرا', 'https://maps.app.goo.gl/49B6Uct56cMJpGz59'],
  ['جامع الباسط ٢ الثاني', 'https://maps.app.goo.gl/X8YD25yk7wjJHBPQ9'],
  ['فلكة الشيخ احمد الوائلي', 'https://maps.app.goo.gl/GJiTDQFW7ehRG7hH8'],
  ['أفران السنبلة صمون حجري', 'https://maps.app.goo.gl/AvArPdp5VKf8pyCC9?g_st=ac'],
  ['صيدلية الشذرة', 'https://maps.app.goo.gl/3uc2N9RfEiPTL1TQ6'],
  ['صيرة', 'https://maps.app.goo.gl/bvA3WudsMUyBFfju7'],
  ['سكلة شامل كطيف', 'https://maps.app.goo.gl/Z2HmxUboDDLWLf7p8?g_st=ac'],
  ['حي الفرات، الصويرة، واسط', 'https://maps.app.goo.gl/GQkHAjvxYz7PSVug7'],
  ['م عبدالرضا حمزه', 'https://maps.app.goo.gl/quCNZeFWERyvjBbg8'],
  ['ساهم كريم الكهربائي', 'https://maps.app.goo.gl/TYsvkhFTKfEZLfEE8'],
  ['مدرسة الفاو الابتدائية للبنين', 'https://maps.app.goo.gl/LHiW8bvigns2TU3v6?g_st=ac'],
  ['مندي تعز اليمن', 'https://maps.app.goo.gl/sQDyf95z1FX6VVQP7'],
  ['مرطبات شموسة', 'https://maps.app.goo.gl/Btg6ZYGpAKzEMXw16'],
  ['مخبز تفتوني', 'https://maps.app.goo.gl/XQYm1vEB7a1zssWG7?g_st=ac'],
  ['لانجري لهفه', 'https://maps.app.goo.gl/AbYAayehzGMvx6PM8?g_st=ac'],
  ['كوزمتك ميار', 'https://maps.app.goo.gl/MPpGyF5G5WeN2wtp7?g_st=ac'],
  ['كيك آيفان', 'https://maps.app.goo.gl/8bQQgxpDPP4wuJFF8'],
  ['صيدلية اركان حسين حمزة', 'https://maps.app.goo.gl/9HZSWrZ1ssu7p1jA7'],
  ['مجمع العائلة للمواد الغذائية والمنزلية والالبسة الجاهزة', 'https://maps.app.goo.gl/dzZbDspWrtPY1Gd39?g_st=ac'],
  ['النجمه مول', 'https://maps.app.goo.gl/CeAXXemkDh5a9xUKA'],
  ['اقمشه الحاج طلعت الحيدري', 'https://maps.app.goo.gl/UhcZWg5qYkaB48jw8?g_st=ac'],
  ['متجر هوم بيبي - الصويرة شارع النجمة', 'https://maps.app.goo.gl/45rJH5jBQurzsKEv6?g_st=ac'],
  ['فواحه للورد الطبيعي', 'https://maps.app.goo.gl/wcz6dQZu13E3MgVi9'],
  ['فلورا للالبسه النسائية', 'https://maps.app.goo.gl/B1C4So9bVWLm4zB59?g_st=ac'],
  ['نمنمة', 'https://maps.app.goo.gl/5igTVT1KoURo59bMA?g_st=ac'],
  ['ديم اتلير', 'https://maps.app.goo.gl/cfjAwbz4m18juoBC7?g_st=ac'],
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
