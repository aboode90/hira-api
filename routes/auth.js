const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.default || rateLimitLib;
const ipKeyGenerator = rateLimitLib.ipKeyGenerator || ((ip) => ip);
const {
  ensurePlatformAdminAccess,
  ensureAppUser,
} = require('../supabase_repo');
const {
  normalizePhone,
  requireOptionalAuthorizedPhone,
} = require('./_middleware');
const { matchesAdminLoginBypass } = require('../lib/admin_login_bypass');
const { resolvePhoneKey, canonicalPhone } = require('../supabase_repo/common');
const { getSessionGate, isAccountSuspended, bumpSessionEpoch } = require('../lib/session_gate');

const ISSUE_SESSION_BUDGET_MS = 4_000;

// ── Config ──────────────────────────────────────────────────────────────
const otpiqApiKey = process.env.OTPIQ_API_KEY;
const otpiqBaseUrl = (process.env.OTPIQ_BASE_URL || 'https://api.otpiq.com').replace(/\/$/, '');
const otpiqSmsProvider = process.env.OTPIQ_SMS_PROVIDER || 'sms';
const otpiqWhatsappProvider = process.env.OTPIQ_WHATSAPP_PROVIDER || 'whatsapp';
const otpiqTelegramProvider = process.env.OTPIQ_TELEGRAM_PROVIDER || 'telegram';
const otpTtlMs = Number.parseInt(process.env.OTP_TTL_MS || '300000', 10);
const parsedOtpLength = Number.parseInt(process.env.OTP_LENGTH || '6', 10);
const otpLength =
  Number.isInteger(parsedOtpLength) && parsedOtpLength >= 4 && parsedOtpLength <= 8
    ? parsedOtpLength
    : 6;
const sessionSecret = String(process.env.SESSION_SECRET || '').trim();

const APPLE_REVIEW_CODE = '123456';

// ── OTP storage (Redis عند التوفر + ذاكرة محلية كاحتياط) ───────────────
const pendingOtps = new Map();
const { withRedis } = require('../lib/redis_client');

function otpRedisKey(phone) {
  return `auth:otp:${phone}`;
}

async function savePendingOtp(phone, entry) {
  pendingOtps.set(phone, entry);
  const ttlSeconds = Math.max(
    1,
    Math.ceil((Number(entry.expiresAt || Date.now()) - Date.now()) / 1000),
  );
  await withRedis(async (client) => {
    await client.set(otpRedisKey(phone), JSON.stringify(entry), 'EX', ttlSeconds);
  });
}

async function readPendingOtp(phone) {
  const fromRedis = await withRedis(async (client) => client.get(otpRedisKey(phone)), null);
  if (fromRedis) {
    try {
      const parsed = JSON.parse(fromRedis);
      if (parsed?.code && Number(parsed.expiresAt || 0) > Date.now()) {
        pendingOtps.set(phone, parsed);
        return parsed;
      }
    } catch (_) {}
  }
  const local = pendingOtps.get(phone);
  if (local && Number(local.expiresAt || 0) > Date.now()) return local;
  if (local) pendingOtps.delete(phone);
  return null;
}

