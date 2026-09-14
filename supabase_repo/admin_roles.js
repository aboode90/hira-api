const {
  assertSupabaseAdmin,
  getPhoneVariants,
  resolvePhoneKey,
  canonicalPhone,
  nowIso,
  PLATFORM_ADMIN_PHONES,
} = require('./common');
const { getAppUser } = require('./users');

const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  FINANCE_VIEWER: 'finance_viewer',
  CONTENT_MANAGER: 'content_manager',
  SUPPORT: 'support',
});

const ROLE_HIERARCHY = Object.freeze({
  super_admin: 100,
  admin: 80,
  moderator: 60,
  finance_viewer: 40,
  content_manager: 40,
  support: 20,
});

function roleLevel(role) {
  return ROLE_HIERARCHY[String(role || '').trim()] || 0;
}

function hasMinRole(userRole, requiredRole) {
  return roleLevel(userRole) >= roleLevel(requiredRole);
}

function resolvePhoneSafe(phone) {
  const raw = String(phone || '').trim();
  return canonicalPhone(raw) || raw.replace(/\D/g, '') || raw;
}

function isConfiguredAdminPhoneSync(phone) {
  const variants = getPhoneVariants(phone);
  const envPhones = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const all = [...envPhones, ...PLATFORM_ADMIN_PHONES];
  return all.some((configured) =>
    getPhoneVariants(configured).some((variant) => variants.includes(variant)),
  );
}

async function readAdminRoleRow(phoneKey) {
  const supabase = assertSupabaseAdmin();
  const variants = getPhoneVariants(phoneKey);
  for (const variant of variants) {
    const { data, error } = await supabase
      .from('admin_roles')
      .select('phone, role, permissions, updated_at')
      .eq('phone', variant)
      .maybeSingle();
    if (error && !/does not exist/i.test(error.message || '')) {
      throw new Error(error.message);
    }
    if (data?.role) return data;
  }
  return null;
}

async function getAdminRoleWithPermissions(phone) {
  const { getAdminPermissions } = require('./admin_permissions');
  let phoneKey = resolvePhoneSafe(phone);
  try {
    phoneKey = await resolvePhoneKey(phone);
  } catch (_) {
    // نكمل بالمفتاح المحلي
  }
  const role = await getAdminRole(phone);
  let permissions = null;
  try {
    permissions = await getAdminPermissions(phone);
  } catch (_) {
    permissions = null;
  }
  return { role, permissions, phone: phoneKey };
}

async function getAdminRole(phone) {
  try {
    if (isConfiguredAdminPhoneSync(phone)) {
      return 'super_admin';
    }

    let phoneKey = resolvePhoneSafe(phone);
    try {
      phoneKey = await resolvePhoneKey(phone);
    } catch (_) {
      // نكمل بالمفتاح المحلي
    }

    if (isConfiguredAdminPhoneSync(phoneKey)) {
      return 'super_admin';
    }

    try {
      const row = await readAdminRoleRow(phoneKey);
      if (row?.role) return String(row.role).trim();
    } catch (_) {
      // جدول الأدوار غير متاح
    }

    try {
      const user = await getAppUser(phoneKey);
      if (String(user?.role ?? '').trim() === 'admin') {
        return 'admin';
      }
    } catch (_) {
      // تجاهل
    }

    return null;
  } catch (error) {
    console.warn('getAdminRole failed:', error?.message || error);
    // حتى مع فشل DB: أرقام المنصة تبقى super_admin
    if (isConfiguredAdminPhoneSync(phone)) return 'super_admin';
    return null;
  }
}

async function setAdminRole(adminPhone, targetPhone, newRole) {
  const adminRole = await getAdminRole(adminPhone);
  if (!adminRole || roleLevel(adminRole) < roleLevel('admin')) {
    throw new Error('Admin access required to manage roles.');
  }
  if (roleLevel(adminRole) < roleLevel('super_admin') && newRole === 'super_admin') {
    throw new Error('Only super admins can assign super admin role.');
  }

  const normalizedRole = String(newRole || '').trim();
  if (
    normalizedRole &&
    !ADMIN_ROLES[Object.keys(ADMIN_ROLES).find((k) => ADMIN_ROLES[k] === normalizedRole)]
  ) {
    throw new Error(`Invalid role: ${normalizedRole}`);
  }

  const targetKey = await resolvePhoneKey(targetPhone);
  const supabase = assertSupabaseAdmin();

  if (normalizedRole) {
    await supabase.from('admin_roles').upsert({
      phone: targetKey,
      role: normalizedRole,
      updated_at: nowIso(),
    });
  } else {
    await supabase.from('admin_roles').delete().eq('phone', targetKey);
  }

  const user = await getAppUser(targetKey);
  if (user && normalizedRole && String(user.role || '').trim() !== 'admin') {
    await supabase
      .from('app_users')
      .update({ role: 'admin', updated_at: nowIso() })
      .eq('phone', targetKey);
  }

  return { success: true, phone: targetKey, role: normalizedRole || null };
}

async function listAdminAccounts(adminPhone) {
  const adminRole = await getAdminRole(adminPhone);
  if (!adminRole || roleLevel(adminRole) < roleLevel('admin')) {
    throw new Error('Admin access required.');
  }

  const supabase = assertSupabaseAdmin();
  const [users, adminRows] = await Promise.all([
    supabase
      .from('app_users')
      .select('phone, full_name, role, updated_at')
      .order('updated_at', { ascending: false })
      .limit(500),
    supabase.from('admin_roles').select('phone, role, permissions, updated_at'),
  ]);

  if (users.error) throw new Error(users.error.message);
  if (adminRows.error && !/does not exist/i.test(adminRows.error.message || '')) {
    throw new Error(adminRows.error.message);
  }

  const roleByPhone = {};
  for (const row of adminRows.data || []) {
    roleByPhone[row.phone] = row;
  }

  const admins = [];
  for (const user of users.data || []) {
    const phone = String(user.phone || '').trim();
    if (!phone) continue;
    const roleRow = roleByPhone[phone];
    const role = String(roleRow?.role || '').trim();
    if (role || String(user.role || '').trim() === 'admin') {
      admins.push({
        phone,
        fullName: String(user.full_name || '').trim(),
        role: role || 'admin',
        adminAccess: true,
        permissions: roleRow?.permissions || null,
        updatedAt: roleRow?.updated_at || user.updated_at || null,
      });
    }
  }

  for (const [phone, roleRow] of Object.entries(roleByPhone)) {
    if (admins.some((a) => a.phone === phone)) continue;
    const role = String(roleRow?.role || '').trim();
    if (!role) continue;
    admins.push({
      phone,
      fullName: '',
      role,
      adminAccess: true,
      permissions: roleRow?.permissions || null,
      updatedAt: roleRow?.updated_at || null,
    });
  }

  return admins.sort((a, b) => {
    const levelDiff = roleLevel(b.role) - roleLevel(a.role);
    if (levelDiff !== 0) return levelDiff;
    return String(a.fullName || '').localeCompare(String(b.fullName || ''), 'ar');
  });
}

module.exports = {
  ADMIN_ROLES,
  ROLE_HIERARCHY,
  roleLevel,
  hasMinRole,
  getAdminRole,
  getAdminRoleWithPermissions,
  setAdminRole,
  listAdminAccounts,
};
