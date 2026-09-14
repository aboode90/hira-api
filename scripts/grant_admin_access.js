#!/usr/bin/env node
/**
 * Grants admin access to registered accounts in Supabase.
 * Usage:
 *   node scripts/grant_admin_access.js
 *   node scripts/grant_admin_access.js +9647701234567 07701234567
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  getAppUser,
  getUserState,
  saveUserState,
  saveAppUser,
  canonicalPhone,
} = require('../supabase_repo');
const { createClient } = require('@supabase/supabase-js');

function assertEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveTargetPhones(supabase, cliPhones) {
  if (cliPhones.length > 0) {
    const resolved = [];
    for (const phone of cliPhones) {
      const canonical = canonicalPhone(phone);
      if (canonical) resolved.push(canonical);
    }
    return [...new Set(resolved)];
  }

  const { data, error } = await supabase
    .from('app_users')
    .select('phone, updated_at')
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data || [])
    .map((row) => canonicalPhone(row.phone))
    .filter(Boolean);
}

async function grantAdminToPhone(phone) {
  const existingState = (await getUserState(phone)) || {};
  const appUser = (await getAppUser(phone)) || {};
  const primaryRole =
    appUser.role === 'customer' || appUser.role === 'merchant'
      ? appUser.role
      : existingState.userRole === 'customer' ||
          existingState.userRole === 'merchant'
        ? existingState.userRole
        : null;

  await saveUserState(phone, {
    ...existingState,
    adminAccess: true,
    userRole: primaryRole ?? existingState.userRole,
  });

  if (primaryRole) {
    await saveAppUser(phone, { role: primaryRole });
  }
}

function upsertAdminPhonesInEnv(phones) {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath) || phones.length === 0) return;

  const canonical = [...new Set(phones.map((phone) => canonicalPhone(phone)).filter(Boolean))];
  const line = `ADMIN_PHONES=${canonical.join(',')}`;
  const current = fs.readFileSync(envPath, 'utf8');
  const next = /(^|\n)ADMIN_PHONES=.*/.test(current)
    ? current.replace(/(^|\n)ADMIN_PHONES=.*/g, `\n${line}`)
    : `${current.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}

async function main() {
  const cliPhones = process.argv.slice(2).filter(Boolean);
  const supabase = assertEnv();
  const phones = await resolveTargetPhones(supabase, cliPhones);

  if (phones.length === 0) {
    console.log('No registered accounts found. Log in to the app once, then rerun this script.');
    process.exit(1);
  }

  for (const phone of phones) {
    await grantAdminToPhone(phone);
  }

  upsertAdminPhonesInEnv(phones);
  console.log(`Admin access granted for ${phones.length} account(s).`);
  console.log('You can open the app → choose "لوحة الإدارة" after login.');
  console.log('For Railway: set ADMIN_PHONES in project variables to the same phone(s).');
}

main().catch((error) => {
  console.error('grant_admin_access failed:', error?.message || error);
  process.exit(1);
});
