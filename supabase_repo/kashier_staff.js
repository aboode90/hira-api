const crypto = require('crypto');
const {
  assertSupabaseAdmin,
  resolvePhoneKey,
} = require('./common');
const { base64UrlEncode } = require('../lib/session');
const { parsePosConfig } = require('../lib/pos_departments');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signKashierToken({ merchantPhone, staffId, role, department, displayName }) {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET is not configured.');
  const payload = {
    phone: merchantPhone,
    typ: 'kashier',
    staffId,
    role,
    dept: department,
    name: displayName,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
    se: 0,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest();
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function loginKashierStaff({ merchantPhone, username, pin }) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const { data: profile, error: profileError } = await supabase
    .from('merchant_profiles')
    .select('phone, pos_enabled, pos_config, store_name, is_approved')
    .eq('phone', phone)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.pos_enabled !== true) {
    throw new Error('هذا المتجر غير مفعّل للكاشير.');
  }

  const { data: staff, error } = await supabase
    .from('kashier_staff')
    .select('*')
    .eq('merchant_phone', phone)
    .eq('username', String(username || '').trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  if (!staff || staff.is_active === false || !verifyPin(pin, staff.pin_hash)) {
    throw new Error('اسم المستخدم أو الرمز غير صحيح.');
  }
  if (staff.role === 'catalog') {
    throw new Error('مدخل المنتجات غير مستخدم في الكاشير. استخدم كاشير غذائية أو منزلية.');
  }

  const token = signKashierToken({
    merchantPhone: phone,
    staffId: staff.id,
    role: staff.role,
    department: staff.department,
    displayName: staff.display_name,
  });
  return {
    token,
    staff: {
      id: staff.id,
      username: staff.username,
      role: staff.role,
      department: staff.department,
      displayName: staff.display_name,
    },
    store: {
      merchantPhone: phone,
      storeName: profile.store_name || '',
      posConfig: parsePosConfig(profile),
    },
  };
}

async function listKashierStaff(merchantPhone) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('kashier_staff')
    .select('id, merchant_phone, username, role, department, display_name, is_active, created_at')
    .eq('merchant_phone', phone)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function upsertKashierStaff(merchantPhone, input) {
  const phone = await resolvePhoneKey(merchantPhone);
  const username = String(input.username || '').trim().toLowerCase();
  const role = String(input.role || '').trim();
  const department = String(input.department || role || 'both').trim();
  const displayName = String(input.displayName || input.display_name || username).trim();
  if (!username || !role) throw new Error('username and role are required.');

  const supabase = assertSupabaseAdmin();
  const row = {
    merchant_phone: phone,
    username,
    role,
    department,
    display_name: displayName,
    is_active: input.isActive !== false,
  };
  if (input.id) row.id = input.id;
  if (input.pin) row.pin_hash = hashPin(input.pin);

  const { data: existing } = await supabase
    .from('kashier_staff')
    .select('id, pin_hash')
    .eq('merchant_phone', phone)
    .eq('username', username)
    .maybeSingle();

  if (existing?.id) {
    if (!row.pin_hash) delete row.pin_hash;
    const { data, error } = await supabase
      .from('kashier_staff')
      .update(row)
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  if (!row.pin_hash) throw new Error('pin is required for new staff.');
  const { data, error } = await supabase.from('kashier_staff').insert(row).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function enablePosStore(merchantPhone, config = {}, staffSeeds = []) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const { data: profile, error: profileError } = await supabase
    .from('merchant_profiles')
    .select('phone, store_name, pos_enabled, pos_config')
    .eq('phone', phone)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    throw new Error(
      'لا يوجد ملف تاجر لهذا الرقم. سجّل التاجر أولاً من قسم التجار ثم فعّل الكاشير.',
    );
  }

  const parsed = parsePosConfig({ pos_config: { ...(profile.pos_config || {}), ...config } });
  const grocerySeed = staffSeeds.find(
    (s) => s.username === 'grocery' || s.department === 'grocery',
  );
  const householdSeed = staffSeeds.find(
    (s) => s.username === 'household' || s.department === 'household',
  );
  const existingHints =
    (profile.pos_config && typeof profile.pos_config === 'object'
      ? profile.pos_config.adminPinHints
      : null) ||
    (config.adminPinHints && typeof config.adminPinHints === 'object'
      ? config.adminPinHints
      : {});
  const posConfig = {
    ...(profile.pos_config && typeof profile.pos_config === 'object' ? profile.pos_config : {}),
    ...config,
    grocery: parsed.grocery,
    household: parsed.household,
    adminPinHints: {
      grocery: String(grocerySeed?.pin || existingHints.grocery || '').trim(),
      household: String(householdSeed?.pin || existingHints.household || '').trim(),
    },
  };
  const { data: updated, error } = await supabase
    .from('merchant_profiles')
    .update({ pos_enabled: true, pos_config: posConfig })
    .eq('phone', phone)
    .select('phone')
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    throw new Error('تعذّر تفعيل الكاشير لهذا التاجر.');
  }

  const created = [];
  for (const seed of staffSeeds) {
    const row = await upsertKashierStaff(phone, seed);
    created.push({
      username: row.username,
      role: row.role,
      department: row.department,
      pin: seed.pin || null,
    });
  }
  return {
    merchantPhone: phone,
    storeName: profile.store_name || '',
    posEnabled: true,
    posConfig,
    staff: created,
  };
}

