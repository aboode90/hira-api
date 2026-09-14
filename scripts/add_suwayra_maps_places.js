/**
 * Add Suwayra taxi places from Google Maps short URLs into app_configs.neighborhoods.
 *
 * Usage:
 *   node backend/scripts/add_suwayra_maps_places.js --dry-run
 *   node backend/scripts/add_suwayra_maps_places.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const {
  addTaxiPlaceFromMapsUrl,
  updateTaxiPlace,
  listTaxiPlaces,
} = require('../services/taxi_places_config');
const { resolveGoogleMapsUrl } = require('../lib/maps_url_resolver');

const PLACES = [
  { name: 'اسالة الصويرة', mapsUrl: 'https://maps.app.goo.gl/QgL1C8A4WpxvfU987?g_st=ac' },
  { name: 'فوج طوارئ واسط الأول', mapsUrl: 'https://maps.app.goo.gl/kCo9BqHPPmwmWLLr7?g_st=ac' },
  { name: 'كوخ القيادة', mapsUrl: 'https://maps.app.goo.gl/A3ogkDk9piFdosudA' },
  { name: 'الزمله مشروع اروائي «سموكنك»', mapsUrl: 'https://maps.app.goo.gl/wV39mtYX8T7MMJ9h7' },
  { name: 'مدرسة حراس الوطن', mapsUrl: 'https://maps.app.goo.gl/cH2eqcAWG4PeS5As9?g_st=ac' },
  { name: 'مدرسة العراق الجديد الإبتدائية المختلطة', mapsUrl: 'https://maps.app.goo.gl/TrWmfmLcTxLwALW17?g_st=ac' },
  { name: 'اعداديه حلب الجديده', mapsUrl: 'https://maps.app.goo.gl/xa8iQ4coFwLGUMnq6?g_st=ac' },
  { name: 'مستلزمات الثقة الطبية', mapsUrl: 'https://maps.app.goo.gl/FLgEKfiCrdZHJ4uU7' },
  { name: 'أسواق صديق', mapsUrl: 'https://maps.app.goo.gl/KdF3gdPA9vzyspfP7?g_st=ac' },
  { name: 'بيت ابو الحسن', mapsUrl: 'https://maps.app.goo.gl/2uXpHZNSyiezC5EPA?g_st=ac' },
  { name: 'الشهم للمحاماة والاستشارات القانونية', mapsUrl: 'https://maps.app.goo.gl/RmMXAXpuTqbvcCG16' },
  { name: 'نادي الزعيم الرياضي', mapsUrl: 'https://maps.app.goo.gl/UG5h71xaSFXEjobK6?g_st=ac' },
  { name: 'اسواق بركات الحسين', mapsUrl: 'https://maps.app.goo.gl/eb5kXAXc45ma9Xts7' },
  { name: 'مضيف الحاج ابو وسام الدهلگي', mapsUrl: 'https://maps.app.goo.gl/kKAu1PCu7xcAQNaz6' },
  { name: 'فلكة الشهيد ابو مهدي المهندس', mapsUrl: 'https://maps.app.goo.gl/7XCjcohT9cX5vQwc6' },
  { name: 'جامع الإمام علي عليه السلام', mapsUrl: 'https://maps.app.goo.gl/tkH4q2jvRiDPYs5i8' },
  { name: 'معرض الاصيل المركزي (محمد الدوغاني)', mapsUrl: 'https://maps.app.goo.gl/HvQTqTkkxxb2ZQJZ8' },
  { name: 'مكتب طريق الحسين لبيع المواد الإنشائية', mapsUrl: 'https://maps.app.goo.gl/QJnF3qKAZMriLwtW8' },
  { name: 'المسكين', mapsUrl: 'https://maps.app.goo.gl/37neTjr8mzZPJtsX7?g_st=ac' },
  { name: 'كوفي شوب ازهار الحياة', mapsUrl: 'https://maps.app.goo.gl/Jx7vdHPXmkPrnCe29?g_st=ac' },
  { name: 'مطعم حماده السياحي 2', mapsUrl: 'https://maps.app.goo.gl/mdDyfXFB4Lpvvxbo9?g_st=ac' },
  { name: 'مطعم حماده الفرع الثاني', mapsUrl: 'https://maps.app.goo.gl/QGKCn5ATne5kEDxP6?g_st=ac' },
  { name: 'ملعب الفرات للخماسي', mapsUrl: 'https://maps.app.goo.gl/Z1DBRwTMDGXuz946A?g_st=ac' },
  { name: 'حي السلام', mapsUrl: 'https://maps.app.goo.gl/xHGuj4eWuGfyinSN6' },
  { name: 'محلات ابو نور', mapsUrl: 'https://maps.app.goo.gl/AAyNxLemQZoAZXs46' },
  { name: 'اسواق العائله', mapsUrl: 'https://maps.app.goo.gl/ZeBRKt6kcAbbyKgq8?g_st=ac' },
  { name: 'عبير', mapsUrl: 'https://maps.app.goo.gl/EFLAiSqjKoUGkFte6?g_st=ac' },
  { name: 'مكتب اتصالاتنا', mapsUrl: 'https://maps.app.goo.gl/SDf4M12P94Ti2RGp7' },
  { name: 'Venom Gym', mapsUrl: 'https://maps.app.goo.gl/fYTvcTAD7e6ms9yM9?g_st=ac' },
  { name: 'محمد لبيع الحاسبات', mapsUrl: 'https://maps.app.goo.gl/FHamFxbNHJtdzEjb6?g_st=ac' },
  { name: 'كوفي وسام نايف', mapsUrl: 'https://maps.app.goo.gl/93kNeHMkeTX1kW9Y7?g_st=ac' },
  { name: 'محمد سالم المبارك', mapsUrl: 'https://maps.app.goo.gl/HYy5PfessreLDnmU8?g_st=ac' },
  { name: 'كباب محمد عمار', mapsUrl: 'https://maps.app.goo.gl/D5yD58GwpokEXwaP9?g_st=ac' },
  { name: 'نجارة الكرار', mapsUrl: 'https://maps.app.goo.gl/UPr5mRVNi4HMwKPZ9?g_st=ac' },
  { name: 'كوزمتك البهاء اكسسوارات وتوصيل الكترونيات', mapsUrl: 'https://maps.app.goo.gl/SH9TBSXCTFfnggsGA' },
  { name: 'مكتب عادل للحاسبات', mapsUrl: 'https://maps.app.goo.gl/rubzUb2S15zKgUKAA' },
  { name: 'عطية البقال', mapsUrl: 'https://maps.app.goo.gl/qoqj4PAeXu6y4jf36' },
  { name: 'مكتبة عبدالله - لتجارة القرطاسية', mapsUrl: 'https://maps.app.goo.gl/hKwZS6KPHQqVbhE48?g_st=ac' },
  { name: 'كوافير نهاد', mapsUrl: 'https://maps.app.goo.gl/2PZn3ExhZjPv5BrE6' },
  { name: 'مركز A.M للموبايل', mapsUrl: 'https://maps.app.goo.gl/pWNGSgT2XBKP88ur8?g_st=ac' },
  { name: 'مقهى السعدي', mapsUrl: 'https://maps.app.goo.gl/rdpKa6vXrhgUHNuDA' },
  { name: 'دَدو بيتزا |dado pizza', mapsUrl: 'https://maps.app.goo.gl/Y6MGDHiTxMHSj4Ki8' },
  { name: 'مرطبات حمودي حاتم', mapsUrl: 'https://maps.app.goo.gl/w5aTvvK8PeiFA2HD9?g_st=ac' },
  { name: 'مركز خدمات اسياسيل الرسمي للبيع المباشر', mapsUrl: 'https://maps.app.goo.gl/foYZ31ozQo6DjN3T8' },
  { name: 'عمر الجحيشي للصيانة المحمول', mapsUrl: 'https://maps.app.goo.gl/twPAHnG24KhKyAV79?g_st=ac' },
  { name: 'دار احمد ابو دبس', mapsUrl: 'https://maps.app.goo.gl/Ec4pKehVDJXb9uaQ6' },
  { name: 'جامع سيد بهيه', mapsUrl: 'https://maps.app.goo.gl/NtozkVHfQrzVyprH9?g_st=ac' },
  { name: 'عطارية السيد علي عبد المطلب', mapsUrl: 'https://maps.app.goo.gl/RJ31cqy2pnJ5tDvA9' },
];

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[؛;]+$/g, '')
    .replace(/\s+/g, ' ');
}

function findExisting(places, name) {
  const key = normalizeName(name);
  const soft = key
    .replace(/[()«»|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const place of places) {
    const existing = normalizeName(place.name);
    if (existing === key) return place;
    const softExisting = existing
      .replace(/[()«»|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (softExisting === soft) return place;
    if (existing.includes(soft) || soft.includes(existing)) {
      // فقط عند تطابق قوي نسبياً لتجنب دمج خاطئ
      if (Math.abs(existing.length - soft.length) <= 8) return place;
    }
  }
  return null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { places } = await listTaxiPlaces();
  const results = { added: [], updated: [], skipped: [], failed: [] };

  console.log(`Existing places: ${places.length}`);
  console.log(`To process: ${PLACES.length}${dryRun ? ' (dry-run)' : ''}`);

  for (const entry of PLACES) {
    const name = entry.name.trim();
    const mapsUrl = entry.mapsUrl.trim();
    try {
      const existing = findExisting(places, name);
      if (dryRun) {
        let resolved = null;
        try {
          resolved = await resolveGoogleMapsUrl(mapsUrl);
        } catch (err) {
          results.failed.push({ name, reason: err.message });
          console.log(`FAIL  ${name} — ${err.message}`);
          continue;
        }
        if (existing) {
          results.updated.push({
            name,
            id: existing.id,
            lat: resolved.latitude,
            lng: resolved.longitude,
          });
          console.log(`UPDATE ${name} → ${resolved.latitude}, ${resolved.longitude}`);
        } else {
          results.added.push({
            name,
            lat: resolved.latitude,
            lng: resolved.longitude,
          });
          console.log(`ADD    ${name} → ${resolved.latitude}, ${resolved.longitude}`);
        }
        await sleep(400);
        continue;
      }

      if (existing) {
        const resolved = await resolveGoogleMapsUrl(mapsUrl);
        await updateTaxiPlace(existing.id, {
          name: existing.name || name,
          latitude: resolved.latitude,
          longitude: resolved.longitude,
          quickPick: true,
          enabled: true,
          kind: existing.kind || 'poi',
        });
        // updateTaxiPlace doesn't set mapsUrl — patch via raw if needed
        const { getNeighborhoods, updateConfig } = require('../services/app_config_service');
        const config = await getNeighborhoods();
        const list = Array.isArray(config.places) ? config.places : [];
        const idx = list.findIndex((p) => String(p.id) === String(existing.id));
        if (idx >= 0) {
          list[idx] = {
            ...list[idx],
            mapsUrl,
            resolvedUrl: resolved.resolvedUrl || list[idx].resolvedUrl || '',
            latitude: resolved.latitude,
            longitude: resolved.longitude,
            quickPick: true,
            enabled: true,
            updatedAt: new Date().toISOString(),
          };
          await updateConfig('neighborhoods', {
            ...config,
            places: list,
            updatedAt: new Date().toISOString(),
            schemaVersion: 2,
          });
        }
        results.updated.push({ name, id: existing.id });
        console.log(`UPDATED ${name}`);
      } else {
        try {
          const result = await addTaxiPlaceFromMapsUrl({
            mapsUrl,
            name,
            serviceAreaId: 'suwayra',
          });
          const place = result.place;
          if (place?.id) {
            await updateTaxiPlace(place.id, {
              quickPick: true,
              enabled: true,
              kind: 'poi',
            });
            places.push(place);
          }
          results.added.push({ name, id: place?.id });
          console.log(`ADDED  ${name}`);
        } catch (err) {
          if (String(err.message || '').includes('مسجّل مسبقاً')) {
            // race/name match — try soft update by re-listing
            const fresh = await listTaxiPlaces();
            const again = findExisting(fresh.places, name);
            if (again) {
              const resolved = await resolveGoogleMapsUrl(mapsUrl);
              const { getNeighborhoods, updateConfig } = require('../services/app_config_service');
              const config = await getNeighborhoods();
              const list = Array.isArray(config.places) ? config.places : [];
              const idx = list.findIndex((p) => String(p.id) === String(again.id));
              if (idx >= 0) {
                list[idx] = {
                  ...list[idx],
                  mapsUrl,
                  resolvedUrl: resolved.resolvedUrl || '',
                  latitude: resolved.latitude,
                  longitude: resolved.longitude,
                  quickPick: true,
                  enabled: true,
                  updatedAt: new Date().toISOString(),
                };
                await updateConfig('neighborhoods', {
                  ...config,
                  places: list,
                  updatedAt: new Date().toISOString(),
                  schemaVersion: 2,
                });
              }
              results.updated.push({ name, id: again.id });
              console.log(`UPDATED ${name} (duplicate)`);
            } else {
              results.skipped.push({ name, reason: err.message });
              console.log(`SKIP   ${name} — ${err.message}`);
            }
          } else {
            throw err;
          }
        }
      }
      await sleep(600);
    } catch (err) {
      results.failed.push({ name, reason: err.message || String(err) });
      console.log(`FAIL   ${name} — ${err.message || err}`);
      await sleep(800);
    }
  }

  console.log('\nSummary:');
  console.log(JSON.stringify({
    added: results.added.length,
    updated: results.updated.length,
    skipped: results.skipped.length,
    failed: results.failed.length,
    failedItems: results.failed,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
