/**
 * Strip legacy orders/items blobs from app_state rows (run once after deploy).
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */
const { assertSupabaseAdmin } = require('../supabase_repo/common');
const { FORBIDDEN_APP_STATE_KEYS } = require('../services/app_state_policy');

async function main() {
  const supabase = assertSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('app_state')
    .select('phone, state')
    .limit(5000);

  if (error) throw error;

  let updated = 0;
  for (const row of rows || []) {
    const state = row.state || {};
    const hasForbidden = FORBIDDEN_APP_STATE_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(state, key)
    );
    if (!hasForbidden) continue;

    const next = { ...state };
    for (const key of FORBIDDEN_APP_STATE_KEYS) {
      delete next[key];
    }

    const { error: upsertError } = await supabase.from('app_state').upsert({
      phone: row.phone,
      state: next,
      updated_at: new Date().toISOString(),
    });
    if (upsertError) {
      console.error(`Failed ${row.phone}:`, upsertError.message);
      continue;
    }
    updated += 1;
  }

  console.log(`strip_app_state_orders_items: cleaned ${updated} row(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