async function clearPendingOtp(phone) {
  pendingOtps.delete(phone);
  await withRedis(async (client) => {
    await client.del(otpRedisKey(phone));
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function normalizePhoneForDisplay(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `+${normalized}` : '';
}

function isAppleReviewPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  if (
    digits === '000000000' ||
    digits === '07000000000' ||
    digits === '96400000000' ||
    digits === '9647000000000' ||
    digits === '7000000000'
  ) {
    return true;
  }
  return digits.endsWith('000000000') && digits.replace(/0/g, '').length <= 2;
}

function generateOtp() {
  const upperBound = 10 ** otpLength;
  const lowerBound = 10 ** (otpLength - 1);
  return String(crypto.randomInt(lowerBound, upperBound));
}

function cleanupExpiredOtps() {
  const now = Date.now();
  for (const [phone, entry] of pendingOtps.entries()) {
    if (entry.expiresAt <= now) {
      pendingOtps.delete(phone);
    }
  }
}

function resolveOtpiqProvider(channel = 'sms') {
  const normalizedChannel = String(channel || 'sms').trim().toLowerCase();
  if (normalizedChannel === 'whatsapp') {
    return otpiqWhatsappProvider;
  }
  if (normalizedChannel === 'telegram') {
    return otpiqTelegramProvider;
  }
  return otpiqSmsProvider;
}

async function sendOtpViaOtpiq(phoneNumber, verificationCode, channel = 'sms') {
  if (!otpiqApiKey) {
    throw new Error('OTPIQ_API_KEY is not configured.');
  }

  const provider = resolveOtpiqProvider(channel);

  const response = await fetch(`${otpiqBaseUrl}/api/sms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${otpiqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phoneNumber,
      smsType: 'verification',
      provider,
      verificationCode,
    }),
  });

  const bodyText = await response.text();
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    payload = null;
  }

  console.log('OTPIQ request payload:', JSON.stringify({ phoneNumber, smsType: 'verification', provider }));
  console.log('OTPIQ response status:', response.status);
  if (!response.ok) {
    console.log('OTPIQ response body:', bodyText);
  }
  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      bodyText ||
      `OTPIQ request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

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

function createSessionToken(phone, se = 0) {
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is not configured.');
  }

  const payload = {
    phone: normalizePhone(phone),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    se,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(encodedPayload)
    .digest();
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function issueSessionToken(phone) {
  const normalized = normalizePhone(phone);
  const fallbackKey = canonicalPhone(normalized) || normalized;

  const issue = async () => {
    const phoneKey = await resolvePhoneKey(normalized);
    if (await isAccountSuspended(phoneKey)) {
      const err = new Error('ACCOUNT_SUSPENDED');
      err.code = 'ACCOUNT_SUSPENDED';
      throw err;
    }
    const gate = await getSessionGate(phoneKey);
    return createSessionToken(phoneKey, gate.epoch);
  };

  try {
    return await Promise.race([
      issue(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('issue_session_timeout')), ISSUE_SESSION_BUDGET_MS),
      ),
    ]);
  } catch (error) {
    if (error?.code === 'ACCOUNT_SUSPENDED') throw error;
    // لا نمنع الدخول إذا تعثّر Supabase — أصدر جلسة بالمفتاح القانوني.
    console.warn('issueSessionToken fallback:', error?.message || error);
    return createSessionToken(fallbackKey, 0);
  }
}

// ── Rate limiters ───────────────────────────────────────────────────────

const authSendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.parseInt(process.env.RATE_LIMIT_OTP_SEND_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    const phone = normalizePhone(req.body?.phone);
    const ipKey = ipKeyGenerator(req.ip || '');
    return phone ? `send:${phone}:${ipKey}` : ipKey;
  },
  message: { message: 'Too many OTP requests. Try again later.' },
});

const authVerifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.parseInt(process.env.RATE_LIMIT_OTP_VERIFY_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    const phone = normalizePhone(req.body?.phone);
    const ipKey = ipKeyGenerator(req.ip || '');
    return phone ? `verify:${phone}:${ipKey}` : ipKey;
  },
  message: { message: 'Too many verification attempts. Try again later.' },
});

// ── Routes ──────────────────────────────────────────────────────────────

router.post('/send-code', authSendCodeLimiter, async (req, res) => {
  try {
    cleanupExpiredOtps();

    const phone = normalizePhone(req.body?.phone);
    const channel = String(req.body?.channel || 'sms').trim().toLowerCase();
    if (!phone) {
      return res.status(400).json({ message: 'Phone number is required.' });
    }

    if (isAppleReviewPhone(phone)) {
      return res.json({
        success: true,
        phoneNumber: normalizePhoneForDisplay(phone),
        channel,
        expiresInMs: otpTtlMs,
        message: 'Demo account ready. Use verification code 123456.',
      });
    }

    const verificationCode = generateOtp();
    const smsResult = await sendOtpViaOtpiq(phone, verificationCode, channel);
    await savePendingOtp(phone, {
      code: verificationCode,
      expiresAt: Date.now() + otpTtlMs,
      smsId: smsResult?.smsId || null,
    });

    return res.json({
      success: true,
      phoneNumber: normalizePhoneForDisplay(phone),
      smsId: smsResult?.smsId || null,
      channel,
      expiresInMs: otpTtlMs,
    });
  } catch (error) {
    console.error('send-code error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to send verification code.',
    });
  }
});

