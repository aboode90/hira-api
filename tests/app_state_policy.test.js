const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeAppState,
  ALLOWED_APP_STATE_KEYS,
  FORBIDDEN_APP_STATE_KEYS,
} = require('../services/app_state_policy');

test('ALLOWED_APP_STATE_KEYS are UI-only', () => {
  assert.ok(ALLOWED_APP_STATE_KEYS.includes('darkMode'));
  assert.ok(ALLOWED_APP_STATE_KEYS.includes('skippedCustomerSetup'));
  assert.equal(FORBIDDEN_APP_STATE_KEYS.includes('merchantOffers'), true);
  assert.equal(FORBIDDEN_APP_STATE_KEYS.includes('adminAccess'), true);
  assert.equal(FORBIDDEN_APP_STATE_KEYS.includes('adminRole'), true);
});

test('sanitizeAppState keeps UI keys and drops business keys', () => {
  const input = {
    darkMode: true,
    skippedCustomerSetup: true,
    merchantOffers: [{ id: 'o1' }],
    customerName: 'Ali',
    adminAccess: true,
    adminRole: 'super_admin',
    userRole: 'merchant',
  };
  const out = sanitizeAppState(input);
  assert.equal(out.darkMode, true);
  assert.equal(out.skippedCustomerSetup, true);
  assert.equal('merchantOffers' in out, false);
  assert.equal('customerName' in out, false);
  assert.equal('adminAccess' in out, false);
  assert.equal('adminRole' in out, false);
  assert.equal('userRole' in out, false);
});

test('sanitizeAppState handles nullish input', () => {
  assert.deepEqual(sanitizeAppState(null), {});
});
