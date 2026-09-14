require('dotenv').config();
const { assertSupabaseAdmin } = require('./supabase_repo/common');

(async () => {
  const s = assertSupabaseAdmin();

  // 1) تحقق من وجود العمود (بدون exec_sql — نستخدم hasColumn)
  const { hasColumn } = require('./supabase_repo/common');
  const exists = await hasColumn('merchant_products', 'times_ordered');
  console.log('times_ordered column exists:', exists);

  if (!exists) {
    // استخدم exec_sql إن توفر، وإلا أضف عبر update بلا مضمون — سنضيف عبر Supabase dashboard manual
    const { error } = await s.rpc('exec_sql', {
      query: 'ALTER TABLE merchant_products ADD COLUMN IF NOT EXISTS times_ordered bigint NOT NULL DEFAULT 0;',
    });
    console.log('exec_sql result:', error ? 'ERR ' + error.message : 'OK');
  }

  const exists2 = await hasColumn('merchant_products', 'times_ordered');
  console.log('after attempt, column exists:', exists2);
})();
