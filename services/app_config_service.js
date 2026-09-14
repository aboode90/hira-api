/**
 * App Config Service
 * إعدادات التطبيق الديناميكية — تعديل بدون تحديث المتجر
 */

const { assertSupabaseAdmin } = require('../supabase_repo/common');

let _cache = {};
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // دقيقة واحدة

async function _queryConfigs() {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase.from('app_configs').select('key, value');
  if (error) throw new Error(`Failed to load app configs: ${error.message}`);
  const map = {};
  for (const row of data || []) {
    map[row.key] = row.value;
  }
  _cache = map;
  _cacheTimestamp = Date.now();
  return map;
}

async function _getConfigs() {
  if (Date.now() - _cacheTimestamp > CACHE_TTL_MS || Object.keys(_cache).length === 0) {
    return await _queryConfigs();
  }
  return _cache;
}

function _mergeWithDefaults(key, config, defaults) {
  if (!config || typeof config !== 'object') return defaults;
  if (typeof defaults === 'object' && !Array.isArray(defaults)) {
    return { ...defaults, ...config };
  }
  return config;
}

// ── Taxi Pricing ──────────────────────────────────────────────────
async function getTaxiPricing() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('taxi_pricing', configs['taxi_pricing'], {
    tuktuk: { base: 1000, extraKm: 250, min: 1000 },
    wazz: { base: 1500, extraKm: 300, min: 1500 },
    economic: { base: 2000, extraKm: 500, min: 2000, includedKm: 1.5 },
    starx11MarkupPercent: 50,
    includedKm: 2.0,
    longDistanceThresholdKm: 15.0,
    longDistanceExtraKm: 400,
    roundingStep: 250,
    interGovernorateKmRate: 300,
    flatKmRateMinKm: 15,
    interGovernorateMinKm: 15,
    interGovernorateReturnRate: 0.6,
    localRoundTripReturnRate: 0.7,
    interGovernorateMinOneWayFare: 0,
    interGovernorateMinRoundTripFare: 0,
    longTripWaitMinKm: 20,
    longTripWaitFreeHours: 4,
    longTripWaitHourlyFee: 4000,
  });
}

async function getTaxiConfig() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('taxi_config', configs['taxi_config'], {
    searchTimeoutSeconds: 300,
    maxStops: 3,
    matchingRadiusKm: 1,
    matchingRadiusExpandKm: 1,
    matchingExpandIntervalSeconds: 30,
    maxDriversPerNotify: 40,
    pollingIntervalSeconds: 8,
    pendingPollIntervalSeconds: 3,
    activeTripPollIntervalSeconds: 5,
    driverIncomingPollIntervalSeconds: 5,
    enabledTaxiTypes: ['economic'],
    hurryBumpStep: 1000,
    maxHurryBumps: 10,
  });
}

async function getVoiceCallsEnabled() {
  const configs = await _getConfigs();
  const merged = _mergeWithDefaults('voice_calls', configs['voice_calls'], { enabled: true });
  return merged.enabled !== false;
}

async function isTaxiTypeEnabled(taxiType) {
  const type = String(taxiType || '').trim().toLowerCase();
  // ستاركس 11 راكب: «قريباً» للزبائن — فعّل لاحقاً من enabledTaxiTypes.
  if (type === 'starx11') return false;
  const cfg = await getTaxiConfig();
  const enabled = cfg.enabledTaxiTypes;
  if (!Array.isArray(enabled) || enabled.length === 0) return true;
  if (enabled.includes(type)) return true;
  return false;
}

async function getEnabledTaxiTypes() {
  const cfg = await getTaxiConfig();
  const enabled = cfg.enabledTaxiTypes;
  if (!Array.isArray(enabled) || enabled.length === 0) {
    return ['economic'];
  }
  return [...enabled];
}

// LEGACY — bazaar / taxi_delivery removed from Talab app.
// Destination fields remain for historical trips; product is always disabled.
const TAXI_DELIVERY_DEFAULTS = {
  enabled: false,
  destinationNameAr: 'بازار ومطاعم طلب',
  destinationLat: 32.9488919,
  destinationLng: 44.7766857,
  mapsUrl: 'https://maps.app.goo.gl/fKHmcxYr5gbx3omT6',
  // كابتن تكسي البازار الحصري (يُستخدم إن كانت القائمة فارغة في الإعدادات).
  designatedDriverPhones: ['07714520553'],
};

function normalizePhoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

