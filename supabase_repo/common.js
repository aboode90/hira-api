const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

function normalizeSupabaseUrl(url) {
  if (!url) return '';
  let normalized = String(url).trim();
  if (normalized.endsWith('/rest/v1/')) {
    normalized = normalized.slice(0, -'/rest/v1/'.length);
  } else if (normalized.endsWith('/rest/v1')) {
    normalized = normalized.slice(0, -'/rest/v1'.length);
  }
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

const supabaseUrl = normalizeSupabaseUrl(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || ''
);
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  '';
const isConfigured = Boolean(supabaseUrl && supabaseServiceRoleKey);

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

const supabaseKeyPayload = decodeJwtPayload(supabaseServiceRoleKey);
const supabaseKeyRole = supabaseKeyPayload?.role || null;
const isLikelyAnonKey = supabaseKeyRole === 'anon';
const isLikelyServiceRoleKey = supabaseKeyRole === 'service_role';

let supabaseAdmin = null;
const schemaColumnCache = new Map();
/** @type {Map<string, { value: string, expiresAt: number }>} */
const phoneKeyCache = new Map();
const PHONE_KEY_TTL_MS = 15 * 60_000;
const SUPABASE_FETCH_TIMEOUT_MS = 6_000;
const SUPABASE_FETCH_MAX_ATTEMPTS = 2;
const RESOLVE_PHONE_KEY_BUDGET_MS = 2_500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientSupabaseFailure(message, status) {
  if ([502, 503, 504].includes(Number(status) || 0)) return true;
  return /upstream request timeout|timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(
    String(message || '')
  );
}

/**
 * Fetch مع مهلة واضحة وإعادة محاولة للأخطاء العابرة من بوابة Supabase.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
async function resilientSupabaseFetch(input, init = {}) {
  const { recordDbFailure, recordDbSuccess } = require('../lib/db_circuit');
  let lastError = null;
  for (let attempt = 1; attempt <= SUPABASE_FETCH_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        recordDbSuccess();
        return response;
      }

      const text = await response.text().catch(() => '');
      const retryable =
        attempt < SUPABASE_FETCH_MAX_ATTEMPTS &&
        isTransientSupabaseFailure(text || response.statusText, response.status);
      if (retryable) {
        recordDbFailure({ message: text || response.statusText });
        await sleep(150 * attempt + Math.floor(Math.random() * 120));
        continue;
      }

      if (isTransientSupabaseFailure(text || response.statusText, response.status)) {
        recordDbFailure({ message: text || response.statusText });
      }
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      lastError = error;
      recordDbFailure(error);
      const retryable =
        attempt < SUPABASE_FETCH_MAX_ATTEMPTS &&
        isTransientSupabaseFailure(error?.message || error, 0);
      if (!retryable) throw error;
      await sleep(150 * attempt + Math.floor(Math.random() * 120));
    } finally {
      clearTimeout(timer);
    }
  }
  const finalMessage = lastError?.message || lastError?.name || 'Supabase fetch failed';
  if (/aborted|AbortError|timeout/i.test(String(finalMessage))) {
    throw new Error('الخادم مشغول أو بطيء حالياً. حدّث الصفحة وحاول مرة أخرى.');
  }
  throw lastError || new Error('Supabase fetch failed');
}

function phoneKeyCacheIndex(phone) {
  const raw = String(phone || '').trim();
  const canonical = canonicalPhone(phone);
  return [...new Set([...getPhoneVariants(phone), raw, canonical].filter(Boolean))];
}

function readCachedPhoneKey(phone) {
  const now = Date.now();
  for (const key of phoneKeyCacheIndex(phone)) {
    const entry = phoneKeyCache.get(key);
    if (!entry) continue;
    if (entry.expiresAt <= now) {
      phoneKeyCache.delete(key);
      continue;
    }
    return entry.value;
  }
  return null;
}

function writeCachedPhoneKey(phone, resolved) {
  const value = String(resolved || '').trim();
  if (!value) return;
  const expiresAt = Date.now() + PHONE_KEY_TTL_MS;
  for (const key of new Set([...phoneKeyCacheIndex(phone), ...phoneKeyCacheIndex(value)])) {
    phoneKeyCache.set(key, { value, expiresAt });
  }
}

function invalidatePhoneKeyCache(phone) {
  for (const key of phoneKeyCacheIndex(phone)) {
    phoneKeyCache.delete(key);
  }
}

/** @returns {import('@supabase/supabase-js').SupabaseClient | null} */
function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      fetch: resilientSupabaseFetch,
    },
    realtime: {
      transport: WebSocket,
    },
  });
  return supabaseAdmin;
}

function assertSupabaseAdmin() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for database operations.'
    );
  }
  return admin;
}

function nowIso() {
  return new Date().toISOString();
}

function assignIfDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }
  return [];
}

function normalizeObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }
  return {};
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );
}

/**
 * @param {string} phone
 * @returns {string[]}
 */
function getPhoneVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) {
    const trimmed = String(phone || '').trim();
    return trimmed ? [trimmed] : [];
  }
  const core = digits.slice(-10);
  return [`+964${core}`, `964${core}`, `0${core}`, core];
}

function canonicalPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length >= 11) {
    return `+964${digits.slice(1)}`;
  }
  if (digits.startsWith('964')) {
    return `+${digits}`;
  }
  if (digits.length === 10 && digits.startsWith('7')) {
    return `+964${digits}`;
  }
  const trimmed = String(phone || '').trim();
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

function phonesOverlap(left, right) {
  const leftVariants = new Set(getPhoneVariants(left));
  if (leftVariants.size === 0) return false;
  for (const variant of getPhoneVariants(right)) {
    if (leftVariants.has(variant)) {
      return true;
    }
  }
  return false;
}

/** مقارنة دقيقة لرقمين بأي صيغة (+964 / 964 / 07) — تعادل رقمياً. */
function phonesEqual(left, right) {
  const a = canonicalPhone(left);
  const b = canonicalPhone(right);
  return Boolean(a && b && a === b);
}

async function selectSingleByPhone(table, phone) {
  const raw = String(phone || '').trim();
  const variants = getPhoneVariants(phone);
  const lookupValues = [...new Set([...variants, raw, canonicalPhone(phone)].filter(Boolean))];
  if (lookupValues.length === 0) return null;

  const supabase = assertSupabaseAdmin();
  const cacheKey = `${table}.updated_at`;
  const knownHasUpdatedAt = schemaColumnCache.has(cacheKey)
    ? schemaColumnCache.get(cacheKey)
    : true;

  const run = (withOrder) => {
    let query = supabase.from(table).select().in('phone', lookupValues);
    if (withOrder) query = query.order('updated_at', { ascending: false });
    return query.limit(1);
  };

  let { data, error } = await run(knownHasUpdatedAt);
  if (error && /updated_at|column/i.test(error.message || '')) {
    schemaColumnCache.set(cacheKey, false);
    ({ data, error } = await run(false));
  } else if (!error && knownHasUpdatedAt) {
    schemaColumnCache.set(cacheKey, true);
  }

  if (error) throw new Error(error.message);
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

async function resolvePhoneKeyUncached(phone) {
  const tables = ['app_users', 'driver_profiles', 'customer_profiles', 'merchant_profiles', 'app_state'];
  for (const table of tables) {
    const existing = await selectSingleByPhone(table, phone);
    if (existing?.phone) return existing.phone;
  }
  const raw = String(phone || '').trim();
  return canonicalPhone(phone) || raw;
}

async function resolvePhoneKey(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return raw;

  const cached = readCachedPhoneKey(phone);
  if (cached) return cached;

  const fallback = canonicalPhone(phone) || raw;
  try {
    const resolved = await Promise.race([
      resolvePhoneKeyUncached(phone),
      new Promise((resolve) =>
        setTimeout(() => resolve(null), RESOLVE_PHONE_KEY_BUDGET_MS),
      ),
    ]);
    const value = resolved || fallback;
    writeCachedPhoneKey(phone, value);
    return value;
  } catch (_) {
    writeCachedPhoneKey(phone, fallback);
    return fallback;
  }
}

async function selectSingle(table, column, value) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from(table)
    .select()
    .eq(column, value)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * @param {string} table
 * @param {Array<{method: string, column: string, value: any}>} filters
 * @param {{column?: string, ascending?: boolean}} [orderBy]
 * @param {number} [limit]
 * @param {number} [offset]
 * @returns {Promise<Array<Object>>}
 */
async function selectMany(table, filters = [], orderBy = null, limit = null, offset = null) {
  const supabase = assertSupabaseAdmin();
  let query = supabase.from(table).select();
  for (const filter of filters) {
    query = query[filter.method](filter.column, filter.value);
  }
  if (orderBy) {
    query = query.order(orderBy.column, { ascending: orderBy.ascending });
  }
  if (limit !== null && Number.isInteger(limit) && limit > 0) {
    if (offset !== null && Number.isInteger(offset) && offset >= 0) {
      query = query.range(offset, offset + limit - 1);
    } else {
      query = query.limit(limit);
    }
  }
  let data;
  let error;
  try {
    ({ data, error } = await query);
  } catch (err) {
    if (/aborted|AbortError|timeout/i.test(err?.message || err?.name || '')) {
      throw new Error('الخادم مشغول أو بطيء حالياً. حدّث الصفحة وحاول مرة أخرى.');
    }
    throw err;
  }
  if (error) {
    if (/aborted|AbortError|timeout/i.test(error.message || '')) {
      throw new Error('الخادم مشغول أو بطيء حالياً. حدّث الصفحة وحاول مرة أخرى.');
    }
    throw new Error(error.message);
  }
  return Array.isArray(data) ? data : [];
}

async function selectManyColumns(
  table,
  columns,
  filters = [],
  orderBy = null,
  limit = null,
  offset = null
) {
  const supabase = assertSupabaseAdmin();
  let query = supabase.from(table).select(columns);
  for (const filter of filters) {
    query = query[filter.method](filter.column, filter.value);
  }
  if (orderBy) {
    query = query.order(orderBy.column, { ascending: orderBy.ascending });
  }
  if (limit !== null && Number.isInteger(limit) && limit > 0) {
    if (offset !== null && Number.isInteger(offset) && offset >= 0) {
      query = query.range(offset, offset + limit - 1);
    } else {
      query = query.limit(limit);
    }
  }
  const { data, error } = await query;
  if (error) {
    if (/aborted|AbortError|timeout/i.test(error.message || '')) {
      throw new Error('الخادم مشغول أو بطيء حالياً. حدّث الصفحة وحاول مرة أخرى.');
    }
    throw new Error(error.message);
  }
  return Array.isArray(data) ? data : [];
}

async function hasColumn(table, column) {
  const cacheKey = `${table}.${column}`;
  if (schemaColumnCache.has(cacheKey)) {
    return schemaColumnCache.get(cacheKey);
  }

  const supabase = assertSupabaseAdmin();
  const { error } = await supabase.from(table).select(column).limit(1);
  const exists = !error;
  schemaColumnCache.set(cacheKey, exists);
  return exists;
}

async function updateRow(table, keyColumn, keyValue, payload) {
  const supabase = assertSupabaseAdmin();
  const key = String(keyValue ?? '').trim();
  if (!key) {
    throw new Error(`Missing ${keyColumn} for ${table} update.`);
  }

  const { data, error } = await supabase
    .from(table)
    .update(payload)
    .eq(keyColumn, key)
    .select();

  if (error) throw new Error(error.message);
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function saveRow(table, payload, conflictColumn) {
  const supabase = assertSupabaseAdmin();
  let conflictValue = payload[conflictColumn];
  if (
    conflictValue === undefined ||
    conflictValue === null ||
    String(conflictValue).trim() === ''
  ) {
    throw new Error(`Missing ${conflictColumn} for ${table}.`);
  }

  if (conflictColumn === 'phone') {
    conflictValue = await resolvePhoneKey(conflictValue);
    payload.phone = conflictValue;
    invalidatePhoneKeyCache(conflictValue);

    const existing = await selectSingleByPhone(table, conflictValue);
    if (existing?.phone) {
      return updateRow(table, 'phone', String(existing.phone).trim(), payload);
    }

    const { data: inserted, error: insertError } = await supabase
      .from(table)
      .insert(payload)
      .select();

    if (!insertError) {
      if (Array.isArray(inserted)) return inserted[0] || null;
      return inserted || null;
    }

    const insertMessage = String(insertError.message || '');
    if (/duplicate key|unique constraint|_pkey/i.test(insertMessage)) {
      const retryExisting = await selectSingleByPhone(table, conflictValue);
      if (retryExisting?.phone) {
        return updateRow(table, 'phone', String(retryExisting.phone).trim(), payload);
      }
      for (const variant of getPhoneVariants(conflictValue)) {
        const row = await selectSingle(table, 'phone', variant);
        if (row?.phone) {
          return updateRow(table, 'phone', String(row.phone).trim(), payload);
        }
      }
    }

    throw new Error(insertError.message);
  }

  // Atomic upsert باستخدام ON CONFLICT — يلغي race condition
  const { data, error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: conflictColumn, ignoreDuplicates: false })
    .select();

  if (error) {
    const message = String(error.message || '');
    if (/no unique or exclusion constraint/i.test(message)) {
      const existing = await selectSingle(table, conflictColumn, conflictValue);
      if (existing) {
        return updateRow(table, conflictColumn, conflictValue, payload);
      }
      const { data: inserted, error: insertError } = await supabase
        .from(table)
        .insert(payload)
        .select();
      if (insertError) throw new Error(insertError.message);
      if (Array.isArray(inserted)) return inserted[0] || null;
      return inserted || null;
    }
    throw new Error(error.message);
  }
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function deleteRow(table, column, value) {
  const supabase = assertSupabaseAdmin();
  const { error } = await supabase.from(table).delete().eq(column, value);
  if (error) throw new Error(error.message);
}

const PLATFORM_SETTINGS_PHONE = '__platform_settings__';
const PLATFORM_ADMIN_PHONES = Object.freeze([
  '07744009992',
  '+9647744009992',
]);

module.exports = {
  isConfigured,
  supabaseKeyRole,
  isLikelyAnonKey,
  isLikelyServiceRoleKey,
  canonicalPhone,
  normalizeSupabaseUrl,
  decodeJwtPayload,
  getSupabaseAdmin,
  assertSupabaseAdmin,
  nowIso,
  assignIfDefined,
  normalizeArray,
  normalizeObject,
  parseOptionalBoolean,
  isUuid,
  getPhoneVariants,
  phonesOverlap,
  phonesEqual,
  selectSingleByPhone,
  resolvePhoneKey,
  invalidatePhoneKeyCache,
  selectSingle,
  selectMany,
  selectManyColumns,
  hasColumn,
  saveRow,
  updateRow,
  deleteRow,
  PLATFORM_SETTINGS_PHONE,
  PLATFORM_ADMIN_PHONES,
};