router.post('/verify-code', authVerifyCodeLimiter, async (req, res) => {
  try {
    cleanupExpiredOtps();

    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();

    if (!phone || !code) {
      return res.status(400).json({ message: 'Phone number and code are required.' });
    }

    // تجاوز OTP اختياري: فقط عبر ADMIN_LOGIN_BYPASS_SECRET + ADMIN_LOGIN_BYPASS_PHONES
    // (لا كلمة مرور ثابتة في الكود). إن لم تُضبط البيئة فالتجاوز معطّل.
    if (
      (isAppleReviewPhone(phone) && code === APPLE_REVIEW_CODE) ||
      matchesAdminLoginBypass(phone, code)
    ) {
      // آثار جانبية على DB لا يجب أن تحجب إصدار التوكن عند بطء Supabase.
      void ensurePlatformAdminAccess(phone).catch(() => {});
      void ensureAppUser(phone).catch(() => {});
      const token = await issueSessionToken(phone);
      return res.json({
        success: true,
        token,
        phoneNumber: normalizePhoneForDisplay(phone),
        expiresInSeconds: 60 * 60 * 24 * 30,
      });
    }

    const otpEntry = await readPendingOtp(phone);
    if (!otpEntry) {
      return res.status(400).json({ success: false, message: 'Verification code expired. Please resend it.' });
    }

    if (otpEntry.code !== code) {
      return res.status(400).json({ success: false, message: 'Invalid verification code.' });
    }

    await clearPendingOtp(phone);
    void ensurePlatformAdminAccess(phone).catch(() => {});
    void ensureAppUser(phone).catch(() => {});
    const token = await issueSessionToken(phone);
    return res.json({
      success: true,
      token,
      phoneNumber: normalizePhoneForDisplay(phone),
      expiresInSeconds: 60 * 60 * 24 * 30,
    });
  } catch (error) {
    console.error('verify-code error:', error);
    if (error?.code === 'ACCOUNT_SUSPENDED') {
      return res.status(403).json({ code: 'ACCOUNT_SUSPENDED', message: 'حسابك موقوف. تواصل مع الدعم.' });
    }
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to verify code.',
    });
  }
});

router.post('/login-email', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ message: 'البريد الإلكتروني وكلمة المرور مطلوبان.' });
    }

    const { assertSupabaseAdmin, assertAdminAccess } = require('../supabase_repo');
    const supabase = assertSupabaseAdmin();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data?.user) {
      return res.status(400).json({ message: error?.message || 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }

    const rawPhone = data.user.phone;
    if (!rawPhone) {
      return res.status(403).json({ message: 'حساب البريد الإلكتروني غير مرتبط بأي رقم هاتف.' });
    }
    const phone = normalizePhone(rawPhone);
    await assertAdminAccess(phone);
    const token = await issueSessionToken(phone);
    return res.json({
      success: true,
      token,
      phoneNumber: normalizePhoneForDisplay(phone),
      expiresInSeconds: 60 * 60 * 24 * 30,
    });
  } catch (error) {
    console.error('login-email error:', error);
    if (error?.code === 'ACCOUNT_SUSPENDED') {
      return res.status(403).json({ code: 'ACCOUNT_SUSPENDED', message: 'حسابك موقوف. تواصل مع الدعم.' });
    }
    return res.status(500).json({ message: error?.message || 'فشل تسجيل الدخول بالبريد الإلكتروني.' });
  }
});

function isAdminAccessError(error) {
  return String(error?.message || '').includes('Admin access required');
}

