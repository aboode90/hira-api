const GROCERY_SUBS = new Set(['grocery', 'food_items']);
const HOUSEHOLD_SUBS = new Set(['home_goods']);

function departmentFromSubCategory(subCategory) {
  const sub = String(subCategory || '').trim();
  if (GROCERY_SUBS.has(sub)) return 'grocery';
  if (HOUSEHOLD_SUBS.has(sub)) return 'household';
  return '';
}

function parsePosConfig(profile) {
  const raw = profile?.pos_config ?? profile?.posConfig ?? {};
  const config = raw && typeof raw === 'object' ? raw : {};
  return {
    grocery: {
      nameAr: String(config.grocery?.nameAr || config.grocery?.name_ar || 'طلب غذائية').trim(),
      nameEn: String(config.grocery?.nameEn || config.grocery?.name_en || 'Alghaith Grocery').trim(),
    },
    household: {
      nameAr: String(config.household?.nameAr || config.household?.name_ar || 'طلب منزلية').trim(),
      nameEn: String(config.household?.nameEn || config.household?.name_en || 'Alghaith Home').trim(),
    },
  };
}

function isPosEnabledProfile(profile) {
  return profile?.pos_enabled === true || profile?.posEnabled === true;
}

function applyPosListingName(profile, subCategoryId) {
  if (!isPosEnabledProfile(profile)) return profile;
  const dept = departmentFromSubCategory(subCategoryId);
  if (!dept) return profile;
  const names = parsePosConfig(profile)[dept];
  if (!names?.nameAr) return profile;
  return {
    ...profile,
    store_name: names.nameAr,
    storeName: names.nameAr,
    posDepartment: dept,
  };
}

function departmentsFromOrderItems(order) {
  const items = Array.isArray(order?.items)
    ? order.items
    : Array.isArray(order?.lineItems)
      ? order.lineItems
      : [];
  const depts = new Set();
  for (const item of items) {
    const dept =
      String(item.posDepartment || item.pos_department || '').trim() ||
      departmentFromSubCategory(item.subCategory || item.sub_category);
    if (dept) depts.add(dept);
  }
  return [...depts];
}

function buildPosTickets(order) {
  const depts = departmentsFromOrderItems(order);
  const tickets = {};
  for (const dept of depts.length ? depts : ['grocery']) {
    tickets[dept] = { status: 'pending', printedAt: null, readyAt: null };
  }
  return tickets;
}

function allPosTicketsReady(order) {
  const tickets = order?.posTickets && typeof order.posTickets === 'object'
    ? order.posTickets
    : {};
  const keys = Object.keys(tickets);
  if (!keys.length) return false;
  return keys.every((key) => String(tickets[key]?.status || '') === 'ready');
}

function orderTouchesDepartment(order, department) {
  const dept = String(department || '').trim();
  if (!dept || dept === 'both' || dept === 'catalog' || dept === 'manager') {
    return true;
  }
  const tickets = order?.posTickets;
  if (tickets && typeof tickets === 'object' && Object.keys(tickets).length) {
    return Object.prototype.hasOwnProperty.call(tickets, dept);
  }
  return departmentsFromOrderItems(order).includes(dept);
}

module.exports = {
  GROCERY_SUBS,
  HOUSEHOLD_SUBS,
  departmentFromSubCategory,
  parsePosConfig,
  isPosEnabledProfile,
  applyPosListingName,
  departmentsFromOrderItems,
  buildPosTickets,
  allPosTicketsReady,
  orderTouchesDepartment,
};
