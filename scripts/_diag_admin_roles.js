/**
 * Diagnose /db/admin/roles with a Railway-signed session token.
 * Usage (from backend/): railway run node scripts/_diag_admin_roles.js
 */
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function mintToken(phone, secret, se = 0) {
  const payload = {
    phone,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    se,
  };
  const enc = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(enc).digest();
  return `${enc}.${b64url(sig)}`;
}

async function main() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  const phone = String(process.env.DIAG_PHONE || '9647744009992').trim();
  const base =
    String(process.env.DIAG_BASE || '').replace(
      /\/$/,
      '',
    );

  console.log(
    JSON.stringify({
      secretLen: secret.length,
      phone,
      base,
    }),
  );

  if (!secret) {
    console.error('SESSION_SECRET missing');
    process.exit(1);
  }

  // Direct repo checks first (no HTTP).
  try {
    const { getAdminRoleWithPermissions, getAdminRole } = require('../supabase_repo');
    const role = await getAdminRole(phone);
    console.log('direct_getAdminRole', role);
    const full = await getAdminRoleWithPermissions(phone);
    console.log('direct_roleData', JSON.stringify(full));
  } catch (error) {
    console.error('direct_repo_error', error?.message || error);
    console.error(error?.stack || '');
  }

  const token = mintToken(phone, secret, 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${base}/db/admin/roles`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    console.log('http_status', res.status);
    console.log('http_body', text.slice(0, 1200));
  } catch (error) {
    console.error('http_error', error?.message || error);
  } finally {
    clearTimeout(timer);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