async function getPosMerchantOverview(merchantPhone) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const [{ data: profile }, { data: products }, { data: orders }, { data: sales }, staff] =
    await Promise.all([
      supabase
        .from('merchant_profiles')
        .select('phone, store_name, pos_enabled, pos_config')
        .eq('phone', phone)
        .maybeSingle(),
      supabase
        .from('merchant_products')
        .select('id, sub_category, is_approved, is_available')
        .eq('phone', phone),
      supabase
        .from('customer_orders')
        .select('id, status_key, delivery_status_key, order_payload, created_at')
        .eq('merchant_phone', phone)
        .order('created_at', { ascending: false })
        .limit(400),
      supabase
        .from('kashier_pos_sales')
        .select('id, total, department, created_at, cashier_name')
        .eq('merchant_phone', phone)
        .order('created_at', { ascending: false })
        .limit(400),
      listKashierStaff(phone),
    ]);

  const productRows = products || [];
  const groceryProducts = productRows.filter((p) =>
    ['grocery', 'food_items'].includes(String(p.sub_category || '')),
  ).length;
  const householdProducts = productRows.filter(
    (p) => String(p.sub_category || '') === 'home_goods',
  ).length;

  const counts = {
    pending: 0,
    preparing: 0,
    delivering: 0,
    awaitingSettlement: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const row of orders || []) {
    const payload = row.order_payload && typeof row.order_payload === 'object' ? row.order_payload : {};
    const status = String(row.status_key || payload.statusKey || '');
    if (status === 'delivered_awaiting_settlement') counts.awaitingSettlement += 1;
    else if (counts[status] !== undefined) counts[status] += 1;
    else if (status === 'accepted') counts.preparing += 1;
  }

  const posSalesTotal = (sales || []).reduce((sum, row) => sum + Number(row.total || 0), 0);

  const rawConfig =
    profile?.pos_config && typeof profile.pos_config === 'object'
      ? profile.pos_config
      : {};
  const hints =
    rawConfig.adminPinHints && typeof rawConfig.adminPinHints === 'object'
      ? rawConfig.adminPinHints
      : {};

  return {
    merchantPhone: phone,
    storeName: profile?.store_name || '',
    posEnabled: profile?.pos_enabled === true,
    posConfig: parsePosConfig(profile || {}),
    adminPinHints: {
      grocery: String(hints.grocery || '').trim(),
      household: String(hints.household || '').trim(),
    },
    products: {
      grocery: groceryProducts,
      household: householdProducts,
      total: productRows.length,
    },
    orders: counts,
    posSalesTotal,
    recentSales: (sales || []).slice(0, 20),
    staff,
    shiftsToday: (await listShiftsToday(phone)).length,
  };
}

async function listPosEnabledMerchants({ limit = 50 } = {}) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('merchant_profiles')
    .select('phone, store_name, pos_enabled, pos_config')
    .eq('pos_enabled', true)
    .order('store_name', { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100));
  if (error) throw error;
  return (data || []).map((row) => {
    const raw = row.pos_config && typeof row.pos_config === 'object' ? row.pos_config : {};
    const hints =
      raw.adminPinHints && typeof raw.adminPinHints === 'object' ? raw.adminPinHints : {};
    return {
      phone: String(row.phone || '').trim(),
      storeName: String(row.store_name || '').trim(),
      adminPinHints: {
        grocery: String(hints.grocery || '').trim(),
        household: String(hints.household || '').trim(),
      },
    };
  });
}

async function listShiftsToday(merchantPhone) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('kashier_shifts')
    .select('*')
    .eq('merchant_phone', phone)
    .gte('opened_at', start.toISOString())
    .order('opened_at', { ascending: false });
  if (error) {
    if (/does not exist|relation|schema cache/i.test(String(error.message || ''))) return [];
    throw error;
  }
  return data || [];
}

