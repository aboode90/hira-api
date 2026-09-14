require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();
  const d = await s.from('driver_profiles').select('user_id,phone,is_approved,approval_status').eq('phone', '+9647726511479');
  console.log('DRIVER ROW:', JSON.stringify(d.data));

  const u = await s.from('app_users').select('id,phone,role,account_type').in('phone', ['+9647726511479', '9647726511479']);
  console.log('APP_USERS:', JSON.stringify(u.data));

  // تحقق من صحة RPC atomic_approve_driver
  const rpcDef = await s.rpc('atomic_approve_driver', { p_phone: '+9647726511479', p_approved: false });
  console.log('RPC false:', rpcDef.error ? 'ERR ' + rpcDef.error.message : 'OK');
})();
