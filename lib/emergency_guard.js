const crypto = require('crypto');

function isEmergencyRoutesEnabled() {
  return String(process.env.ENABLE_EMERGENCY_ROUTES || '')
    .trim()
    .toLowerCase() === 'true';
}

function requireEmergencyApiKey(req, res, next) {
  if (!isEmergencyRoutesEnabled()) {
    return res.status(404).json({ message: 'Not found.' });
  }

  const expected = String(process.env.EMERGENCY_API_KEY || '').trim();
  if (!expected) {
    return res.status(503).json({ message: 'Emergency routes are not configured.' });
  }

  const provided = String(
    req.headers['x-emergency-key'] || req.query?.key || ''
  ).trim();

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return res.status(403).json({ message: 'Forbidden.' });
  }

  return next();
}

module.exports = {
  isEmergencyRoutesEnabled,
  requireEmergencyApiKey,
};
