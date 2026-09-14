require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  const variants = ['+9647726511479', '9647726511479', '07726511479', '7726511479'];

  const d = await s.from('driver_profiles').select('*').in('phone', variants);
  console.log('DRIVER_PROFILE:', d.error ? 'ERR ' + d.error.message : JSON.stringify(d.data, null, 1));

  const u = await s.from('app_users').select('phone,full_name,role,account_type,is_active').in('phone', variants);
  console.log('APP_USERS:', u.error ? 'ERR ' + u.error.message : JSON.stringify(u.data, null, 1));

  const st = await s.from('app_state').select('phone,state').in('phone', variants);
  console.log('APP_STATE:', st.error ? 'ERR ' + st.error.message : JSON.stringify((st.data || []).map(r => ({
    phone: r.phone,
    userRole: r.state?.userRole,
    accountType: r.state?.accountType,
    driverType: r.state?.driverType,
    driverProfile: r.state?.driverProfile ? {
      isApproved: r.state.driverProfile.isApproved,
      approvalStatus: r.state.driverProfile.approvalStatus,
      is_approved: r.state.driverProfile.is_approved,
      name: r.state.driverProfile.name,
    } : null,
    keys: Object.keys(r.state || {}),
  })), null, 1));
})();
