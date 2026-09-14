#!/usr/bin/env node
/**
 * ينقل صور Base64 أو Supabase Storage إلى Cloudflare R2 ويحدّث السجلات بروابط عامة.
 *
 * Usage:
 *   node scripts/migrate_base64_images_to_storage.js
 *   node scripts/migrate_base64_images_to_storage.js --dry-run
 *   node scripts/migrate_supabase_storage_to_r2.js --dry-run
 *
 * R2 env (backend/.env):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME=alghaith-images
 *   R2_PUBLIC_BASE_URL=https://lively-wind-9d98.alghaithapp.workers.dev
 *     أو https://cdn.alghaithst.com بعد ربط الدومين
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const {
  isRemoteImageUrl,
  isBase64Image,
} = require('../services/image_refs');
const {
  isR2Configured,
  isSupabaseStorageUrl,
  isR2PublicUrl,
  uploadBufferToR2,
} = require('../services/r2_storage');

function normalizeSupabaseUrl(url) {
  let normalized = String(url || '').trim();
  if (normalized.endsWith('/rest/v1/')) {
    normalized = normalized.slice(0, -'/rest/v1/'.length);
  } else if (normalized.endsWith('/rest/v1')) {
    normalized = normalized.slice(0, -'/rest/v1'.length);
  }
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function decodeBase64Payload(value) {
  let payload = String(value || '').trim();
  if (!payload) return null;
  if (payload.includes('base64,')) {
    payload = payload.split('base64,').pop();
  }
  try {
    const buffer = Buffer.from(payload, 'base64');
    if (!buffer.length) return null;
    return buffer;
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
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'jpg';
  }
}

function guessMimeFromUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

async function uploadBufferToSupabase({ supabaseUrl, serviceKey, bucket, objectPath, buffer, contentType }) {
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'Content-Type': contentType,
      'x-upsert': 'true',
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase upload failed (${response.status}): ${text}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
}

async function uploadImageBuffer({
  supabaseUrl,
  serviceKey,
  bucket,
  objectPath,
  buffer,
  contentType,
}) {
  if (isR2Configured()) {
    return uploadBufferToR2({ objectPath: `${bucket}/${objectPath}`, buffer, contentType });
  }
  return uploadBufferToSupabase({
    supabaseUrl,
    serviceKey,
    bucket,
    objectPath,
    buffer,
    contentType,
  });
}

async function downloadRemoteImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || guessMimeFromUrl(url);
  return { buffer, contentType };
}

async function migrateRemoteUrl({
  supabaseUrl,
  serviceKey,
  sourceUrl,
  objectPath,
  dryRun,
}) {
  if (isR2PublicUrl(sourceUrl)) return { status: 'skipped', url: sourceUrl };
  if (!isSupabaseStorageUrl(sourceUrl) && !isRemoteImageUrl(sourceUrl)) {
    return { status: 'skipped', url: sourceUrl };
  }

  if (dryRun) {
    console.log(`[dry-run] migrate ${sourceUrl} -> uploads/${objectPath}`);
    return { status: 'dry-run', url: sourceUrl };
  }

  const { buffer, contentType } = await downloadRemoteImage(sourceUrl);
  const publicUrl = await uploadImageBuffer({
    supabaseUrl,
    serviceKey,
    bucket: 'uploads',
    objectPath,
    buffer,
    contentType,
  });
  return { status: 'migrated', url: publicUrl };
}

async function migrateProductRow({
  supabase,
  supabaseUrl,
  serviceKey,
  row,
  dryRun,
}) {
  const current = String(row.image_base64 || '').trim();
  const imageField = String(row.image || '').trim();

  if (isBase64Image(current) && !isRemoteImageUrl(current)) {
    const buffer = decodeBase64Payload(current);
    if (!buffer) return 'invalid';

    const mime = mimeFromBase64(current);
    const ext = extFromMime(mime);
    const objectPath = `migrated/products/${row.id}.${ext}`;

    if (dryRun) {
      console.log(`[dry-run] product ${row.id}: upload ${objectPath}`);
      return 'dry-run';
    }

    const publicUrl = await uploadImageBuffer({
      supabaseUrl,
      serviceKey,
      bucket: 'uploads',
      objectPath,
      buffer,
      contentType: mime,
    });

    await supabase
      .from('merchant_products')
      .update({ image: publicUrl, image_base64: null })
      .eq('id', row.id);
    return 'migrated';
  }

  const sourceUrl = isSupabaseStorageUrl(imageField)
    ? imageField
    : isSupabaseStorageUrl(current)
      ? current
      : '';

  if (sourceUrl && isSupabaseStorageUrl(sourceUrl) && !isR2PublicUrl(sourceUrl)) {
    const ext = extFromMime(guessMimeFromUrl(sourceUrl));
    const objectPath = `migrated/products/${row.id}.${ext}`;
    const result = await migrateRemoteUrl({
      supabaseUrl,
      serviceKey,
      sourceUrl,
      objectPath,
      dryRun,
    });
    if (result.status === 'migrated') {
      await supabase
        .from('merchant_products')
        .update({ image: result.url, image_base64: null })
        .eq('id', row.id);
    }
    return result.status;
  }

  const imageUrl = isRemoteImageUrl(imageField)
    ? imageField
    : isRemoteImageUrl(current)
      ? current
      : '';
  if (imageUrl && row.image !== imageUrl) {
    if (dryRun) {
      console.log(`[dry-run] product ${row.id}: normalize image URL`);
      return 'normalized';
    }
    await supabase
      .from('merchant_products')
      .update({ image: imageUrl, image_base64: null })
      .eq('id', row.id);
    return 'normalized';
  }

  return 'skipped';
}

async function migrateProfileField({
  supabase,
  supabaseUrl,
  serviceKey,
  phone,
  fieldName,
  value,
  dryRun,
}) {
  const current = String(value || '').trim();
  if (!current) return 'skipped';

  const safePhone = String(phone || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

  if (isBase64Image(current) && !isRemoteImageUrl(current)) {
    const buffer = decodeBase64Payload(current);
    if (!buffer) return 'invalid';

    const mime = mimeFromBase64(current);
    const ext = extFromMime(mime);
    const objectPath = `migrated/profiles/${safePhone}/${fieldName}.${ext}`;

    if (dryRun) {
      console.log(`[dry-run] profile ${phone}: ${fieldName} -> ${objectPath}`);
      return 'dry-run';
    }

    const publicUrl = await uploadImageBuffer({
      supabaseUrl,
      serviceKey,
      bucket: 'uploads',
      objectPath,
      buffer,
      contentType: mime,
    });

    const update =
      fieldName === 'profile_image'
        ? { profile_image_base64: publicUrl }
        : { [`${fieldName}_url`]: publicUrl };

    await supabase.from('merchant_profiles').update(update).eq('phone', phone);
    return 'migrated';
  }

  if (isSupabaseStorageUrl(current) && !isR2PublicUrl(current)) {
    const ext = extFromMime(guessMimeFromUrl(current));
    const objectPath = `migrated/profiles/${safePhone}/${fieldName}.${ext}`;
    const result = await migrateRemoteUrl({
      supabaseUrl,
      serviceKey,
      sourceUrl: current,
      objectPath,
      dryRun,
    });
    if (result.status === 'migrated') {
      const update =
        fieldName === 'profile_image'
          ? { profile_image_base64: result.url }
          : { [`${fieldName}_url`]: result.url };
      await supabase.from('merchant_profiles').update(update).eq('phone', phone);
    }
    return result.status;
  }

  return 'skipped';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : 0;

  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  if (!isR2Configured()) {
    console.warn('R2 not configured — uploads will go to Supabase Storage.');
  } else {
    console.log('R2 configured — new URLs will use:', process.env.R2_PUBLIC_BASE_URL || '(set R2_PUBLIC_BASE_URL)');
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let productQuery = supabase
    .from('merchant_products')
    .select('id, image, image_base64')
    .order('created_at', { ascending: false });
  if (limit > 0) productQuery = productQuery.limit(limit);

  const { data: products, error: productsError } = await productQuery;
  if (productsError) throw productsError;

  const stats = { migrated: 0, normalized: 0, skipped: 0, invalid: 0, dryRun: 0 };

  for (const row of products || []) {
    const result = await migrateProductRow({
      supabase,
      supabaseUrl,
      serviceKey,
      row,
      dryRun,
    });
    stats[result] = (stats[result] || 0) + 1;
  }

  let profileQuery = supabase
    .from('merchant_profiles')
    .select('phone, profile_image_base64, cover_image_url, logo_image_url');
  if (limit > 0) profileQuery = profileQuery.limit(limit);

  const { data: profiles, error: profilesError } = await profileQuery;
  if (profilesError) throw profilesError;

  for (const profile of profiles || []) {
    for (const [field, value] of [
      ['profile_image', profile.profile_image_base64],
      ['cover_image', profile.cover_image_url],
      ['logo_image', profile.logo_image_url],
    ]) {
      const result = await migrateProfileField({
        supabase,
        supabaseUrl,
        serviceKey,
        phone: profile.phone,
        fieldName: field,
        value,
        dryRun,
      });
      stats[result] = (stats[result] || 0) + 1;
    }
  }

  console.log(JSON.stringify({ dryRun, stats }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
