const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY
  );
}

function getR2Client() {
  if (!isR2Configured()) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function getR2BucketName() {
  return String(process.env.R2_BUCKET_NAME || 'alghaith-images').trim();
}

function getR2PublicBaseUrl() {
  return String(process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

function shouldUseMediaPrefix(baseUrl) {
  const trimmed = String(baseUrl || '').trim();
  return trimmed.includes('workers.dev');
}

function buildR2PublicUrl(objectPath) {
  const base = getR2PublicBaseUrl();
  if (!base) {
    throw new Error('R2_PUBLIC_BASE_URL is required for public image URLs.');
  }
  const path = String(objectPath || '').replace(/^\/+/, '');
  return shouldUseMediaPrefix(base) ? `${base}/media/${path}` : `${base}/${path}`;
}

function isSupabaseStorageUrl(value) {
  const trimmed = String(value || '').trim();
  return trimmed.includes('.supabase.co/storage/v1/object/');
}

function isWorkerMediaUrl(value) {
  const trimmed = String(value || '').trim();
  return trimmed.includes('.workers.dev/media/');
}

function isR2PublicUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith('http')) return false;
  const base = getR2PublicBaseUrl();
  if (base && trimmed.startsWith(base)) return true;
  return isWorkerMediaUrl(trimmed);
}

async function uploadJsonToR2({ objectPath, data, cacheControl }) {
  const json = JSON.stringify(data);
  const buffer = Buffer.from(json, 'utf8');
  const client = getR2Client();
  if (!client) {
    throw new Error('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).');
  }

  await client.send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: objectPath,
      Body: buffer,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: cacheControl || 'public, max-age=120, s-maxage=300',
    })
  );

  const base = getR2PublicBaseUrl();
  if (!base) {
    return objectPath;
  }
  const path = String(objectPath || '').replace(/^\/+/, '');
  return `${base}/${path}`;
}

async function uploadBufferToR2({ objectPath, buffer, contentType }) {
  const client = getR2Client();
  if (!client) {
    throw new Error('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).');
  }

  await client.send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: objectPath,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return buildR2PublicUrl(objectPath);
}

function extractR2ObjectKeyFromPublicUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed.startsWith('http')) return null;
  try {
    const base = getR2PublicBaseUrl();
    const parsed = new URL(trimmed);
    let path = parsed.pathname.replace(/^\/+/, '');
    if (shouldUseMediaPrefix(base) && path.startsWith('media/')) {
      path = path.slice('media/'.length);
    }
    if (path.startsWith('media/')) return path;
    if (base && trimmed.startsWith(base)) {
      return path;
    }
  } catch (_) {}
  return null;
}

async function deleteR2Object(objectPath) {
  const client = getR2Client();
  const key = String(objectPath || '').trim().replace(/^\/+/, '');
  if (!client || !key) return false;
  await client.send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: key,
    })
  );
  return true;
}

async function deleteR2ObjectsByUrl(url) {
  const key = extractR2ObjectKeyFromPublicUrl(url);
  if (!key) return;
  const folder = key.replace(/\/(original|256|512|thumbnail)\.webp$/i, '');
  const keys = [
    key,
    `${folder}/original.webp`,
    `${folder}/256.webp`,
    `${folder}/512.webp`,
    `${folder}/thumbnail.webp`,
  ];
  const unique = [...new Set(keys)];
  for (const item of unique) {
    try {
      await deleteR2Object(item);
    } catch (error) {
      console.warn('deleteR2Object:', item, error?.message || error);
    }
  }
}

module.exports = {
  isR2Configured,
  getR2PublicBaseUrl,
  buildR2PublicUrl,
  isSupabaseStorageUrl,
  isR2PublicUrl,
  isWorkerMediaUrl,
  uploadJsonToR2,
  uploadBufferToR2,
  extractR2ObjectKeyFromPublicUrl,
  deleteR2Object,
  deleteR2ObjectsByUrl,
};