router.post('/register-admin', async (req, res) => {
  try {
    const authorization = String(req.headers.authorization || '').trim();
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing authorization token.' });
    }
    const token = authorization.slice('Bearer '.length).trim();
    const { verifySessionToken } = require('../lib/session');
    const session = verifySessionToken(token);
    const requesterPhone = session.phone;
    if (!requesterPhone) {
      return res.status(401).json({ message: 'Invalid session token.' });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const phoneInput = String(req.body?.phone || '').trim();

    if (!email || !password || !phoneInput) {
      return res.status(400).json({ message: 'البريد الإلكتروني وكلمة المرور ورقم الهاتف مطلوبة.' });
    }

    const phone = normalizePhone(phoneInput);
    const { assertAdminAccess, assertSupabaseAdmin } = require('../supabase_repo');

    // Caller must already be an admin — not merely an authenticated user.
    await assertAdminAccess(requesterPhone);
    // Target phone must also be an allowlisted / admin phone.
    await assertAdminAccess(phone);

    const supabase = assertSupabaseAdmin();

    // Create the user in Supabase Auth via Admin API
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      phone,
      email_confirm: true,
      phone_confirm: true,
    });

    if (error) {
      // If user already exists, update their password and phone
      if (error.message.includes('already registered') || error.message.includes('already exists')) {
        const { data: listData, error: listError } = await supabase.auth.admin.listUsers();
        if (listError) throw listError;
        const { phonesEqual } = require('../supabase_repo/common');
        const existingUser = listData.users.find(
          (u) =>
            u.email === email ||
            phonesEqual(u.phone || '', phone),
        );
        if (existingUser) {
          const { error: updateError } = await supabase.auth.admin.updateUserById(existingUser.id, {
            password,
            phone,
            email_confirm: true,
            phone_confirm: true,
          });
          if (updateError) throw updateError;
          return res.json({ success: true, message: 'تم تحديث حساب المشرف بنجاح.' });
        }
      }
      throw error;
    }

    return res.json({ success: true, message: 'تم تسجيل حساب المشرف بنجاح.' });
  } catch (error) {
    console.error('register-admin error:', error);
    if (isAdminAccessError(error)) {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    return res.status(500).json({ message: error?.message || 'فشل تسجيل حساب المشرف.' });
  }
});

router.post('/register-email', async (req, res) => {
  try {
    const authorization = String(req.headers.authorization || '').trim();
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing authorization token.' });
    }
    const token = authorization.slice('Bearer '.length).trim();
    const { verifySessionToken } = require('../lib/session');
    const session = verifySessionToken(token);
    const requesterPhone = session.phone;
    if (!requesterPhone) {
      return res.status(401).json({ message: 'Invalid session token.' });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const phoneInput = String(req.body?.phone || '').trim();

    if (!email || !password || !phoneInput) {
      return res.status(400).json({ message: 'البريد الإلكتروني وكلمة المرور ورقم الهاتف مطلوبة.' });
    }

    const phone = normalizePhone(phoneInput);
    const { assertAdminAccess, assertSupabaseAdmin } = require('../supabase_repo');

    // Caller must already be an admin — not merely an authenticated user.
    await assertAdminAccess(requesterPhone);
    // Target phone must also be an allowlisted / admin phone.
    await assertAdminAccess(phone);

    const supabase = assertSupabaseAdmin();

    // Create the user in Supabase Auth via Admin API
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      phone,
      email_confirm: true,
      phone_confirm: true
    });

    if (error) {
      // If user already exists, update their password and phone
      if (error.message.includes('already registered') || error.message.includes('already exists')) {
        const { data: listData, error: listError } = await supabase.auth.admin.listUsers();
        if (listError) throw listError;
        const { phonesEqual } = require('../supabase_repo/common');
        const existingUser = listData.users.find(
          (u) => u.email === email || phonesEqual(u.phone || '', phone),
        );
        if (existingUser) {
          const { error: updateError } = await supabase.auth.admin.updateUserById(existingUser.id, {
            password,
            phone,
            email_confirm: true,
            phone_confirm: true
          });
          if (updateError) throw updateError;
          return res.json({ success: true, message: 'تم تحديث حساب المشرف بنجاح.' });
        }
      }
      throw error;
    }

    return res.json({ success: true, message: 'تم تسجيل حساب المشرف بنجاح.' });
  } catch (error) {
    console.error('register-email error:', error);
    if (isAdminAccessError(error)) {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    return res.status(500).json({ message: error?.message || 'فشل تسجيل حساب المشرف.' });
  }
});

