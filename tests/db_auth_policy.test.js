const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPublicDbPath,
  PUBLIC_DB_PATHS,
  evaluateThreadAccess,
  canAccessThreadParties,
  canActorSetTaxiStatus,
} = require('../lib/db_auth_policy');
const {
  requireAuthorizedPhone,
  requireOptionalAuthorizedPhone,
} = require('../routes/_middleware');

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test('public db paths allowlist is explicit', () => {
  assert.equal(isPublicDbPath('/professionals'), true);
  assert.equal(isPublicDbPath('/validate-promo'), true);
  assert.equal(isPublicDbPath('/admin/notifications'), false);
  assert.equal(isPublicDbPath('/chat/inbox/threads'), false);
  assert.ok(PUBLIC_DB_PATHS.length >= 8);
});

test('requireAuthorizedPhone blocks cross-user phone access', () => {
  const res = mockRes();
  const req = {
    method: 'GET',
    query: { phone: '07741111111' },
    authPhone: '9647744009992',
  };
  const phone = requireAuthorizedPhone(req, res);
  assert.equal(phone, null);
  assert.equal(res.statusCode, 403);
});

test('requireAuthorizedPhone allows matching phone variants', () => {
  const res = mockRes();
  const req = {
    method: 'GET',
    query: { phone: '07744009992' },
    authPhone: '9647744009992',
  };
  const phone = requireAuthorizedPhone(req, res);
  assert.equal(phone, '9647744009992');
  assert.equal(res.statusCode, 200);
});

test('requireOptionalAuthorizedPhone falls back to session phone', () => {
  const res = mockRes();
  const req = {
    method: 'GET',
    query: {},
    authPhone: '9647744009992',
  };
  const phone = requireOptionalAuthorizedPhone(req, res);
  assert.equal(phone, '9647744009992');
});

test('order chat: only parties can access', () => {
  const parties = {
    customerPhone: '9647000000001',
    merchantPhone: '9647000000002',
    courierPhone: '9647000000003',
  };
  assert.equal(
    evaluateThreadAccess({
      threadType: 'order',
      actorPhone: '9647000000001',
      threadId: 'ord-1',
      parties,
    }).allowed,
    true,
  );
  assert.equal(
    evaluateThreadAccess({
      threadType: 'order',
      actorPhone: '9647999999999',
      threadId: 'ord-1',
      parties,
    }).allowed,
    false,
  );
});

test('taxi chat: stranger rejected; support admin allowed', () => {
  assert.equal(
    evaluateThreadAccess({
      threadType: 'taxi',
      actorPhone: '9647000000099',
      threadId: 'taxi-1',
      parties: { customerPhone: '9647000000001', driverPhone: '9647000000002' },
    }).allowed,
    false,
  );
  assert.equal(
    evaluateThreadAccess({
      threadType: 'support',
      actorPhone: '9647000000099',
      threadId: '9647000000001',
      isAdmin: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateThreadAccess({
      threadType: 'support',
      actorPhone: '9647000000099',
      threadId: '9647000000001',
      isAdmin: true,
    }).allowed,
    true,
  );
});

test('phone overlap helpers tolerate Iraqi formats', () => {
  assert.equal(
    canAccessThreadParties('07744009992', ['+9647744009992', '9647000000000']),
    true,
  );
  assert.equal(canAccessThreadParties('07741111111', ['9647744009992']), false);
});

test('taxi status actors are role-scoped', () => {
  assert.equal(canActorSetTaxiStatus('arrived', 'driver'), true);
  assert.equal(canActorSetTaxiStatus('arrived', 'customer'), false);
  assert.equal(canActorSetTaxiStatus('cancelled', 'customer'), true);
  assert.equal(canActorSetTaxiStatus('cancel_requested', 'customer'), true);
  assert.equal(canActorSetTaxiStatus('completed', 'customer'), true);
  assert.equal(canActorSetTaxiStatus('completed', 'driver'), true);
});