function normalizeDesignatedDriverPhones(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const last10 = normalizePhoneLast10(raw);
    if (!last10 || seen.has(last10)) continue;
    seen.add(last10);
    const digits = String(raw || '').replace(/\D/g, '');
    // خزّن بصيغة محلية شائعة 07XXXXXXXXX إن أمكن
    const stored =
      digits.length >= 11 && digits.endsWith(last10)
        ? `0${last10}`
        : digits.startsWith('0')
          ? digits
          : `0${last10}`;
    out.push(stored);
  }
  return out;
}

function isPhoneInDesignatedList(phone, designatedPhones) {
  const key = normalizePhoneLast10(phone);
  if (!key) return false;
  const set = new Set(
    (designatedPhones || []).map(normalizePhoneLast10).filter(Boolean)
  );
  return set.has(key);
}

async function getTaxiDeliveryConfig() {
  const configs = await _getConfigs();
  const merged = _mergeWithDefaults(
    'taxi_delivery',
    configs['taxi_delivery'],
    TAXI_DELIVERY_DEFAULTS
  );
  return {
    ...merged,
    // Product removed — always report disabled even if DB still has enabled:true.
    enabled: false,
    destinationNameAr:
      String(merged.destinationNameAr || TAXI_DELIVERY_DEFAULTS.destinationNameAr).trim() ||
      TAXI_DELIVERY_DEFAULTS.destinationNameAr,
    destinationLat: Number(merged.destinationLat) || TAXI_DELIVERY_DEFAULTS.destinationLat,
    destinationLng: Number(merged.destinationLng) || TAXI_DELIVERY_DEFAULTS.destinationLng,
    mapsUrl:
      String(merged.mapsUrl || TAXI_DELIVERY_DEFAULTS.mapsUrl).trim() ||
      TAXI_DELIVERY_DEFAULTS.mapsUrl,
    designatedDriverPhones: normalizeDesignatedDriverPhones(
      merged.designatedDriverPhones,
    ),
  };
}

/** إعدادات عامة للتطبيق (بدون أرقام السائقين). */
async function getTaxiDeliveryPublicConfig() {
  const full = await getTaxiDeliveryConfig();
  return {
    enabled: full.enabled,
    destinationNameAr: full.destinationNameAr,
    destinationLat: full.destinationLat,
    destinationLng: full.destinationLng,
    mapsUrl: full.mapsUrl,
  };
}

// ── Phone Taxi (تكسي تلفوني) ──────────────────────────────────────
const PHONE_TAXI_DEFAULTS = {
  enabled: true,
  titleAr: 'طلب سيارة هاتفياً',
  subtitleAr: 'اتصل بأحد الأرقام لطلب سيارة عبر الهاتف',
  numbers: [],
};

function normalizePhoneTaxiEntry(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const phone = normalizePhoneLast10(raw.phone || raw.number || '');
  if (!phone) return null;
  const digits = String(raw.phone || raw.number || '').replace(/\D/g, '');
  const storedPhone =
    digits.length >= 11 && digits.endsWith(phone)
      ? `0${phone}`
      : digits.startsWith('0')
        ? digits
        : `0${phone}`;
  const id =
    String(raw.id || '').trim() ||
    `pt_${phone}_${index}`;
  return {
    id,
    nameAr: String(raw.nameAr || raw.name || '').trim() || 'تكسي تلفوني',
    phone: storedPhone,
    noteAr: String(raw.noteAr || raw.note || '').trim(),
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : index,
    enabled: raw.enabled !== false,
  };
}

function normalizePhoneTaxiNumbers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((raw, index) => {
    const entry = normalizePhoneTaxiEntry(raw, index);
    if (!entry) return;
    const key = normalizePhoneLast10(entry.phone);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  });
  out.sort((a, b) => a.sortOrder - b.sortOrder || a.nameAr.localeCompare(b.nameAr, 'ar'));
  return out;
}

async function getPhoneTaxiConfig() {
  const configs = await _getConfigs();
  const merged = _mergeWithDefaults(
    'phone_taxi',
    configs['phone_taxi'],
    PHONE_TAXI_DEFAULTS
  );
  return {
    enabled: merged.enabled !== false,
    titleAr:
      String(merged.titleAr || PHONE_TAXI_DEFAULTS.titleAr).trim() ||
      PHONE_TAXI_DEFAULTS.titleAr,
    subtitleAr:
      String(merged.subtitleAr || PHONE_TAXI_DEFAULTS.subtitleAr).trim() ||
      PHONE_TAXI_DEFAULTS.subtitleAr,
    numbers: normalizePhoneTaxiNumbers(merged.numbers),
  };
}

