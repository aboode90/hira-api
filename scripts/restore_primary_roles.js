#!/usr/bin/env node
/**
 * Restores customer/merchant as primary role when session role was saved by mistake.
 * Usage: node scripts/restore_primary_roles.js
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const {
  getUserState,
  saveUserState,
  saveAppUser,
  getMerchantProfile,
  getCustomerProfile,
  canonicalPhone,
} = require('../supabase_repo');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: users, error } = await supabase.from('app_users').select('phone, role');
  if (error) throw error;

  let fixed = 0;
  for (const row of users || []) {
    const phone = canonicalPhone(row.phone);
    if (!phone) continue;

    const merchant = await getMerchantProfile(phone);
    const customer = await getCustomerProfile(phone);
    const hasMerchant = Boolean(merchant?.store_name?.trim());
    const hasCustomer = Boolean(customer?.display_name?.trim());

    let primaryRole = null;
    if (hasMerchant) primaryRole = 'merchant';
    else if (hasCustomer) primaryRole = 'customer';

    if (!primaryRole) continue;

    const sessionRoles = new Set(['delivery', 'driver', 'admin']);
    const currentRole = String(row.role || '').trim();
    const state = (await getUserState(phone)) || {};
    const stateRole = String(state.userRole || '').trim();

    if (!sessionRoles.has(currentRole) && !sessionRoles.has(stateRole)) {
      continue;
    }

    await saveAppUser(phone, { role: primaryRole, account_type: primaryRole == 'merchant' || primaryRole == 'customer' ? 'marketplace' : primaryRole });
    await saveUserState(phone, {
      ...state,
      userRole: primaryRole,
      accountType:
          primaryRole == 'merchant' || primaryRole == 'customer'
            ? 'marketplace'
            : primaryRole,
      adminAccess: state.adminAccess === true ? true : undefined,
    });
    fixed++;
  }

  console.log(`Restored primary role for ${fixed} account(s).`);
}

main().catch((error) => {
  console.error('restore_primary_roles failed:', error?.message || error);
  process.exit(1);
});
