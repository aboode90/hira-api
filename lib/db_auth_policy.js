/**
 * سياسات تفويض /db — منطق نقي قابل للاختبار بدون قاعدة بيانات.
 *
 * المعمارية: التفويض الحقيقي في Node؛ Postgres = deny-all RLS + service_role.
 */

const { phonesOverlap } = require('../supabase_repo/common');

/** مسارات /db العامة (بدون Bearer) — يجب أن تبقى متزامنة مع server.js */
const PUBLIC_DB_PATHS = Object.freeze([
  '/professionals',
  '/shopping-stores',
  '/restaurant-stores',
  '/service-stores',
  '/store-products',
  '/catalog-products',
  '/offer-catalog-products',
  '/marketplace-stats',
  '/validate-promo',
  '/real-estate-listings',
  '/kashier/login',
]);

function isPublicDbPath(path) {
  const normalized = String(path || '').split('?')[0];
  return PUBLIC_DB_PATHS.includes(normalized);
}

/**
 * هل الممثل ضمن أطراف المحادثة؟
 * @param {string} actorPhone
 * @param {Array<string|null|undefined>} partyPhones
 */
function canAccessThreadParties(actorPhone, partyPhones) {
  const parties = Array.isArray(partyPhones) ? partyPhones : [];
  return parties.some((candidate) => phonesOverlap(actorPhone, candidate));
}

/**
 * قواعد الوصول حسب نوع الخيط (بدون IO).
 * @returns {{ allowed: boolean, reason?: string }}
 */
function evaluateThreadAccess({ threadType, actorPhone, threadId, parties = {}, isAdmin = false }) {
  const type = String(threadType || '').trim();
  const actor = String(actorPhone || '').trim();
  const id = String(threadId || '').trim();

  if (!actor) return { allowed: false, reason: 'Missing actor phone.' };
  if (!id) return { allowed: false, reason: 'Thread id is required.' };

  switch (type) {
    case 'order':
      return canAccessThreadParties(actor, [
        parties.customerPhone,
        parties.merchantPhone,
        parties.courierPhone,
      ])
        ? { allowed: true }
        : { allowed: false, reason: 'Unauthorized chat access.' };

    case 'taxi':
      return canAccessThreadParties(actor, [parties.customerPhone, parties.driverPhone])
        ? { allowed: true }
        : { allowed: false, reason: 'Unauthorized chat access.' };

    case 'store':
      // بعد التحقق من وجود المتجر في الطبقة العليا: أي جلسة مصادَقة يمكنها فتح المحادثة
      // (صاحب المتجر أو زبون). لا نفتح الباب لطرف ثالث عبر Realtime — ذلك يُقفل بـ RLS deny-all.
      return { allowed: true };

    case 'support':
      if (phonesOverlap(actor, id) || isAdmin) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Unauthorized chat access.' };

    default:
      return { allowed: false, reason: 'Invalid thread type.' };
  }
}

/** من يحق له تعيين كل حالة تكسي (بعد أن يكون طرفاً في الرحلة) */
const TAXI_STATUS_ACTORS = Object.freeze({
  accepted: ['driver'],
  on_way: ['driver'],
  arrived: ['driver'],
  // الزبون يستطيع بدء العداد في الرحلة المفتوحة إذا نسي الكابتن (arrived فقط).
  picked_up: ['driver', 'customer'],
  // الزبون يستطيع إنهاء رحلة عالقة إذا نسي الكابتن الضغط على الإكمال.
  completed: ['driver', 'customer'],
  cancelled: ['customer', 'driver'],
  cancel_requested: ['customer'],
  return_waiting: ['driver'],
  return_on_way: ['driver'],
  return_arrived: ['driver'],
});

function canActorSetTaxiStatus(statusKey, actorRole) {
  const allowed = TAXI_STATUS_ACTORS[String(statusKey || '').trim()];
  if (!allowed) return false;
  return allowed.includes(String(actorRole || '').trim());
}

module.exports = {
  PUBLIC_DB_PATHS,
  isPublicDbPath,
  canAccessThreadParties,
  evaluateThreadAccess,
  TAXI_STATUS_ACTORS,
  canActorSetTaxiStatus,
};
