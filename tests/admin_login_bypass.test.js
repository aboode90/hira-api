const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesAdminLoginBypass,
  isAdminLoginBypassConfigured,
  normalizeBypassPhone,
} = require('../lib/admin_login_bypass');

test('normalizeBypassPhone handles Iraqi formats', () => {
  assert.equal(normalizeBypassPhone('07744009992'), '9647744009992');
  assert.equal(normalizeBypassPhone('+9647744009992'), '9647744009992');
  assert.equal(normalizeBypassPhone('7744009992'), '9647744009992');
});

test('bypass disabled when secret or phones missing', () => {
  assert.equal(
    matchesAdminLoginBypass('07744009992', 'long-enough-secret-01', {
      ADMIN_LOGIN_BYPASS_SECRET: '',
      ADMIN_LOGIN_BYPASS_PHONES: '9647744009992',
    }),
    false,
  );
  assert.equal(
    matchesAdminLoginBypass('07744009992', 'long-enough-secret-01', {
      ADMIN_LOGIN_BYPASS_SECRET: 'long-enough-secret-01',
      ADMIN_LOGIN_BYPASS_PHONES: '',
    }),
    false,
  );
  assert.equal(isAdminLoginBypassConfigured({}), false);
});

test('bypass accepts only allowlisted phone + matching secret', () => {
  const env = {
    ADMIN_LOGIN_BYPASS_SECRET: 'long-enough-secret-01',
    ADMIN_LOGIN_BYPASS_PHONES: '+9647744009992',
  };
  assert.equal(matchesAdminLoginBypass('07744009992', 'long-enough-secret-01', env), true);
  assert.equal(matchesAdminLoginBypass('07744009992', 'wrong-secret-value', env), false);
  assert.equal(matchesAdminLoginBypass('07741111111', 'long-enough-secret-01', env), false);
});

test('short secrets are rejected', () => {
  assert.equal(
    matchesAdminLoginBypass('07744009992', 'short', {
      ADMIN_LOGIN_BYPASS_SECRET: 'short',
      ADMIN_LOGIN_BYPASS_PHONES: '9647744009992',
    }),
    false,
  );
});
