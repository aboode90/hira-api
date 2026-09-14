/**
 * كاش استجابات للمسارات العامة — ذاكرة محلية + Redis اختياري (REDIS_URL).
 * يُسرّع القراءة المتكررة دون تغيير التطبيق.
 */

const { getRedisClient } = require('./redis_client');

const memoryStore = new Map();

function parseTtlMs(value, fallbackMs) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

const DEFAULT_TTLS = {
  homeCategories: parseTtlMs(process.env.CACHE_TTL_HOME_CATEGORIES_MS, 5 * 60_000),
  marketplaceStats: parseTtlMs(process.env.CACHE_TTL_MARKETPLACE_STATS_MS, 3 * 60_000),
  storeLists: parseTtlMs(process.env.CACHE_TTL_STORE_LISTS_MS, 10 * 60_000),
  catalog: parseTtlMs(process.env.CACHE_TTL_CATALOG_MS, 5 * 60_000),
  appPolicy: parseTtlMs(process.env.CACHE_TTL_APP_POLICY_MS, 10 * 60_000),
  adminReportsLite: parseTtlMs(process.env.CACHE_TTL_ADMIN_REPORTS_LITE_MS, 60_000),
  adminReportsFull: parseTtlMs(process.env.CACHE_TTL_ADMIN_REPORTS_FULL_MS, 45_000),
  adminModerationSummary: parseTtlMs(
    process.env.CACHE_TTL_ADMIN_MODERATION_SUMMARY_MS,
    30_000,
  ),
  adminNotifications: parseTtlMs(process.env.CACHE_TTL_ADMIN_NOTIFICATIONS_MS, 15_000),
  adminLastGood: parseTtlMs(process.env.CACHE_TTL_ADMIN_LAST_GOOD_MS, 30 * 60_000),
};

function readMemory(key) {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

function writeMemory(key, value, ttlMs) {
  memoryStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

async function readRedis(key) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(`rc:${key}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function writeRedis(key, value, ttlMs) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await client.set(`rc:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (_) {
    // ignore redis write errors — memory cache still helps
  }
}

async function getCached(key) {
  const memoryValue = readMemory(key);
  if (memoryValue !== null) {
    return { value: memoryValue, source: 'memory' };
  }

  const redisValue = await readRedis(key);
  if (redisValue !== null) {
    writeMemory(key, redisValue, 60_000);
    return { value: redisValue, source: 'redis' };
  }

  return null;
}

async function setCached(key, value, ttlMs) {
  writeMemory(key, value, ttlMs);
  await writeRedis(key, value, ttlMs);
}

/** يكتب الكاش القصير + نسخة last-good طويلة للأدمن تحت الضغط. */
async function setCachedWithLastGood(key, value, ttlMs, lastGoodTtlMs = DEFAULT_TTLS.adminLastGood) {
  await setCached(key, value, ttlMs);
  if (value && typeof value === 'object' && value.degraded === true && value.reason === 'db_circuit_open') {
    return;
  }
  // لا نحفظ أصفار فارغة كـ last-good إن وُسمت كمتدهورة بلا بيانات
  const looksEmpty =
    value &&
    typeof value === 'object' &&
    Number(value.totalOrders || 0) === 0 &&
    Number(value.totalProducts || 0) === 0 &&
    Number(value.totalDrivers || 0) === 0 &&
    value.degraded === true;
  if (looksEmpty) return;
  await setCached(`${key}:lastgood`, value, lastGoodTtlMs);
}

async function getLastGood(key) {
  return getCached(`${key}:lastgood`);
}

/**
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} loader
 * @returns {Promise<{ value: T, cacheHit: boolean, cacheSource: string | null }>}
 */
async function remember(key, ttlMs, loader) {
  const cached = await getCached(key);
  if (cached) {
    return {
      value: cached.value,
      cacheHit: true,
      cacheSource: cached.source,
    };
  }

  const value = await loader();
  await setCached(key, value, ttlMs);
  return {
    value,
    cacheHit: false,
    cacheSource: null,
  };
}

async function rememberAdmin(key, ttlMs, loader) {
  const cached = await getCached(key);
  if (cached) {
    return {
      value: cached.value,
      cacheHit: true,
      cacheSource: cached.source,
    };
  }

  const value = await loader();
  await setCachedWithLastGood(key, value, ttlMs);
  return {
    value,
    cacheHit: false,
    cacheSource: null,
  };
}

function cacheStats() {
  const redisClient = getRedisClient();
  const now = Date.now();
  let active = 0;
  for (const entry of memoryStore.values()) {
    if (entry.expiresAt > now) active += 1;
  }
  return {
    memoryEntries: active,
    redisConfigured: Boolean(String(process.env.REDIS_URL || '').trim()),
    redisConnected: Boolean(redisClient && redisClient.status === 'ready'),
    ttlsMs: DEFAULT_TTLS,
  };
}

function setCacheHeader(res, cacheHit, cacheSource) {
  if (!res || res.headersSent) return;
  res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
  if (cacheSource) {
    res.setHeader('X-Cache-Source', cacheSource);
  }
}

function invalidateCache(key) {
  memoryStore.delete(key);
  const client = getRedisClient();
  if (client) {
    client.del(`rc:${key}`).catch(() => {});
  }
}

async function invalidateCachePrefix(prefix) {
  const normalized = String(prefix || '');
  if (!normalized) return;
  for (const key of memoryStore.keys()) {
    if (key.startsWith(normalized)) {
      memoryStore.delete(key);
    }
  }

  const client = getRedisClient();
  if (!client) return;
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        `rc:${normalized}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length) {
        await client.del(...keys);
      }
    } while (cursor !== '0');
  } catch (_) {
    // ignore Redis invalidation errors — memory cache is already cleared
  }
}

module.exports = {
  DEFAULT_TTLS,
  getCached,
  getLastGood,
  setCached,
  setCachedWithLastGood,
  remember,
  rememberAdmin,
  cacheStats,
  setCacheHeader,
  invalidateCache,
  invalidateCachePrefix,
};
