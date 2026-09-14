/**
 * أقسام المهنيين — افتراضيات + تخصيص من لوحة الأدمن (platform_settings).
 */

const DEFAULT_PROFESSIONAL_CATEGORIES = [
  { id: 'plumber', labelAr: 'سباك', labelEn: 'Plumber', enabled: true, builtin: true },
  { id: 'electrician', labelAr: 'كهربائي', labelEn: 'Electrician', enabled: true, builtin: true },
  { id: 'ac_tech', labelAr: 'فني تكييف', labelEn: 'AC Technician', enabled: true, builtin: true },
  {
    id: 'carpenter_aluminum_pvc',
    labelAr: 'نجار والمنيوم و PVC',
    labelEn: 'Carpenter, Aluminum & PVC',
    enabled: true,
    builtin: true,
  },
  { id: 'cleaner', labelAr: 'تنظيف منازل', labelEn: 'Home Cleaner', enabled: true, builtin: true },
  { id: 'blacksmith', labelAr: 'حداد', labelEn: 'Blacksmith', enabled: true, builtin: true },
  { id: 'painter', labelAr: 'صباغ', labelEn: 'Painter', enabled: true, builtin: true },
  { id: 'builder', labelAr: 'بناء', labelEn: 'Builder', enabled: true, builtin: true },
  { id: 'cctv_tech', labelAr: 'فني كاميرات مراقبة', labelEn: 'CCTV Technician', enabled: true, builtin: true },
  { id: 'network_tech', labelAr: 'فني إنترنت وشبكات', labelEn: 'Network Technician', enabled: true, builtin: true },
  { id: 'loading_worker', labelAr: 'عامل تحميل وتنزيل', labelEn: 'Loading Worker', enabled: true, builtin: true },
  { id: 'gardener', labelAr: 'عامل حدائق', labelEn: 'Gardener', enabled: true, builtin: true },
  { id: 'scaffolding', labelAr: 'سكلات - عدد - أليات', labelEn: 'Scaffolding, Tools & Machinery', enabled: true, builtin: true },
  { id: 'car_services', labelAr: 'خدمات سيارات', labelEn: 'Car Services', enabled: true, builtin: true },
  {
    id: 'home_appliance_repair',
    labelAr: 'صيانة أجهزة المنزل والعدد اليدوي',
    labelEn: 'Home Appliance & Hand Tools Repair',
    enabled: true,
    builtin: true,
  },
  { id: 'photography', labelAr: 'استوديوهات تصوير', labelEn: 'Photography Studio', enabled: true, builtin: true },
  { id: 'wedding', labelAr: 'تجهيز الأعراس والمناسبات', labelEn: 'Wedding & Events', enabled: true, builtin: true },
];

const SLUG_RE = /^[a-z][a-z0-9_]{1,48}$/;

/** أقسام قديمة دُمجت — تُعرض وتُحفظ تحت المعرّف الجديد. */
const LEGACY_PROFESSIONAL_CATEGORY_ALIASES = {
  carpenter: 'carpenter_aluminum_pvc',
  aluminum_glass: 'carpenter_aluminum_pvc',
};

function normalizeProfessionalCategoryId(id) {
  const value = String(id || '').trim();
  if (!value) return '';
  return LEGACY_PROFESSIONAL_CATEGORY_ALIASES[value] || value;
}

function professionalCategoryMatches(storedId, filterId) {
  const filter = normalizeProfessionalCategoryId(filterId);
  if (!filter) return true;
  const stored = normalizeProfessionalCategoryId(storedId);
  return Boolean(stored) && stored === filter;
}

function normalizeCategoryEntry(raw = {}, fallbackBuiltin = false) {
  const id = String(raw.id || '').trim().toLowerCase();
  const labelAr = String(raw.labelAr ?? raw.label_ar ?? raw.label ?? '').trim();
  const labelEn = String(raw.labelEn ?? raw.label_en ?? '').trim();
  if (!id || !labelAr) return null;
  return {
    id,
    labelAr,
    labelEn: labelEn || labelAr,
    enabled: raw.enabled !== false,
    builtin: Boolean(raw.builtin ?? fallbackBuiltin),
    sortOrder: Number.isFinite(Number(raw.sortOrder ?? raw.sort_order))
      ? Number(raw.sortOrder ?? raw.sort_order)
      : null,
  };
}

