#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { PLACES } = require('./add_saved_taxi_places');
const { resolveGoogleMapsUrl } = require('../lib/maps_url_resolver');
const { getNeighborhoods, updateConfig } = require('../services/app_config_service');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

async function main() {
  const config = await getNeighborhoods();
  const places = Array.isArray(config?.places) ? config.places : [];
  const byName = new Map(places.map((item) => [normalizeName(item?.name), item]));
  const now = new Date().toISOString();
  let updated = 0;
  let added = 0;
  let failed = 0;
  const seen = new Set();

  for (const [name, mapsUrl] of PLACES) {
    const key = `${normalizeName(name)}|${String(mapsUrl).split('?')[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const resolved = await resolveGoogleMapsUrl(mapsUrl);
      let entry = byName.get(normalizeName(name));
      if (!entry) {
        entry = {
          id: require('crypto').randomUUID(),
          name,
          addedAt: now,
        };
        places.push(entry);
        byName.set(normalizeName(name), entry);
        added += 1;
        console.log(`ADD  ${name}  ${resolved.latitude},${resolved.longitude}`);
      } else {
        const same =
          Number(entry.latitude) === Number(resolved.latitude.toFixed(6)) &&
          Number(entry.longitude) === Number(resolved.longitude.toFixed(6));
        if (same && entry.mapsUrl) {
          console.log(`KEEP ${name}  ${entry.latitude},${entry.longitude}`);
        } else {
          console.log(
            `UPD  ${name}  ${entry.latitude},${entry.longitude} -> ${resolved.latitude},${resolved.longitude}`,
          );
          updated += 1;
        }
      }
      entry.latitude = Number(resolved.latitude.toFixed(6));
      entry.longitude = Number(resolved.longitude.toFixed(6));
      entry.mapsUrl = mapsUrl;
      entry.resolvedUrl = resolved.resolvedUrl;
      entry.updatedAt = now;
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}  ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  await updateConfig('neighborhoods', { ...config, places });
  console.log(`\nupdated=${updated} added=${added} failed=${failed} total=${places.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
