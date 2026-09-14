require('dotenv').config();
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) {
  console.error('SUPABASE_URL not set');
  process.exit(1);
}
const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)[1];
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbPassword = process.env.SUPABASE_DB_PASSWORD || serviceRoleKey;

// Try direct connection instead of pooled
async function tryConnect() {
  const hosts = [
    { host: `db.${projectRef}.supabase.co`, port: 5432, name: 'direct' },
    { host: `aws-0-eu-central-1.pooler.supabase.com`, port: 6543, name: 'pooled' },
    { host: `${projectRef}.supabase.co`, port: 5432, name: 'alt' },
  ];

  for (const { host, port, name } of hosts) {
    try {
      const pool = new Pool({
        connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@${host}:${port}/postgres`,
        ssl: { rejectUnauthorized: false },
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      const client = await pool.connect();
      try {
        await client.query(`
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
        `);
        console.log(`✅ Trigger fixed via ${name} connection`);
        process.exit(0);
      } finally {
        client.release();
        await pool.end();
      }
    } catch (e) {
      console.warn(`❌ ${host}:${port} (${name}): ${e.message?.substring(0, 80)}`);
    }
  }
  console.error('All connection attempts failed');
  process.exit(1);
}

tryConnect();
