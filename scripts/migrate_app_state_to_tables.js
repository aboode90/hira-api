/**
 * Migrate merchantStore / driverProfile / courierProfile from app_state into tables.
 * Run once after applying supabase/20260626_driver_courier_profiles.sql
 */
const { assertSupabaseAdmin } = require('../supabase_repo/common');
const { resolvePhoneKey } = require('../supabase_repo/common');
const { ensureAppUser } = require('../supabase_repo/users');
const {
  saveMerchantProfile,
  merchantProfilePayloadFromAppState,
} = require('../supabase_repo/merchants');
const {
  saveDriverProfile,
  saveCourierProfile,
} = require('../supabase_repo/operator_profiles');
const { FORBIDDEN_APP_STATE_KEYS } = require('../services/app_state_policy');

async function main() {
  const supabase = assertSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('app_state')
    .select('phone, state')
    .limit(5000);

  if (error) throw error;

  let merchants = 0;
  let drivers = 0;
  let couriers = 0;
  let cleaned = 0;

  for (const row of rows || []) {
    const phone = String(row.phone || '').trim();
    const state = row.state || {};
    if (!phone || typeof state !== 'object') continue;

    const phoneKey = await resolvePhoneKey(phone);
    await ensureAppUser(phoneKey);

    if (state.merchantStore && typeof state.merchantStore === 'object') {
      const payload = merchantProfilePayloadFromAppState(state, null);
      if (payload?.store_name) {
        await saveMerchantProfile(phoneKey, payload);
        merchants += 1;
      }
    }

    if (state.driverProfile && typeof state.driverProfile === 'object') {
      await saveDriverProfile(phoneKey, state.driverProfile);
      drivers += 1;
    }

    if (state.courierProfile && typeof state.courierProfile === 'object') {
      await saveCourierProfile(phoneKey, state.courierProfile);
      couriers += 1;
    }

    const hasForbidden = FORBIDDEN_APP_STATE_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(state, key)
    );
    if (!hasForbidden) continue;

    const next = { ...state };
    for (const key of FORBIDDEN_APP_STATE_KEYS) {
      delete next[key];
    }

    const { error: upsertError } = await supabase.from('app_state').upsert({
      phone: phoneKey,
      state: next,
      updated_at: new Date().toISOString(),
    });
    if (upsertError) {
      console.error(`cleanup failed ${phoneKey}:`, upsertError.message);
      continue;
    }
    cleaned += 1;
  }

  console.log(
    `migrate_app_state_to_tables: merchants=${merchants} drivers=${drivers} couriers=${couriers} cleaned=${cleaned}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
