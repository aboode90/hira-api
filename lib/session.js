const crypto = require('crypto');
const { normalizePhone } = require('../routes/_middleware');

function base64UrlDecode(input) {
  const normalized = String(input || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(input || '').length / 4) * 4, '=');
  return Buffer.from(normalized, 'base64');
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * @param {string} token - The HMAC-signed session token
 * @param {string} [secret] - The secret key (defaults to SESSION_SECRET env var)
 * @returns {{phone: string, exp: number}}
 * @throws {Error} If token is invalid or expired
 */
function verifySessionToken(token, secret) {
  const resolvedSecret = secret || String(process.env.SESSION_SECRET || '').trim();
  if (!resolvedSecret) {
    throw new Error('SESSION_SECRET is not configured.');
  }

  const [encodedPayload, encodedSignature] = String(token || '').split('.');
  if (!encodedPayload || !encodedSignature) {
    throw new Error('Missing token payload or signature.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', resolvedSecret)
    .update(encodedPayload)
    .digest();
  const actualSignature = base64UrlDecode(encodedSignature);

  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error('Invalid token signature.');
  }

  const payloadText = base64UrlDecode(encodedPayload).toString('utf8');
  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch (_) {
    throw new Error('Invalid token payload.');
  }

  const phone = normalizePhone(payload?.phone);
  const exp = Number(payload?.exp || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!phone || !exp || exp <= now) {
    throw new Error('Token expired or invalid.');
  }

  // توكنات Cloudflare Worker القديمة لا تتضمن se — لا تُعامل كـ 0 ملغى.
  const hasSe = Object.prototype.hasOwnProperty.call(payload || {}, 'se');
  return {
    phone,
    exp,
    se: hasSe ? Number(payload.se || 0) : null,
    hasSe,
    typ: String(payload?.typ || 'session'),
    staffId: String(payload?.staffId || ''),
    role: String(payload?.role || ''),
    dept: String(payload?.dept || ''),
    name: String(payload?.name || ''),
  };
}

module.exports = {
  base64UrlDecode,
  base64UrlEncode,
  verifySessionToken,
};
