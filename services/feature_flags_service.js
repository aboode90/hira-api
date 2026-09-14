/**
 * Feature flags — stored in app_configs.feature_flags, editable from admin.
 */

const { getAllConfigs, updateConfig } = require('./app_config_service');

const FLAG_DEFINITIONS = [
  // ── المنتج ──
  {
    key: 'taxi_customer_enabled',
    group: 'product',
    labelAr: 'طلب التكسي للزبون',
    descriptionAr: 'إظهار «طلب تكسي» في قسم السيارات',
    defaultValue: true,
  },
  {
    key: 'taxi_delivery_enabled',
    group: 'product',
    labelAr: 'تكسي توصيل (قديم — معطّل)',
    descriptionAr: 'توصيل البازار عبر التكسي (متوقف — أُزيل من التطبيق)',
    defaultValue: false,
  },
  {
    key: 'phone_taxi_enabled',
    group: 'product',
    labelAr: 'طلب سيارة هاتفياً',
    descriptionAr: 'دليل اتصال لطلب سيارة عبر الهاتف (بدون طلب من التطبيق)',
    defaultValue: true,
  },
  {
    key: 'driver_registration_enabled',
    group: 'product',
    labelAr: 'تسجيل كابتن جديد',
    descriptionAr: 'السماح بتسجيل سائقين جدد',
    defaultValue: true,
  },
  {
    key: 'merchant_registration_enabled',
    group: 'product',
    labelAr: 'تسجيل تاجر جديد',
    descriptionAr: 'السماح بتسجيل تجار جدد',
    defaultValue: true,
  },
  {
    key: 'courier_registration_enabled',
    group: 'product',
    labelAr: 'تسجيل مندوب توصيل',
    descriptionAr: 'السماح بتسجيل مندوبين جدد',
    defaultValue: true,
  },
  {
    key: 'customer_registration_enabled',
    group: 'product',
    labelAr: 'تسجيل زبون جديد',
    descriptionAr: 'السماح بتسجيل زبائن جدد',
    defaultValue: true,
  },
  // ── الدردشة ──
  {
    key: 'chat_v2',
    group: 'chat',
    labelAr: 'دردشة Socket (VPS)',
    descriptionAr: 'استخدام Socket.io بدل HTTP polling',
    defaultValue: true,
  },
  {
    key: 'chat_timestamps',
    group: 'chat',
    labelAr: 'وقت الرسائل',
    descriptionAr: 'إظهار وقت الإرسال في المحادثات',
    defaultValue: true,
  },
  {
    key: 'chat_date_separators',
    group: 'chat',
    labelAr: 'فواصل التاريخ',
    descriptionAr: 'فاصل بين أيام المحادثة',
    defaultValue: true,
  },
  // ── التكسي (تشغيل) ──
  {
    key: 'taxi_cancel_direct',
    group: 'taxi',
    labelAr: 'إلغاء مباشر للزبون',
    descriptionAr: 'إلغاء الرحلة بدون موافقة الكابتن',
    defaultValue: true,
  },
  {
    key: 'taxi_show_banner',
    group: 'taxi',
    labelAr: 'إشعار طلب جديد للكابتن',
    descriptionAr: 'بانر النظام عند وصول طلب',
    defaultValue: true,
  },
  // ── المكالمات ──
  {
    key: 'call_cancelled_notify',
    group: 'calls',
    labelAr: 'إيقاف الرنين عند الإلغاء',
    descriptionAr: 'إيقاف الرنين للطرف الآخر عند إلغاء المتصل',
    defaultValue: true,
  },
  // ── عام ──
  {
    key: 'use_vps_socket',
    group: 'general',
    labelAr: 'اتصال VPS Socket',
    descriptionAr: 'Socket.io للتحديثات الفورية',
    defaultValue: true,
  },
  {
    key: 'inbox_filter',
    group: 'general',
    labelAr: 'فلتر صندوق الوارد',
    descriptionAr: 'فلترة المحادثات حسب النوع',
    defaultValue: true,
  },
];

const GROUP_LABELS = {
  product: 'الميزات والتسجيل',
  chat: 'الدردشة',
  taxi: 'تشغيل التكسي',
  calls: 'المكالمات',
  general: 'عام',
};

function defaultFlagsMap() {
  const map = {};
  for (const def of FLAG_DEFINITIONS) {
    map[def.key] = def.defaultValue;
  }
  return map;
}

function normalizeFlags(raw = {}) {
  const defaults = defaultFlagsMap();
  const stored = raw?.flags && typeof raw.flags === 'object' ? raw.flags : raw;
  const merged = { ...defaults };
  if (stored && typeof stored === 'object') {
    for (const def of FLAG_DEFINITIONS) {
      const value = stored[def.key];
      if (typeof value === 'boolean') merged[def.key] = value;
    }
  }
  for (const def of FLAG_DEFINITIONS) {
    const envKey = `FEATURE_${def.key.toUpperCase()}`;
    if (process.env[envKey] !== undefined) {
      merged[def.key] = process.env[envKey] === 'true' || process.env[envKey] === '1';
    }
  }
  // LEGACY — taxi_delivery / bazaar product removed from Talab app.
  merged.taxi_delivery_enabled = false;
  return merged;
}

async function getFeatureFlagsConfig() {
  const configs = await getAllConfigs();
  const raw = configs['feature_flags'];
  if (!raw || typeof raw !== 'object') {
    return {
      schemaVersion: 1,
      updatedAt: null,
      flags: defaultFlagsMap(),
    };
  }
  return {
    schemaVersion: Number(raw.schemaVersion) || 1,
    updatedAt: raw.updatedAt || null,
    flags: normalizeFlags(raw),
  };
}

async function getPublicFeatureFlags() {
  const config = await getFeatureFlagsConfig();
  return {
    ...config.flags,
    _meta: {
      version: String(config.schemaVersion || 1),
      updatedAt: config.updatedAt || new Date().toISOString(),
    },
  };
}

async function getAdminFeatureFlags() {
  const config = await getFeatureFlagsConfig();
  return {
    schemaVersion: config.schemaVersion,
    updatedAt: config.updatedAt,
    flags: config.flags,
    definitions: FLAG_DEFINITIONS.map((def) => ({
      ...def,
      value: config.flags[def.key] ?? def.defaultValue,
    })),
    groups: GROUP_LABELS,
  };
}

async function saveFeatureFlags(patch = {}) {
  const current = await getFeatureFlagsConfig();
  const nextFlags = { ...current.flags };
  const input = patch?.flags && typeof patch.flags === 'object' ? patch.flags : patch;
  for (const def of FLAG_DEFINITIONS) {
    if (typeof input[def.key] === 'boolean') {
      nextFlags[def.key] = input[def.key];
    }
  }
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    flags: nextFlags,
  };
  await updateConfig('feature_flags', payload);
  return getAdminFeatureFlags();
}

module.exports = {
  FLAG_DEFINITIONS,
  GROUP_LABELS,
  getPublicFeatureFlags,
  getAdminFeatureFlags,
  saveFeatureFlags,
  normalizeFlags,
  defaultFlagsMap,
};