/** دليل الاتصال للزبون — أرقام مفعّلة فقط. */
async function getPhoneTaxiPublicConfig() {
  const full = await getPhoneTaxiConfig();
  return {
    enabled: full.enabled,
    titleAr: full.titleAr,
    subtitleAr: full.subtitleAr,
    numbers: full.numbers
      .filter((n) => n.enabled !== false)
      .map(({ id, nameAr, phone, noteAr, sortOrder }) => ({
        id,
        nameAr,
        phone,
        noteAr,
        sortOrder,
      })),
  };
}

// ── Map Defaults ──────────────────────────────────────────────────
async function getMapDefaults() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('map_defaults', configs['map_defaults'], {
    centerLat: 32.9256,
    centerLng: 44.7766,
    defaultZoom: 12,
  });
}

// ── Home Categories ───────────────────────────────────────────────
async function getHomeCategories() {
  const configs = await _getConfigs();
  const defaultOrder = ['restaurant', 'cars', 'product', 'eden_printing', 'global_shopping'];
  const raw = configs['home_categories'];
  if (!raw || typeof raw !== 'object') return { order: defaultOrder, categories: {} };
  return {
    order: Array.isArray(raw.order) ? raw.order : defaultOrder,
    categories: raw.categories || {},
  };
}

async function getSubCategories() {
  const configs = await _getConfigs();
  return configs['sub_categories'] || {};
}

// ── Neighborhoods ─────────────────────────────────────────────────
async function getNeighborhoods() {
  const configs = await _getConfigs();
  return configs['neighborhoods'] || {};
}

const IRAQ_ADMIN_AREAS_DEFAULTS = {
  schemaVersion: 1,
  governorates: [
    {
      id: 'wasit',
      nameAr: 'واسط',
      districts: [
        {
          id: 'kut',
          nameAr: 'الكوت',
          selectable: false,
          localities: [
            { id: 'kut_center', nameAr: 'مركز القضاء', selectable: false },
            { id: 'kut_sheikh_saad', nameAr: 'ناحية الشيخ سعد', selectable: false },
            { id: 'kut_wasit', nameAr: 'ناحية واسط', selectable: false },
            { id: 'kut_rural', nameAr: 'أرياف الكوت', selectable: false },
          ],
        },
        {
          id: 'suwayra',
          nameAr: 'الصويرة',
          selectable: true,
          localities: [
            { id: 'suwayra_center', nameAr: 'الصويرة', selectable: true },
            { id: 'suwayra_mazraa', nameAr: 'المزرعة', selectable: true },
            { id: 'suwayra_tanmiya', nameAr: 'التنمية', selectable: true },
            { id: 'suwayra_zubaydiya', nameAr: 'ناحية الزبيدية', selectable: false },
            { id: 'suwayra_shahimiya', nameAr: 'ناحية الشحيمية', selectable: false },
            { id: 'suwayra_rural', nameAr: 'أرياف الصويرة', selectable: false },
          ],
        },
        {
          id: 'aziziya',
          nameAr: 'العزيزية',
          selectable: false,
          localities: [
            { id: 'aziziya_center', nameAr: 'مركز القضاء', selectable: false },
            { id: 'aziziya_hafriya', nameAr: 'ناحية الحفرية', selectable: false },
            { id: 'aziziya_dabuni', nameAr: 'ناحية الدبوني', selectable: false },
            { id: 'aziziya_rural', nameAr: 'أرياف العزيزية', selectable: false },
          ],
        },
        {
          id: 'numaniya',
          nameAr: 'النعمانية',
          selectable: false,
          localities: [
            { id: 'numaniya_center', nameAr: 'مركز القضاء', selectable: false },
            { id: 'numaniya_ahrar', nameAr: 'ناحية الأحرار', selectable: false },
            { id: 'numaniya_rural', nameAr: 'أرياف النعمانية', selectable: false },
          ],
        },
        {
          id: 'hai',
          nameAr: 'الحي',
          selectable: false,
          localities: [
            { id: 'hai_center', nameAr: 'مركز القضاء', selectable: false },
            { id: 'hai_muwaffaqiya', nameAr: 'ناحية الموفقية', selectable: false },
            { id: 'hai_bashair', nameAr: 'ناحية البشائر', selectable: false },
            { id: 'hai_rural', nameAr: 'أرياف الحي', selectable: false },
          ],
        },
        {
          id: 'badra',
          nameAr: 'بدرة',
          selectable: false,
          localities: [
            { id: 'badra_center', nameAr: 'مركز القضاء', selectable: false },
            { id: 'badra_jassan', nameAr: 'ناحية جصان', selectable: false },
            { id: 'badra_zurbatiya', nameAr: 'ناحية زرباطية', selectable: false },
            { id: 'badra_rural', nameAr: 'أرياف بدرة', selectable: false },
          ],
        },
      ],
    },
  ],
};

