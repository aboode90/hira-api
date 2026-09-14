require('dotenv').config();

const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) {
  console.error('SUPABASE_URL not set');
  process.exit(1);
}
const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)[1];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const pool = new Pool({
  connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@${projectRef}.pooler.supabase.com:6543/postgres?pgbouncer=true`,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function run() {
  const client = await pool.connect();

  try {
    const sql = `
CREATE OR REPLACE FUNCTION public.notify_admin_new_merchant()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.admin_notifications (type, title, body, data)
  VALUES (
    'new_merchant',
    'تاجر جديد',
    'تاجر جديد سجل في المنصة: ' || COALESCE(NEW.store_name, 'غير معروف'),
    jsonb_build_object('phone', NEW.phone, 'merchantPhone', NEW.phone)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`;
    await client.query(sql);
    console.log('Trigger function updated successfully');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
