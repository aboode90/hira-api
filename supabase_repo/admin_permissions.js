const {
  assertSupabaseAdmin,
  resolvePhoneKey,
  nowIso,
  PLATFORM_ADMIN_PHONES,
  getPhoneVariants,
} = require('./common');
const { getConfiguredAdminPhones } = require('./users');

const ALL_PERMISSIONS = Object.freeze({
  CAN_REGISTER: 'canRegister',
  CAN_APPROVE: 'canApprove',
  CAN_DELETE: 'canDelete',
  CAN_SUSPEND: 'canSuspend',
  CAN_MANAGE_ADMINS: 'canManageAdmins',
});

const EMPTY_PERMISSIONS = Object.freeze({
  canRegister: false,
  canApprove: false,
  canDelete: false,
  canSuspend: false,
  canManageAdmins: false,
});

const ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  super_admin: {
    canRegister: true,
    canApprove: true,
    canDelete: true,
    canSuspend: true,
    canManageAdmins: true,
  },
  admin: {
    canRegister: true,
    canApprove: true,
    canDelete: true,
    canSuspend: true,
    canManageAdmins: false,
  },
  moderator: {
    canRegister: true,
    canApprove: true,
    canDelete: false,
    canSuspend: false,
    canManageAdmins: false,
  },
  support: { ...EMPTY_PERMISSIONS },
  finance_viewer: { ...EMPTY_PERMISSIONS },
  content_manager: {
    canRegister: true,
    canApprove: true,
    canDelete: false,
    canSuspend: false,
    canManageAdmins: false,
  },
});

function isHardcodedAdmin(phone) {
  const variants = getPhoneVariants(phone);
  for (const configured of PLATFORM_ADMIN_PHONES) {
    for (const variant of getPhoneVariants(configured)) {
      if (variants.includes(variant)) return true;
    }
  }
  return false;
}

async function isSuperAdmin(phone) {
  if (isHardcodedAdmin(phone)) return true;
  const envPhones = await getConfiguredAdminPhones();
  const variants = getPhoneVariants(phone);
  if (variants.some((v) => envPhones.has(v))) return true;

  const { getAdminRole, roleLevel, ADMIN_ROLES } = require('./admin_roles');
  const role = await getAdminRole(phone);
  return roleLevel(role) >= roleLevel(ADMIN_ROLES.SUPER_ADMIN);
}

function normalizePermissions(raw) {
  const perms = { ...EMPTY_PERMISSIONS };
  if (!raw || typeof raw !== 'object') return perms;
  for (const key of Object.keys(ALL_PERMISSIONS)) {
    const val = ALL_PERMISSIONS[key];
    if (raw[val] === true) perms[val] = true;
  }
  return perms;
}

async function getAdminPermissions(phone) {
  if (isHardcodedAdmin(phone)) {
    return { canRegister: true, canApprove: true, canDelete: true, canSuspend: true, canManageAdmins: true };
  }

  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const { data } = await supabase
    .from('admin_roles')
    .select('permissions, role')
    .eq('phone', phoneKey)
    .maybeSingle();

  if (data?.permissions && typeof data.permissions === 'object') {
    return normalizePermissions(data.permissions);
  }

  const roleName = String(data?.role || '').trim();
  if (ROLE_DEFAULT_PERMISSIONS[roleName]) {
    return { ...ROLE_DEFAULT_PERMISSIONS[roleName] };
  }

  if (roleName) {
    return { ...ROLE_DEFAULT_PERMISSIONS.moderator };
  }

  return { ...EMPTY_PERMISSIONS };
}

async function assertAdminPermission(phone, permission) {
  const perms = await getAdminPermissions(phone);
  if (!perms[permission]) {
    throw new Error(`Admin permission '${permission}' is required.`);
  }
  return true;
}

