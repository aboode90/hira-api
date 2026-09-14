const { v4: uuidv4 } = require('uuid');
const { generateImageVariants } = require('./image_variants');
const { uploadBufferToR2, isR2Configured } = require('./r2_storage');
const { upsertMediaVariant, listMediaAssets, groupAssetsByRole } = require('../supabase_repo/media_assets');
const { resolvePhoneKey } = require('../supabase_repo/common');
const { ensureAppUser } = require('../supabase_repo/users');

function decodeBase64Image(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const payload = raw.includes('base64,') ? raw.split('base64,').pop() : raw;
  try {
    return Buffer.from(payload, 'base64');
  } catch (_) {
    return null;
  }
}

async function uploadMediaWithVariants({
  phone,
  buffer,
  ownerType = 'user',
  ownerId,
  role = 'gallery',
}) {
  if (!isR2Configured()) {
    throw new Error('R2 is not configured for media uploads.');
  }
  const phoneKey = await resolvePhoneKey(phone);
  await ensureAppUser(phoneKey);
  const resolvedOwnerId = String(ownerId || phoneKey).trim();
  const assetId = uuidv4();
  const variants = await generateImageVariants(buffer);
  const urls = {};

  for (const [variant, meta] of Object.entries(variants)) {
    const objectPath = `media/${ownerType}/${resolvedOwnerId}/${role}/${assetId}/${variant}.webp`;
    const url = await uploadBufferToR2({
      objectPath,
      buffer: meta.buffer,
      contentType: 'image/webp',
    });
    urls[variant] = url;
    await upsertMediaVariant({
      assetId: uuidv4(),
      ownerType,
      ownerId: resolvedOwnerId,
      role,
      variant,
      url,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes ?? meta.buffer?.length,
    });
  }

  return {
    assetId,
    ownerType,
    ownerId: resolvedOwnerId,
    role,
    urls,
    url: urls['256'] || urls.thumbnail || urls.original,
    original: urls.original,
    w512: urls['512'],
    w256: urls['256'],
    thumb: urls.thumbnail,
  };
}

async function getOwnerMediaGrouped(ownerType, ownerId, role) {
  const rows = await listMediaAssets(ownerType, ownerId, role);
  return groupAssetsByRole(rows);
}

module.exports = {
  decodeBase64Image,
  uploadMediaWithVariants,
  getOwnerMediaGrouped,
};
