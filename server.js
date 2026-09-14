require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// توسيع تجمع اتصالات HTTP (undici) — يمنع تزاحم طلبات قاعدة البيانات
// المتزامنة (حضور السائقين كل 5 ثوانٍ) وانتظار كل طلب لاتصال شاغر.
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(
    new Agent({
      connections: 64,
      pipelining: 1,
      keepAliveTimeout: 10_000,
    })
  );
} catch (error) {
  console.error('undici dispatcher setup failed:', error?.message || error);
}

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.default || rateLimitLib;
const { version: backendVersion } = require('./package.json');
const { isPushConfigured } = require('./push_notifications');
const { mountDomainRoutes, startDomainWorkers } = require('./domains/registry');
const { validatePromoCode } = require('./promo_codes');
const logger = require('./lib/logger');
const { errorHandler, notFoundHandler } = require('./lib/error_handler');
const { verifySessionToken } = require('./lib/session');
const { cacheStats } = require('./lib/response_cache');
const { scheduleServerWarmup } = require('./lib/server_warmup');
const { redisStats } = require('./lib/redis_client');
const { describeVoiceStatus } = require('./services/voice_provider');

// ── Config ──────────────────────────────────────────────────────────────

const app = express();
const port = process.env.PORT || 3000;
app.set('trust proxy', 1);

const sessionSecret = String(process.env.SESSION_SECRET || '').trim();
const mapboxAccessToken = String(process.env.MAPBOX_ACCESS_TOKEN || '').trim();

const corsAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

// ── Warnings ────────────────────────────────────────────────────────────

if (!sessionSecret) {
  logger.warn('Missing SESSION_SECRET');
}

if (!mapboxAccessToken) {
  logger.warn('Missing MAPBOX_ACCESS_TOKEN');
}

if (!isPushConfigured()) {
  logger.warn('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
}

// ── CORS ────────────────────────────────────────────────────────────────

function normalizeOriginHost(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (corsAllowedOrigins.length === 0 || corsAllowedOrigins.includes(origin)) {
    return true;
  }

  const host = normalizeOriginHost(origin);
  // نطاقات لوحة الإدارة / الموقع العام (مع أو بدون www).
  if (
    host === 'hirasite.com' ||
    host === 'www.hirasite.com' ||
    host.endsWith('.hirasite.com') ||
    host.endsWith('.vercel.app')
  ) {
    return true;
  }

  // Allow localhost / local-dev origins
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    return true;
  }
  // Allow Tauri desktop app origins (v1 uses tauri://localhost, v2 uses https://tauri.localhost / asset.localhost)
  if (/^tauri:\/\/localhost(:\d+)?$/i.test(origin)) {
    return true;
  }
  if (/^https?:\/\/(tauri|asset|ipc)\.localhost(:\d+)?$/i.test(origin)) {
    return true;
  }
  return false;
}

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // لا نرمي Error هنا — يحوّله Express إلى 500 ويكسر المتصفح.
      callback(null, isAllowedCorsOrigin(origin));
    },
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const originalWriteHead = res.writeHead;
  res.writeHead = function writeHeadWithTiming(...args) {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (!res.headersSent) {
      res.setHeader('X-Response-Time-Ms', elapsedMs.toFixed(1));
    }
    return originalWriteHead.apply(this, args);
  };
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (elapsedMs >= Number.parseInt(process.env.SLOW_REQUEST_MS || '1000', 10)) {
      logger.warn('slow request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        elapsedMs: Math.round(elapsedMs),
      });
    }
  });
  next();
});

// ── Per-route rate limiters ─────────────────────────────────────────────
// كل مسار بحد خاص حسب احتياجه، بدل limiter عام يمنع كل شيء.
// مهم: لا تُكدّس حدود /db فوق /db/chat|/db/taxi|/db/admin — كان ذلك
// يجعل ضغط التكسي يستنزف حد الإدارة ويظهر 429 على /db/admin/roles.

const minute = 60 * 1000;
const ipKeyGenerator =
  rateLimitLib.ipKeyGenerator || ((ip) => String(ip || 'unknown'));

