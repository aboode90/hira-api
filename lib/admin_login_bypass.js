const crypto = require('crypto');

const MIN_SECRET_LENGTH = 16;

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/** يطبّع رقم الهاتف إلى صيغة 964… للمقارنة مع قائمة السماح */
function normalizeBypassPhone(phone) {
  let digits = digitsOnly(phone);
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 10) {
    digits = `964${digits.slice(1)}`;
  } else if (digits.length === 10 && digits.startsWith('7')) {
    digits = `964${digits}`;
  }
  return digits;
}

function parsePhoneAllowlist(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((part) => normalizeBypassPhone(part))
    .filter(Boolean);
}

function timingSafeEqualString(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * تجاوز OTP اختياري للإدارة — يعمل فقط إذا ضُبط السر وقائمة الهواتف في البيئة.
 * بدون ADMIN_LOGIN_BYPASS_SECRET أو ADMIN_LOGIN_BYPASS_PHONES → معطّل تماماً.
 */
function matchesAdminLoginBypass(phone, code, env = process.env) {
  const secret = String(env.ADMIN_LOGIN_BYPASS_SECRET || '').trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return false;
  }

  const allowlist = parsePhoneAllowlist(env.ADMIN_LOGIN_BYPASS_PHONES);
  if (allowlist.length === 0) {
    return false;
  }

  const normalizedPhone = normalizeBypassPhone(phone);
  if (!normalizedPhone || !allowlist.includes(normalizedPhone)) {
    return false;
  }

  const provided = String(code || '').trim();
  if (!provided) return false;

  return timingSafeEqualString(provided, secret);
}

function isAdminLoginBypassConfigured(env = process.env) {
  const secret = String(env.ADMIN_LOGIN_BYPASS_SECRET || '').trim();
  const phones = parsePhoneAllowlist(env.ADMIN_LOGIN_BYPASS_PHONES);
  return secret.length >= MIN_SECRET_LENGTH && phones.length > 0;
}

module.exports = {
  MIN_SECRET_LENGTH,
  normalizeBypassPhone,
  parsePhoneAllowlist,
  timingSafeEqualString,
  matchesAdminLoginBypass,
  isAdminLoginBypassConfigured,
};