/**
 * ترقية توكن OTP (من Cloudflare Worker) إلى جلسة Railway بـ sessionEpoch صحيح.
 * لا يشترط صلاحية أدمن — يُستخدم لكل دخول عبر OTP.
 */
router.post('/upgrade-session', async (req, res) => {
  try {
    const authorization = String(req.headers.authorization || '').trim();
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing authorization token.' });
    }
    const { verifySessionToken } = require('../lib/session');
    const session = verifySessionToken(authorization.slice('Bearer '.length).trim());
    const phone = session.phone;
    if (!phone) {
      return res.status(401).json({ message: 'Invalid session token.' });
    }

    await ensureAppUser(phone);
    const token = await issueSessionToken(phone);
    return res.json({
      success: true,
      token,
      phoneNumber: normalizePhoneForDisplay(phone),
      expiresInSeconds: 60 * 60 * 24 * 30,
    });
  } catch (error) {
    console.error('upgrade-session error:', error);
    if (error?.code === 'ACCOUNT_SUSPENDED') {
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'حسابك موقوف. تواصل مع الدعم.',
      });
    }
    if (/token|signature|expired|SESSION_SECRET/i.test(String(error?.message || ''))) {
      return res.status(401).json({
        message: error?.message || 'Invalid authorization token.',
      });
    }
    return res.status(500).json({
      message: error?.message || 'فشل ترقية الجلسة.',
    });
  }
});

/**
 * استبدال توكن OTP بتوكن إدارة بعد التحقق من صلاحية الأدمن.
 */
router.post('/exchange-session', async (req, res) => {
  try {
    const authorization = String(req.headers.authorization || '').trim();
    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing authorization token.' });
    }
    const { verifySessionToken } = require('../lib/session');
    const { assertAdminAccess } = require('../supabase_repo/users');
    const session = verifySessionToken(authorization.slice('Bearer '.length).trim());
    const phone = session.phone;
    if (!phone) {
      return res.status(401).json({ message: 'Invalid session token.' });
    }

    await ensurePlatformAdminAccess(phone);
    await assertAdminAccess(phone);
    await ensureAppUser(phone);
    const token = await issueSessionToken(phone);
    return res.json({
      success: true,
      token,
      phoneNumber: normalizePhoneForDisplay(phone),
      expiresInSeconds: 60 * 60 * 24 * 30,
    });
  } catch (error) {
    console.error('exchange-session error:', error);
    if (error?.code === 'ACCOUNT_SUSPENDED') {
      return res.status(403).json({ code: 'ACCOUNT_SUSPENDED', message: 'حسابك موقوف. تواصل مع الدعم.' });
    }
    if (isAdminAccessError(error) || String(error?.message || '').includes('Admin access')) {
      return res.status(403).json({ message: 'هذا الرقم غير مخوّل لدخول لوحة الإدارة.' });
    }
    if (
      /token|signature|expired|SESSION_SECRET/i.test(String(error?.message || ''))
    ) {
      return res.status(401).json({ message: error?.message || 'Invalid authorization token.' });
    }
    return res.status(500).json({
      message: error?.message || 'فشل إنشاء جلسة الإدارة.',
    });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const authorization = String(req.headers.authorization || '').trim();
    if (!authorization.startsWith('Bearer ')) return res.json({ success: true });
    const { verifySessionToken } = require('../lib/session');
    const session = verifySessionToken(authorization.slice('Bearer '.length).trim());
    await bumpSessionEpoch(session.phone);
    return res.json({ success: true });
  } catch (_) {
    return res.json({ success: true });
  }
});

module.exports = router;
module.exports.resolveOtpiqProvider = resolveOtpiqProvider;