function rateLimitKey(req) {
  const authorization = String(req.headers.authorization || '').trim();
  if (authorization.startsWith('Bearer ')) {
    try {
      const session = verifySessionToken(authorization.slice('Bearer '.length).trim());
      const phone = String(session?.phone || '').trim();
      if (phone) return `phone:${phone}`;
    } catch (_) {
      // توكن غير صالح — نرجع لمفتاح IP
    }
  }
  return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`;
}

function createLimiter(maxReqs, windowMs = minute) {
  return rateLimit({
    windowMs,
    max: Number.parseInt(process.env[`RATE_LIMIT_${maxReqs}`] || String(maxReqs), 10),
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: rateLimitKey,
    message: { message: 'Too many requests. Try again later.' },
  });
}

const healthLimiter = createLimiter(500);
const appLimiter = createLimiter(400);
const chatLimiter = createLimiter(600);
const taxiLimiter = createLimiter(1200);
const mapsLimiter = createLimiter(300);
const authLimiter = createLimiter(60);
const adminDbLimiter = createLimiter(2400);
const dbLimiter = createLimiter(900);

// مسارات سريعة للصحة والمعلومات العامة
app.use('/health', healthLimiter);
app.use('/app', appLimiter);

// مسارات المحادثة — تحتاج حد أعلى بسبب الـ polling
app.use('/db/chat', chatLimiter);

// مسارات التكسي والخرائط
app.use('/db/taxi', taxiLimiter);
app.use('/maps', mapsLimiter);

// مسارات المصادقة — حد منخفض للحماية من brute force
app.use('/auth', authLimiter);

// باقي /db: إدارة بحد مستقل، وباقي المسارات بدون احتساب chat/taxi مرتين.
app.use('/db', (req, res, next) => {
  const path = String(req.path || '');
  if (path.startsWith('/chat') || path.startsWith('/taxi')) {
    return next();
  }
  if (path.startsWith('/admin')) {
    return adminDbLimiter(req, res, next);
  }
  return dbLimiter(req, res, next);
});

// ── Session verification ────────────────────────────────────────────────
// تستخدم دوال verifySessionToken من lib/session.js
// يتطابق التنفيذ مع Cloudflare Worker cloudflare_worker.js
// لضمان اتساق التحقق من رموز الجلسة عبر البيئتين.

// ── Health endpoint ─────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  const voice = describeVoiceStatus();
  const { getDbCircuitState } = require('./lib/db_circuit');
  res.json({
    ok: true,
    version: backendVersion,
    pushConfigured: isPushConfigured(),
    voice: {
      provider: voice.provider,
      enabled: voice.enabled,
      livekitConfigured: voice.livekitConfigured,
      zegoConfigured: voice.zegoConfigured,
    },
    cache: cacheStats(),
    redis: redisStats(),
    dbCircuit: getDbCircuitState(),
  });
});

// ── Feature flags ──────────────────────────────────────────────────
app.use('/app', require('./routes/features'));

// ── Dynamic app config ─────────────────────────────────────────────
app.use('/app/config', require('./routes/app_config'));

// ── Home assistant NLU (حيرة) ───────────────────────────────────────
app.use('/app/assistant', require('./routes/assistant'));

// ── Emergency / debug routes (disabled unless ENABLE_EMERGENCY_ROUTES=true + key) ──
app.use(require('./routes/emergency'));

// ── DB auth middleware ─────────────────────────────────────────────────

app.use('/db', async (req, res, next) => {
  const { isPublicDbPath } = require('./lib/db_auth_policy');
  if (isPublicDbPath(req.path)) {
    return next();
  }

  const authorization = String(req.headers.authorization || '').trim();
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing authorization token.' });
  }

  try {
    const token = authorization.slice('Bearer '.length).trim();
    const session = verifySessionToken(token);
    req.authPhone = session.phone;
    req.authSessionExpiresAt = session.exp;
    req.kashierStaff =
      session.typ === 'kashier'
        ? {
            staffId: session.staffId,
            role: session.role,
            department: session.dept,
            displayName: session.name,
          }
        : null;
    if (session.typ === 'kashier' && !String(req.path || '').startsWith('/kashier')) {
      return res.status(403).json({ message: 'صلاحية الكاشير لا تشمل هذا المسار.' });
    }
    try {
      const { getSessionGate } = require('./lib/session_gate');
      const gate = await getSessionGate(req.authPhone);
      if (gate.suspended) {
        return res.status(403).json({ code: 'ACCOUNT_SUSPENDED', message: 'حسابك موقوف. تواصل مع الدعم.' });
      }
      // فقط التوكنات التي تحمل se صراحةً تخضع لإلغاء الجلسة عبر epoch.
      if (
        session.typ !== 'kashier' &&
        session.hasSe === true &&
        gate.epoch > 0 &&
        Number(session.se || 0) < gate.epoch
      ) {
        return res.status(401).json({ code: 'SESSION_REVOKED', message: 'انتهت الجلسة — سجل الدخول مجدداً.' });
      }
    } catch (error) {
      // فشل البوابة لا يوقف الطلب — اسمح بالمرور (getSessionGate أصلاً fail-open).
      if (session.typ !== 'kashier') {
        logger.warn('session gate check failed; allowing request', {
          error: error?.message || error,
        });
      }
    }
    return next();
  } catch (error) {
    return res.status(401).json({
      message: error?.message || 'Invalid authorization token.',
    });
  }
});

// ── Route mounts (domain registry) ─────────────────────────────────────

mountDomainRoutes(app);

// ── Promo code validation (kept inline) ────────────────────────────────

app.post('/db/validate-promo', async (req, res) => {
  try {
    const code = String(req.body?.code || req.body?.promoCode || '').trim();
    const subtotalIqd = Number(req.body?.subtotalIqd ?? req.body?.subtotal ?? 0);
    const scope = String(req.body?.scope || 'marketplace').trim();

    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    if (token) {
      try {
        const session = verifySessionToken(token);
        const phone = session?.phoneNumber || session?.phone;
        if (phone) {
          const loyalty = require('./services/loyalty/loyalty_service');
          const loyaltyResult = loyalty.validateCouponForCheckout(
            phone,
            code,
            subtotalIqd,
            scope,
          );
          if (loyaltyResult.valid) {
            return res.json({
              valid: true,
              code: loyaltyResult.code,
              labelAr: loyaltyResult.labelAr,
              labelEn: loyaltyResult.labelAr,
              discountType: loyaltyResult.discountType,
              discountValue: loyaltyResult.discountValue,
              discountAmountIqd: loyaltyResult.discountAmountIqd,
              couponId: loyaltyResult.couponId,
              platformFeeWaived: true,
              platformFeeWaivedPercent: 100,
              source: 'loyalty',
            });
          }
          if (loyaltyResult.messageAr) {
            return res.json({
              valid: false,
              messageAr: loyaltyResult.messageAr,
              messageEn: loyaltyResult.messageAr,
            });
          }
        }
      } catch (_) {
        // fallback to legacy promo codes
      }
    }

    const result = validatePromoCode(code, subtotalIqd);
    return res.json(result);
  } catch (error) {
    logger.error('validate-promo error', { error: error.message });
    return res.status(500).json({ message: 'Failed to validate promo code.' });
  }
});

// ── Error handling ─────────────────────────────────────────────────────

app.use('/db', notFoundHandler);
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start server ────────────────────────────────────────────────────────

app.listen(port, () => {
  logger.info(`Backend listening on port ${port} (v${backendVersion})`);
  const voice = describeVoiceStatus();
  if (voice.enabled) {
    logger.info(`Voice provider ready: ${voice.provider}${voice.livekitUrl ? ` (${voice.livekitUrl})` : ''}`);
  } else {
    logger.warn(
      `Voice provider not ready (provider=${voice.provider}, livekit=${voice.livekitConfigured}, zego=${voice.zegoConfigured})`
    );
  }
  startDomainWorkers();
  scheduleServerWarmup();
  if (isPushConfigured()) {
    logger.info('Push scheduler started');
  }
});
