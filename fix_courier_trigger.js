// One-time fix: update notify_admin_new_courier trigger to use display_name
require('dotenv').config();

const { assertSupabaseAdmin } = require('./supabase_repo/common');

async function main() {
  const supabase = assertSupabaseAdmin();
  const sql = `
    CREATE OR REPLACE FUNCTION public.notify_admin_new_courier()
    RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO public.admin_notifications (type, title, body, data)
      VALUES (
        'new_courier',
        'مندوب جديد',
        'مندوب توصيل جديد سجل في المنصة: ' || COALESCE(NEW.display_name, 'غير معروف'),
        jsonb_build_object('phone', NEW.phone, 'courierPhone', NEW.phone)
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER;
  `;

  const { error } = await supabase.rpc('run_sql_courier_fix');
  if (error) {
    // Try raw query through Supabase REST endpoint
    const { error: rawError } = await supabase.from('_sql_migration').insert({
      id: 'fix_courier_trigger_20260701',
      sql,
      applied_at: new Date().toISOString(),
    });
    if (rawError) {
      console.log('RPC approach failed, trying raw SQL via REST...');
    }
  }

  // Actually, let's use the most reliable approach: Supabase management API
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const url = supabaseUrl.replace('.co', '.co/rest/v1');
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ sql }),
    }
  );

  console.log('Response status:', response.status);
  const text = await response.text();
  console.log('Response:', text.substring(0, 500));
}

main().catch(e => console.error('Error:', e.message));
