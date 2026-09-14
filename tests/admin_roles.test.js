const test = require('node:test');
const assert = require('node:assert/strict');
const { hasMinRole, roleLevel } = require('../supabase_repo/admin_roles');

test('hasMinRole respects hierarchy', () => {
  assert.equal(hasMinRole('super_admin', 'moderator'), true);
  assert.equal(hasMinRole('moderator', 'admin'), false);
  assert.equal(roleLevel('admin'), 80);
});
