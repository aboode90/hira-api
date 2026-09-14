const { getUserState, saveUserState } = require('../supabase_repo/users');
const { resolvePhoneKey, canonicalPhone } = require('../supabase_repo/common');

const cache = new Map();
const CACHE_TTL_MS = 30 * 1000;

function emptyGate(phone = '') {
  return {
    at: Date.now(),
    phone: String(phone || '').trim(),
    suspended: false,
    epoch: 0,
  };
}

async function getSessionGate(phone) {
  const key = String(phone || '').trim();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit;

  const localKey = canonicalPhone(key) || key;
  try {
    const loaded = await Promise.race([
      (async () => {
        let phoneKey = key;
        try {
          phoneKey = await resolvePhoneKey(key);
        } catch (_) {
          phoneKey = localKey;
        }
        const state = (await getUserState(phoneKey)) || {};
        return {
          at: now,
          phone: phoneKey,
          suspended: state.accountSuspended === true,
          epoch: Number(state.sessionEpoch || state.session_epoch || 0),
        };
      })(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);

    if (!loaded) {
      const fallback = emptyGate(localKey);
      cache.set(key, { ...fallback, at: now });
      return fallback;
    }

    cache.set(key, loaded);
    return loaded;
  } catch (error) {
    // لا تُسقط طلبات /db بسبب فشل قراءة app_state — استخدم بوابة آمنة مؤقتاً.
    console.warn(
      'getSessionGate fallback:',
      error?.message || error,
    );
    const fallback = emptyGate(localKey);
    cache.set(key, { ...fallback, at: now });
    return fallback;
  }
}

function invalidateSessionGate(phone) {
  cache.delete(String(phone || '').trim());
}

async function bumpSessionEpoch(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const state = (await getUserState(phoneKey)) || {};
  const next = { ...state, sessionEpoch: Number(state.sessionEpoch || 0) + 1 };
  await saveUserState(phoneKey, next);
  invalidateSessionGate(phoneKey);
  return next.sessionEpoch;
}

async function isAccountSuspended(phone) {
  return (await getSessionGate(phone)).suspended;
}

module.exports = {
  getSessionGate,
  invalidateSessionGate,
  bumpSessionEpoch,
  isAccountSuspended,
};