function mergeProfessionalCategories(storedItems = []) {
  const byId = new Map();
  for (const entry of DEFAULT_PROFESSIONAL_CATEGORIES) {
    byId.set(entry.id, { ...entry });
  }

  const stored = Array.isArray(storedItems) ? storedItems : [];
  for (const raw of stored) {
    const normalized = normalizeCategoryEntry(raw, false);
    if (!normalized) continue;
    // لا تُبقِ أقسام النجار/الألمنيوم القديمة في القائمة المعروضة.
    const id = normalizeProfessionalCategoryId(normalized.id);
    if (id !== normalized.id) {
      const mergedTarget = byId.get(id);
      if (mergedTarget) {
        byId.set(id, {
          ...mergedTarget,
          enabled: normalized.enabled !== false && mergedTarget.enabled !== false,
          sortOrder: normalized.sortOrder ?? mergedTarget.sortOrder,
        });
      }
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, {
        ...existing,
        labelAr: normalized.labelAr || existing.labelAr,
        labelEn: normalized.labelEn || existing.labelEn,
        enabled: normalized.enabled,
        sortOrder: normalized.sortOrder ?? existing.sortOrder,
      });
      continue;
    }
    byId.set(id, { ...normalized, id });
  }

  const items = [...byId.values()].sort((a, b) => {
    const orderA = a.sortOrder ?? 9999;
    const orderB = b.sortOrder ?? 9999;
    if (orderA !== orderB) return orderA - orderB;
    return a.labelAr.localeCompare(b.labelAr, 'ar');
  });

  return items.map((item, index) => ({
    ...item,
    sortOrder: item.sortOrder ?? index + 1,
  }));
}

function normalizeAdminCategoriesPayload(items) {
  if (!Array.isArray(items)) {
    throw new Error('قائمة المهن مطلوبة.');
  }

  const normalized = [];
  const seen = new Set();
  for (const raw of items) {
    const entry = normalizeCategoryEntry(raw, false);
    if (!entry) continue;
    if (!SLUG_RE.test(entry.id)) {
      throw new Error(`معرّف المهنة غير صالح: ${entry.id}. استخدم حروفاً إنجليزية صغيرة وأرقام و _ فقط.`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`معرّف المهنة مكرر: ${entry.id}`);
    }
    seen.add(entry.id);
    const builtin = DEFAULT_PROFESSIONAL_CATEGORIES.some((d) => d.id === entry.id);
    normalized.push({
      ...entry,
      builtin,
      sortOrder: normalized.length + 1,
    });
  }

  if (normalized.length === 0) {
    throw new Error('يجب الإبقاء على مهنة واحدة على الأقل.');
  }

  return normalized;
}

function buildCategoryMaps(items) {
  const ids = new Set();
  const names = {};
  for (const item of items) {
    ids.add(item.id);
    names[item.id] = { ar: item.labelAr, en: item.labelEn || item.labelAr };
  }
  return { ids, names };
}

function labelForCategoryId(categoryId, items = DEFAULT_PROFESSIONAL_CATEGORIES) {
  const id = normalizeProfessionalCategoryId(categoryId);
  if (!id) return '—';
  const match = items.find((item) => item.id === id);
  if (match) return match.labelAr;
  const fallback = DEFAULT_PROFESSIONAL_CATEGORIES.find((item) => item.id === id);
  return fallback?.labelAr || id;
}

module.exports = {
  DEFAULT_PROFESSIONAL_CATEGORIES,
  LEGACY_PROFESSIONAL_CATEGORY_ALIASES,
  SLUG_RE,
  normalizeProfessionalCategoryId,
  professionalCategoryMatches,
  mergeProfessionalCategories,
  normalizeAdminCategoriesPayload,
  buildCategoryMaps,
  labelForCategoryId,
};
