require('dotenv').config();
const { assertSupabaseAdmin, nowIso } = require('./supabase_repo/common');
const { getAppUserId } = require('./supabase_repo/users');

(async () => {
  const s = assertSupabaseAdmin();
  const phoneKey = '+9647726511479';
  const appUserId = await getAppUserId(phoneKey);
  console.log('appUserId:', appUserId);

  // تحديث مباشر لجدول driver_profiles بالموافقة
  const { data, error } = await s
    .from('driver_profiles')
    .update({
      approval_status: 'approved',
      is_approved: true,
      user_id: appUserId,
      updated_at: nowIso(),
    })
    .eq('phone', phoneKey)
    .select();
  console.log('UPDATE:', error ? 'ERR ' + error.message : JSON.stringify(data));

  // تحقق
  const check = await s.from('driver_profiles').select('phone,user_id,is_approved,approval_status').eq('phone', phoneKey);
  console.log('VERIFY:', JSON.stringify(check.data));
})();