async function getIraqAdminAreas() {
  const configs = await _getConfigs();
  const raw = configs['iraq_admin_areas'];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.governorates)) {
    return { ...IRAQ_ADMIN_AREAS_DEFAULTS };
  }
  return raw;
}

// ── Notification Texts ────────────────────────────────────────────
async function getNotificationTexts() {
  const configs = await _getConfigs();
  return configs['notification_texts'] || {};
}

async function getCartConfig() {
  const configs = await _getConfigs();
  const merged = _mergeWithDefaults('cart_config', configs['cart_config'], {
    minAmount: 1000,
    maxAmount: 500000,
    enabledCategoryIds: ['restaurant', 'product'],
  });
  const ids = Array.isArray(merged.enabledCategoryIds)
    ? merged.enabledCategoryIds
    : [];
  return {
    ...merged,
    // LEGACY — bazar_ghaith marketplace channel removed from Talab app.
    enabledCategoryIds: ids.filter(
      (id) => String(id || '').trim() !== 'bazar_ghaith',
    ),
  };
}

async function getCategoryConfig() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('category_config', configs['category_config'], {
    professionalExcludedIds: [],
  });
}

async function getServiceFees() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('service_fees', configs['service_fees'], {
    merchantOrderIqd: 250,
    taxiOrderIqd: 250,
    courierOrderIqd: 250,
    courierMinDeliveryFeeForCommissionIqd: 2000,
  });
}

async function getDeliveryConfig() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('delivery_config', configs['delivery_config'], {
    defaultFee: 3000,
    processingTimeoutMinutes: 30,
    // تسعيرة مندوب التوصيل للمتاجر/المطاعم (غير بازار طلب)
    // الأجرة = max(minFee, distanceKm * ratePerKm)
    minPerKm: 500,
    maxPerKm: 1500,
    defaultRatePerKm: 700,
    minFee: 1000,
    fastDeliverySurcharge: 2000,
    // حقول قديمة (للتوافق / بازار إن لزم) — الحساب الجديد لا يعتمد عليها
    firstFee: 1000,
    includedKm: 1.5,
    extraKm: 250,
    roundingStep: 250,
  });
}

async function getErrorMessages() {
  const configs = await _getConfigs();
  return _mergeWithDefaults('error_messages', configs['error_messages'], {
    network: 'خطأ في الاتصال. تحقق من الإنترنت وحاول مجدداً.',
    server: 'الخدمة غير متاحة حالياً. حاول لاحقاً.',
    generic: 'تعذر إكمال الطلب حالياً. حاول مرة أخرى.',
  });
}

// ── App Theme ─────────────────────────────────────────────────────
async function getAppTheme() {
  const configs = await _getConfigs();
  return configs['app_theme'] || {};
}

// ── Admin: Update Config ──────────────────────────────────────────
async function updateConfig(key, value) {
  const supabase = assertSupabaseAdmin();
  const { error } = await supabase
    .from('app_configs')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`Failed to update config: ${error.message}`);
  _cache = {};
  _cacheTimestamp = 0;
  return { success: true, key };
}

async function getAllConfigs() {
  return await _getConfigs();
}

module.exports = {
  getTaxiPricing,
  getTaxiConfig,
  isTaxiTypeEnabled,
  getEnabledTaxiTypes,
  getVoiceCallsEnabled,
  getTaxiDeliveryConfig,
  getTaxiDeliveryPublicConfig,
  normalizeDesignatedDriverPhones,
  normalizePhoneLast10,
  isPhoneInDesignatedList,
  TAXI_DELIVERY_DEFAULTS,
  getPhoneTaxiConfig,
  getPhoneTaxiPublicConfig,
  normalizePhoneTaxiNumbers,
  PHONE_TAXI_DEFAULTS,
  getMapDefaults,
  getHomeCategories,
  getSubCategories,
  getNeighborhoods,
  getIraqAdminAreas,
  IRAQ_ADMIN_AREAS_DEFAULTS,
  getNotificationTexts,
  getAppTheme,
  getCartConfig,
  getCategoryConfig,
  getDeliveryConfig,
  getServiceFees,
  getErrorMessages,
  updateConfig,
  getAllConfigs,
};
