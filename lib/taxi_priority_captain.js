/**
 * كابتن أولوية لطلبات التكسي الاقتصادي (بما فيها طلبات الأدمن باسم زبون).
 * أول PRIORITY_EXCLUSIVE_MS يُشعَّر «كاظم» فقط، ثم إشعار واحد لكل كباتن
 * الاقتصادي المتاحين دفعة واحدة (بدون رادار نطاق متوسّع).
 * توصيل البازار يبقى حصرياً عبر قائمة designated ولا يستخدم هذه النافذة.
 *
 * يمكن تجاوز الرقم عبر PRIORITY_TAXI_CAPTAIN_PHONE في البيئة.
 */

const PRIORITY_CAPTAIN_ENABLED = true;

/** كاظم عباس موسى — كابتن الأولوية الافتراضي. */
const DEFAULT_PRIORITY_PHONE = '+9647714520553';
const PRIORITY_EXCLUSIVE_MS = 15 * 1000;

function normalizePhoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

function getPriorityCaptainPhone() {
  const fromEnv = String(process.env.PRIORITY_TAXI_CAPTAIN_PHONE || '').trim();
  return fromEnv || DEFAULT_PRIORITY_PHONE;
}

function getPriorityCaptainPhones() {
  const primary = getPriorityCaptainPhone();
  const last10 = normalizePhoneLast10(primary);
  if (!last10) return [];
  // صيغ شائعة للتخزين/المقارنة
  return [`+964${last10}`, `0${last10}`, last10, `964${last10}`];
}

function isPriorityCaptainPhone(phone) {
  const key = normalizePhoneLast10(phone);
  if (!key) return false;
  return key === normalizePhoneLast10(getPriorityCaptainPhone());
}

function normalizeTaxiType(value) {
  return String(value || 'economic')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * هل هذا الطلب يخضع لنافذة الحصرية؟
 * — تكسي اقتصادي فقط (يشمل طلب الأدمن باسم زبون)
 * — ليس توصيل بازار
 */
function usesEconomicPriorityWindow(requestPayload = {}, taxiType) {
  if (!PRIORITY_CAPTAIN_ENABLED) return false;
  const payload =
    requestPayload && typeof requestPayload === 'object' ? requestPayload : {};
  if (String(payload.serviceKind || '').trim() === 'taxi_delivery') return false;
  const type = normalizeTaxiType(taxiType || payload.taxiType);
  return type === 'economic';
}

function priorityExclusiveUntilIso(createdAt) {
  const start = Date.parse(createdAt);
  const origin = Number.isFinite(start) ? start : Date.now();
  return new Date(origin + PRIORITY_EXCLUSIVE_MS).toISOString();
}

function isInEconomicPriorityWindow(requestPayload, taxiType, createdAt, nowMs = Date.now()) {
  if (!PRIORITY_CAPTAIN_ENABLED) return false;
  if (!usesEconomicPriorityWindow(requestPayload, taxiType)) return false;
  if (requestPayload?.priorityRadarOpened === true) return false;
  const start = Date.parse(createdAt || requestPayload?.createdAt);
  if (!Number.isFinite(start)) return true;
  return nowMs - start < PRIORITY_EXCLUSIVE_MS;
}

module.exports = {
  PRIORITY_CAPTAIN_ENABLED,
  DEFAULT_PRIORITY_PHONE,
  PRIORITY_EXCLUSIVE_MS,
  normalizePhoneLast10,
  getPriorityCaptainPhone,
  getPriorityCaptainPhones,
  isPriorityCaptainPhone,
  usesEconomicPriorityWindow,
  priorityExclusiveUntilIso,
  isInEconomicPriorityWindow,
};
