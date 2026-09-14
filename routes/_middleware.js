/**
 * Shared middleware and utilities for route handlers.
 */

const { phonesOverlap } = require('../supabase_repo/common');

/**
 * Normalize an Iraqi phone number to international format (964...).
 */
function normalizePhone(phone) {
  const raw = String(phone || '').trim().replace(/[\s-]/g, '');
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (digits === '000000000') {
    return '9647000000000';
  }
  if (digits.startsWith('0')) {
    return `964${digits.slice(1)}`;
  }
  if (digits.startsWith('964')) {
    return digits;
  }
  return `964${digits}`;
}

/**
 * Extract a single string value from req.query, handling arrays.
 */
function parseQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Read the requested phone number from the request (query for GET/DELETE, body otherwise).
 */
function readRequestedPhone(req) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    return String(parseQueryValue(req.query.phone) || '').trim();
  }
  return String(req.body?.phone || '').trim();
}

/**
 * Middleware that verifies the requested phone matches the authenticated phone.
 * Returns the normalized phone or null (having already sent an error response).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {string|null}
 */
function requireAuthorizedPhone(req, res, { allowMissing = false } = {}) {
  const requestedPhone = normalizePhone(readRequestedPhone(req));
  if (!requestedPhone) {
    if (allowMissing) {
      return req.authPhone;
    }
    res.status(400).json({ message: 'Phone number is required.' });
    return null;
  }

  const authPhone = String(req.authPhone || '').trim();
  // قارن بكل صيغ الرقم العراقية — لا ترفض بسبب +964 مقابل 964.
  if (authPhone &&
      requestedPhone !== authPhone &&
      !phonesOverlap(requestedPhone, authPhone)) {
    res.status(403).json({ message: 'You are not allowed to access this phone number.' });
    return null;
  }

  // استخدم رقم الجلسة كمرجع موحّد لحفظ التوكن وغيرها.
  return authPhone || requestedPhone;
}

/**
 * Like requireAuthorizedPhone but allows missing phone (falls back to req.authPhone).
 */
function requireOptionalAuthorizedPhone(req, res) {
  return requireAuthorizedPhone(req, res, { allowMissing: true });
}

/**
 * جلسة مصادَقة + صلاحية أدمن (assertAdminAccess).
 * استخدمه لمسارات /admin/* بدل الاعتماد على الفحص داخل الـ repo فقط.
 * @returns {Promise<string|null>}
 */
async function requireAdminAccess(req, res) {
  const phone = requireOptionalAuthorizedPhone(req, res);
  if (!phone) return null;
  try {
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    return phone;
  } catch (error) {
    const message = error?.message || 'Admin access required.';
    res.status(403).json({ message });
    return null;
  }
}

/**
 * Verify Bearer session token and set req.authPhone (for routes outside /db).
 * @returns {string|null}
 */
function authenticateBearerSession(req, res) {
  if (req.authPhone) {
    return req.authPhone;
  }

  const authorization = String(req.headers.authorization || '').trim();
  if (!authorization.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing authorization token.' });
    return null;
  }

  try {
    const { verifySessionToken } = require('../lib/session');
    const token = authorization.slice('Bearer '.length).trim();
    const session = verifySessionToken(token);
    req.authPhone = session.phone;
    req.authSessionExpiresAt = session.exp;
    return req.authPhone;
  } catch (error) {
    res.status(401).json({
      message: error?.message || 'Invalid authorization token.',
    });
    return null;
  }
}

module.exports = {
  normalizePhone,
  parseQueryValue,
  readRequestedPhone,
  requireAuthorizedPhone,
  requireOptionalAuthorizedPhone,
  requireAdminAccess,
  authenticateBearerSession,
};
