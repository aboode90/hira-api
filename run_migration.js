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
  connectionString: `postgresql://postgres.${projectRef}:${encodeURIComponent(serviceRoleKey)}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function run() {
  const client = await pool.connect();

  try {
    const check = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'admin_roles' AND column_name = 'permissions'
    `);

    if (check.rows.length > 0) {
      console.log('Column "permissions" already exists in admin_roles');
    } else {
      await client.query(`
        ALTER TABLE IF EXISTS public.admin_roles
          ADD COLUMN IF NOT EXISTS permissions jsonb;
      `);
      console.log('Added permissions column to admin_roles');
    }

    const updateResult = await client.query(`
      UPDATE public.admin_roles
        SET permissions = '{"canRegister": true, "canApprove": true, "canDelete": true, "canSuspend": true, "canManageAdmins": false}'
        WHERE permissions IS NULL;
    `);
    console.log(`Updated ${updateResult.rowCount} rows with default permissions`);

    const verify = await client.query(`
      SELECT phone, role, permissions FROM public.admin_roles ORDER BY updated_at DESC LIMIT 5
    `);
    console.log('admin_roles rows:');
    for (const row of verify.rows) {
      console.log(`  ${row.phone} | ${row.role} | ${JSON.stringify(row.permissions)}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
