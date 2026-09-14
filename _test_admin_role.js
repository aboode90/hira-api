require('dotenv').config();
const { getAdminRoleWithPermissions } = require('./supabase_repo/admin_roles');

(async () => {
  for (const phone of ['9647744009992', '+9647744009992', '07744009992']) {
    try {
      const r = await getAdminRoleWithPermissions(phone);
      console.log(phone, '→', JSON.stringify({ role: r.role, permissions: r.permissions }));
    } catch (e) {
      console.log(phone, '→ ERR', e.message);
    }
  }
})();
