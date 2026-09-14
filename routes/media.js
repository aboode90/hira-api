const express = require('express');
const router = express.Router();
const {
  decodeBase64Image,
  uploadMediaWithVariants,
  getOwnerMediaGrouped,
} = require('../services/media_service');
const { pickVariantUrl } = require('../supabase_repo/media_assets');
const { requireAuthorizedPhone } = require('./_middleware');
const { resolvePhoneKey } = require('../supabase_repo/common');
const { phonesOverlap } = require('../supabase_repo/common');

const { getAdminRole } = require('../supabase_repo/admin_roles');

async function resolveAuthorizedOwnerId(authPhone, requestedOwnerId) {
  const authKey = await resolvePhoneKey(authPhone);
  const ownerId = String(requestedOwnerId || authKey).trim();
  
  // Allow admins to upload for anyone
  const adminRole = await getAdminRole(authKey);
  if (adminRole) {
    return resolvePhoneKey(ownerId);
  }

  if (!phonesOverlap(authKey, ownerId)) {
    throw new Error('Unauthorized media owner.');
  }
  return resolvePhoneKey(ownerId);
}

router.post('/media/upload', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;

    const base64 = req.body?.imageBase64 ?? req.body?.image_base64 ?? req.body?.data;
    const buffer = decodeBase64Image(base64);
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ message: 'Valid image base64 is required.' });
    }

    const ownerType = String(req.body?.ownerType ?? req.body?.owner_type ?? 'user').trim();
    const ownerId = await resolveAuthorizedOwnerId(
      phone,
      req.body?.ownerId ?? req.body?.owner_id
    );

    const result = await uploadMediaWithVariants({
      phone,
      buffer,
      ownerType,
      ownerId,
      role: String(req.body?.role ?? 'gallery').trim(),
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('media upload error:', error);
    const status = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to upload media.' });
  }
});

router.get('/media/assets', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const ownerType = String(req.query?.ownerType ?? req.query?.owner_type ?? 'user').trim();
    const ownerId = await resolveAuthorizedOwnerId(
      phone,
      req.query?.ownerId ?? req.query?.owner_id
    );
    const role = String(req.query?.role ?? '').trim();
    const grouped = await getOwnerMediaGrouped(ownerType, ownerId, role || null);
    const preferred = String(req.query?.variant ?? '256').trim();
    return res.json({
      assets: grouped,
      url: role ? pickVariantUrl(grouped[role], preferred) : grouped,
    });
  } catch (error) {
    console.error('media assets error:', error);
    const status = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to load media assets.' });
  }
});

module.exports = router;