async function getOpenShift(merchantPhone, department) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  let query = supabase
    .from('kashier_shifts')
    .select('*')
    .eq('merchant_phone', phone)
    .is('closed_at', null)
    .order('opened_at', { ascending: false })
    .limit(1);
  if (department && department !== 'both') {
    query = query.eq('department', department);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (/does not exist|relation|schema cache/i.test(String(error.message || ''))) return null;
    throw error;
  }
  return data || null;
}

async function openShift({ merchantPhone, staffId, department, cashierName, openingCash }) {
  const cash = Number(openingCash);
  if (!Number.isFinite(cash) || cash <= 0) {
    throw new Error('أضف مبلغ الكاش في الصندوق أولاً لفتح النظام.');
  }
  const existing = await getOpenShift(merchantPhone, department);
  if (existing) return existing;
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('kashier_shifts')
    .insert({
      merchant_phone: phone,
      staff_id: staffId || null,
      department: department || 'grocery',
      cashier_name: cashierName || '',
      opening_cash: cash,
    })
    .select()
    .maybeSingle();
  if (error) {
    if (/does not exist|relation|schema cache/i.test(String(error.message || ''))) {
      throw new Error(
        'جدول الورديات غير مُنشأ بعد. نفّذ supabase/20260819_kashier_shifts.sql في Supabase SQL Editor.',
      );
    }
    throw error;
  }
  return data;
}

async function closeShift({ merchantPhone, department, closingCash, notes }) {
  const open = await getOpenShift(merchantPhone, department);
  if (!open) throw new Error('النظام مغلق.');
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const openedAt = open.opened_at;
  const { data: sales } = await supabase
    .from('kashier_pos_sales')
    .select('total')
    .eq('merchant_phone', phone)
    .gte('created_at', openedAt);
  const salesTotal = (sales || []).reduce((sum, row) => sum + Number(row.total || 0), 0);
  const expected = Number(open.opening_cash || 0) + salesTotal;
  const { data, error } = await supabase
    .from('kashier_shifts')
    .update({
      closed_at: new Date().toISOString(),
      closing_cash: Number(closingCash || 0),
      expected_cash: expected,
      sales_total: salesTotal,
      notes: String(notes || '').trim() || null,
    })
    .eq('id', open.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getKashierReports(merchantPhone, department) {
  const phone = await resolvePhoneKey(merchantPhone);
  const supabase = assertSupabaseAdmin();
  const openDay = await getOpenShift(phone, department);
  const shifts = await listShiftsToday(phone);
  if (!openDay?.opened_at) {
    return {
      todaySalesTotal: 0,
      todaySalesCount: 0,
      sales: [],
      orders: {
        pending: 0,
        preparing: 0,
        delivering: 0,
        completed: 0,
        cancelled: 0,
        awaitingSettlement: 0,
      },
      shifts,
      openShift: null,
    };
  }
  const iso = openDay.opened_at;
  const [{ data: sales }, { data: orders }] = await Promise.all([
    supabase
      .from('kashier_pos_sales')
      .select('*')
      .eq('merchant_phone', phone)
      .gte('created_at', iso)
      .order('created_at', { ascending: false })
      .limit(300),
    supabase
      .from('customer_orders')
      .select('id, status_key, order_payload, created_at')
      .eq('merchant_phone', phone)
      .gte('created_at', iso)
      .limit(400),
  ]);

  const salesRows = sales || [];
  const filteredSales = department && department !== 'both'
    ? salesRows.filter((s) => String(s.department || '') === department || !s.department)
    : salesRows;

  const orderCounts = { pending: 0, preparing: 0, delivering: 0, completed: 0, cancelled: 0, awaitingSettlement: 0 };
  for (const row of orders || []) {
    const payload = row.order_payload && typeof row.order_payload === 'object' ? row.order_payload : {};
    const status = String(row.status_key || payload.statusKey || '');
    if (status === 'delivered_awaiting_settlement') orderCounts.awaitingSettlement += 1;
    else if (orderCounts[status] !== undefined) orderCounts[status] += 1;
    else if (status === 'accepted') orderCounts.preparing += 1;
  }

  return {
    todaySalesTotal: filteredSales.reduce((sum, row) => sum + Number(row.total || 0), 0),
    todaySalesCount: filteredSales.length,
    sales: filteredSales,
    orders: orderCounts,
    shifts,
    openShift: openDay,
  };
}

module.exports = {
  hashPin,
  verifyPin,
  loginKashierStaff,
  listKashierStaff,
  upsertKashierStaff,
  enablePosStore,
  getPosMerchantOverview,
  listPosEnabledMerchants,
  getOpenShift,
  openShift,
  closeShift,
  listShiftsToday,
  getKashierReports,
};