async function setAdminPermissions(adminPhone, targetPhone, permissions, role) {
  if (!(await isSuperAdmin(adminPhone))) {
    throw new Error('Super admin access required to manage permissions.');
  }

  const normalized = normalizePermissions(permissions);
  const phoneKey = await resolvePhoneKey(targetPhone);
  const supabase = assertSupabaseAdmin();
  const allowedRoles = new Set([
    'super_admin',
    'admin',
    'moderator',
    'support',
    'finance_viewer',
    'content_manager',
  ]);
  const requestedRole = String(role || '').trim();
  const nextRole = allowedRoles.has(requestedRole) ? requestedRole : '';

  const { data: existing } = await supabase
    .from('admin_roles')
    .select('phone, role')
    .eq('phone', phoneKey)
    .maybeSingle();

  if (existing) {
    const patch = { permissions: normalized, updated_at: nowIso() };
    if (nextRole) patch.role = nextRole;
    await supabase.from('admin_roles').update(patch).eq('phone', phoneKey);
  } else {
    await supabase.from('admin_roles').insert({
      phone: phoneKey,
      role: nextRole || 'moderator',
      permissions: normalized,
      updated_at: nowIso(),
    });
  }

  const { ensureAppUser } = require('./users');
  await ensureAppUser(phoneKey, { role: 'admin' });

  return {
    success: true,
    phone: phoneKey,
    permissions: normalized,
    role: nextRole || existing?.role || 'moderator',
  };
}

async function removeAdmin(adminPhone, targetPhone) {
  if (!(await isSuperAdmin(adminPhone))) {
    throw new Error('Super admin access required.');
  }
  if (isHardcodedAdmin(targetPhone)) {
    throw new Error('Cannot remove a protected admin account.');
  }

  const phoneKey = await resolvePhoneKey(targetPhone);
  const supabase = assertSupabaseAdmin();

  await supabase.from('admin_roles').delete().eq('phone', phoneKey);
  const user = await supabase.from('app_users').select('phone').eq('phone', phoneKey).maybeSingle();
  if (user?.data) {
    const currentRole = String(user.data.role || '').trim();
    if (currentRole === 'admin') {
      await supabase.from('app_users').update({ role: 'customer', updated_at: nowIso() }).eq('phone', phoneKey);
    }
  }

  return { success: true, phone: phoneKey };
}

async function listAllAdmins(adminPhone) {
  if (!(await isSuperAdmin(adminPhone))) {
    throw new Error('Super admin access required.');
  }

  const supabase = assertSupabaseAdmin();
  const [adminRows, users] = await Promise.all([
    supabase.from('admin_roles').select('phone, role, permissions, updated_at'),
    supabase.from('app_users').select('phone, full_name, role').order('updated_at', { ascending: false }),
  ]);

  if (adminRows.error) throw new Error(adminRows.error.message);
  if (users.error) throw new Error(users.error.message);

  const userByPhone = {};
  for (const u of users.data || []) {
    userByPhone[u.phone] = u;
  }

  // Add hardcoded admins
  const admins = [];
  const seen = new Set();
  for (const configured of PLATFORM_ADMIN_PHONES) {
    const variants = getPhoneVariants(configured);
    const phone = variants[0] || configured;
    if (seen.has(phone)) continue;
    seen.add(phone);
    admins.push({
      phone,
      fullName: userByPhone[phone]?.full_name || 'مدير المنصة',
      role: 'super_admin',
      permissions: { canRegister: true, canApprove: true, canDelete: true, canSuspend: true, canManageAdmins: true },
      isProtected: true,
      updatedAt: null,
    });
  }

  for (const row of adminRows.data || []) {
    const phone = String(row.phone || '').trim();
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    admins.push({
      phone,
      fullName: userByPhone[phone]?.full_name || '',
      role: String(row.role || 'admin').trim(),
      permissions: normalizePermissions(row.permissions),
      isProtected: false,
      updatedAt: row.updated_at || null,
    });
  }

  return admins;
}

module.exports = {
  ALL_PERMISSIONS,
  EMPTY_PERMISSIONS,
  normalizePermissions,
  getAdminPermissions,
  assertAdminPermission,
  setAdminPermissions,
  isSuperAdmin,
  removeAdmin,
  listAllAdmins,
};
