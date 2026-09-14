#!/usr/bin/env node
/**
 * يهاجر صور Base64 المضمّنة في driver_profiles.profile_payload إلى R2
 * ويستبدلها بروابط عامة — يقلّص الحمولات (كانت تصل 2.4MB) ويُسرّع الاستعلامات.
 *
 * Usage:
 *   node scripts/migrate_driver_profiles_images.js --dry-run
 *   node scripts/migrate_driver_profiles_images.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { isBase64Image } = require('../services/image_refs');
const { isR2Configured, uploadBufferToR2 } = require('../services/r2_storage');

const IMAGE_FIELDS = [
  'profileImage',
  'carImage',
  'idFrontImage',
  'idBackImage',
  'residenceCardImage',
  'vehicleRegFrontImage',
  'vehicleRegBackImage',
];

function decodeBase64Payload(value) {
  let payload = String(value || '').trim();
  if (!payload) return null;
  if (payload.includes('base64,')) payload = payload.split('base64,').pop();
  try {
    const buffer = Buffer.from(payload, 'base64');
    return buffer.length ? buffer : null;
  } catch (_) {
    return null;
  }
}

function mimeFromBase64(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('iVBOR')) return 'image/png';
  if (trimmed.startsWith('/9j/')) return 'image/jpeg';
  if (trimmed.startsWith('R0lG')) return 'image/gif';
  if (trimmed.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'jpg';
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  console.log('R2 configured:', isR2Configured(), '→', process.env.R2_PUBLIC_BASE_URL || '(unset)');

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error } = await supabase
    .from('driver_profiles')
    .select('phone, profile_payload');
  if (error) throw error;

  let migrated = 0;
  let images = 0;
  const touched = [];

  for (const row of rows || []) {
    const payload = row.profile_payload || {};
    const next = { ...payload };
    let changed = false;

    for (const field of IMAGE_FIELDS) {
      const value = String(next[field] || '').trim();
      if (!value || !isBase64Image(value)) continue;

      const buffer = decodeBase64Payload(value);
      if (!buffer) continue;
      const mime = mimeFromBase64(value);
      const ext = extFromMime(mime);
      const safePhone = String(row.phone || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const objectPath = `migrated/driver/${safePhone}/${field}.${ext}`;

      if (dryRun) {
        console.log(`[dry-run] ${row.phone} ${field} -> ${objectPath} (${Math.round(value.length / 1024)}KB)`);
      } else {
        const publicUrl = await uploadBufferToR2({ objectPath: `uploads/${objectPath}`, buffer, contentType: mime });
        next[field] = publicUrl;
        console.log(`migrated ${row.phone} ${field} -> ${publicUrl}`);
        images += 1;
      }
      changed = true;
    }

    if (!changed) continue;
    touched.push(row.phone);
    if (!dryRun) {
      const { error: updErr } = await supabase
        .from('driver_profiles')
        .update({ profile_payload: next, updated_at: new Date().toISOString() })
        .eq('phone', row.phone);
      if (updErr) throw updErr;
      migrated += 1;
    }
  }

  console.log(JSON.stringify({ dryRun, driversTouched: touched.length, imagesMigrated: images, migrated }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
