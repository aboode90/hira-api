#!/usr/bin/env node
/**
 * تشخيص حالة التكسي + Supabase (للاستخدام من الطرفية مع backend/.env).
 *
 * Usage:
 *   node scripts/check_taxi_driver_health.js
 *   node scripts/check_taxi_driver_health.js --phone=07701234567
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  assertSupabaseAdmin,
  resolvePhoneKey,
  getPhoneVariants,
} = require('../supabase_repo/common');
const { getDeviceTokensForPhone } = require('../supabase_repo/push_notifications');

function parsePhoneArg() {
  const arg = process.argv.find((a) => a.startsWith('--phone='));
  return arg ? String(arg.split('=')[1] || '').trim() : '';
}

async function timed(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { label, ok: true, ms: Date.now() - start, result };
  } catch (error) {
    return {
      label,
      ok: false,
      ms: Date.now() - start,
      error: error?.message || String(error),
    };
  }
}

async function pingSupabaseRest() {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('driver_locations')
    .select('phone')
    .limit(1);
  if (error) throw new Error(error.message);
  return { rows: (data || []).length };
}

async function loadOnlineDrivers(limit = 200) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('driver_locations')
    .select('phone, driver_name, taxi_type, is_online, available, updated_at, location_updated_at')
    .eq('is_online', true)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

async function inspectDriver(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const variants = getPhoneVariants(phoneKey);
  const supabase = assertSupabaseAdmin();

  const [locRes, statusRes, tokens] = await Promise.all([
    supabase
      .from('driver_locations')
      .select('*')
      .in('phone', variants)
      .maybeSingle(),
    supabase
      .from('taxi_driver_status')
      .select('*')
      .in('phone', variants)
      .maybeSingle(),
    getDeviceTokensForPhone(phoneKey),
  ]);

  const loc = locRes.data;
  const status = statusRes.data;
  const tokenCount = (tokens || []).filter((t) => String(t.token || '').trim()).length;

  return {
    inputPhone: phone,
    phoneKey,
    driver_locations: loc
      ? {
          is_online: loc.is_online,
          available: loc.available,
          updated_at: loc.updated_at,
          location_updated_at: loc.location_updated_at,
          taxi_type: loc.taxi_type,
          driver_name: loc.driver_name,
        }
      : null,
    taxi_driver_status: status
      ? { is_online: status.is_online, updated_at: status.updated_at }
      : null,
    pushTokens: {
      count: tokenCount,
      platforms: [...new Set((tokens || []).map((t) => String(t.platform || 'unknown')))],
    },
    wouldAcceptOnline: tokenCount > 0,
  };
}

function ageMinutes(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 60_000);
}

async function main() {
  const targetPhone = parsePhoneArg();
  console.log('=== Hira taxi / Supabase health ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Supabase host: ${String(process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('/')[0] || '—'}`);
  console.log('');

  const results = [];
  results.push(await timed('supabase ping (driver_locations limit 1)', pingSupabaseRest));
  results.push(await timed('supabase ping #2 (warm)', pingSupabaseRest));
  results.push(await timed('resolvePhoneKey cache miss (07700000001)', () => resolvePhoneKey('07700000001')));
  results.push(await timed('resolvePhoneKey cache hit (07700000001)', () => resolvePhoneKey('07700000001')));
  results.push(await timed('online drivers query', () => loadOnlineDrivers()));
  console.log('--- Latency probes ---');
  for (const row of results) {
    if (row.ok) {
      console.log(`  OK  ${String(row.ms).padStart(5)}ms  ${row.label}`);
    } else {
      console.log(`  FAIL ${String(row.ms).padStart(5)}ms  ${row.label}`);
      console.log(`       ${row.error}`);
    }
  }
  console.log('');

  const onlineResult = results.find((r) => r.label === 'online drivers query');
  if (!onlineResult?.ok) {
    console.error('Could not load online drivers.');
    process.exit(1);
  }

  const online = onlineResult.result;
  let missingPush = 0;
  let stale15m = 0;
  let stale60m = 0;
  const sampleMissing = [];
  const sampleStale = [];

  for (const row of online) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    const tokens = await getDeviceTokensForPhone(phone);
    const hasToken = (tokens || []).some((t) => String(t.token || '').trim());
    if (!hasToken) {
      missingPush += 1;
      if (sampleMissing.length < 5) {
        sampleMissing.push({
          phone,
          name: row.driver_name || '—',
          updated_at: row.updated_at,
        });
      }
    }
    const age = ageMinutes(row.location_updated_at || row.updated_at);
    if (age != null && age >= 15) {
      stale15m += 1;
      if (sampleStale.length < 5) {
        sampleStale.push({ phone, name: row.driver_name || '—', ageMin: age });
      }
    }
    if (age != null && age >= 60) stale60m += 1;
  }

  console.log('--- Online drivers snapshot ---');
  console.log(`  Total is_online=true: ${online.length}`);
  console.log(`  Missing FCM token (would fail driver-status): ${missingPush}`);
  console.log(`  Location/status stale >= 15 min: ${stale15m}`);
  console.log(`  Location/status stale >= 60 min: ${stale60m}`);

  if (sampleMissing.length) {
    console.log('');
    console.log('  Sample online but NO push token:');
    for (const row of sampleMissing) {
      console.log(`    - ${row.phone} (${row.name}) updated=${row.updated_at || '—'}`);
    }
  }

  if (sampleStale.length) {
    console.log('');
    console.log('  Sample stale location (>=15m):');
    for (const row of sampleStale) {
      console.log(`    - ${row.phone} (${row.name}) ~${row.ageMin}m ago`);
    }
  }

  if (targetPhone) {
    console.log('');
    console.log(`--- Driver lookup: ${targetPhone} ---`);
    const detail = await inspectDriver(targetPhone);
    console.log(JSON.stringify(detail, null, 2));
  } else {
    console.log('');
    console.log('Tip: pass --phone=07XXXXXXXXX to inspect one captain.');
  }

  const pingFailed = results.some((r) => r.label.includes('ping') && !r.ok);
  const slowPing = results.find((r) => r.label.includes('ping') && r.ok && r.ms > 5000);
  if (pingFailed || slowPing) {
    console.log('');
    console.log('WARNING: Supabase latency or errors detected — this matches upstream timeout / offline symptoms.');
    process.exit(2);
  }

  console.log('');
  console.log('OK: Supabase reachable; no critical latency on ping.');
}

main().catch((error) => {
  console.error('Fatal:', error?.message || error);
  process.exit(1);
});
