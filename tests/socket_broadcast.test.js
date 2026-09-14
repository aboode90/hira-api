const test = require('node:test');
const assert = require('node:assert/strict');
const { getBroadcastConfig, MIN_KEY_LENGTH } = require('../lib/socket_broadcast');

test('rejects missing or short key and non-https url', () => {
  assert.equal(getBroadcastConfig({}).ok, false);
  assert.equal(
    getBroadcastConfig({
      SOCKET_BROADCAST_KEY: 'short',
      SOCKET_BROADCAST_URL: 'https://socket.alghaithst.com',
    }).ok,
    false,
  );
  assert.equal(
    getBroadcastConfig({
      SOCKET_BROADCAST_KEY: 'x'.repeat(MIN_KEY_LENGTH),
      SOCKET_BROADCAST_URL: 'http://socket.alghaithst.com',
    }).ok,
    false,
  );
});

test('accepts https DNS url and appends /api/broadcast', () => {
  const config = getBroadcastConfig({
    SOCKET_BROADCAST_KEY: 'x'.repeat(MIN_KEY_LENGTH),
    SOCKET_BROADCAST_URL: 'https://socket.alghaithst.com',
  });
  assert.equal(config.ok, true);
  assert.equal(config.url.hostname, 'socket.alghaithst.com');
  assert.equal(config.url.protocol, 'https:');
  assert.equal(config.url.pathname, '/api/broadcast');
});

test('rejects known compromised default key and plain http to public DNS', () => {
  assert.equal(
    getBroadcastConfig({
      SOCKET_BROADCAST_KEY: 'alghaith-socket-broadcast-key',
      SOCKET_BROADCAST_URL: 'https://socket.alghaithst.com',
    }).ok,
    false,
  );
  assert.equal(
    getBroadcastConfig({
      SOCKET_BROADCAST_KEY: 'x'.repeat(MIN_KEY_LENGTH),
      SOCKET_BROADCAST_URL: 'http://example.com:10035',
    }).ok,
    false,
  );
});

test('allows http broadcast to published VPS IP port while Traefik owns 443', () => {
  const config = getBroadcastConfig({
    SOCKET_BROADCAST_KEY: 'x'.repeat(MIN_KEY_LENGTH),
    SOCKET_BROADCAST_URL: 'http://155.117.43.250:10035',
  });
  assert.equal(config.ok, true);
  assert.equal(config.url.protocol, 'http:');
  assert.equal(config.url.port, '10035');
  assert.equal(config.url.pathname, '/api/broadcast');
});

test('falls back to SOCKET_URL when SOCKET_BROADCAST_URL missing', () => {
  const config = getBroadcastConfig({
    SOCKET_BROADCAST_KEY: 'x'.repeat(MIN_KEY_LENGTH),
    SOCKET_URL: 'https://socket.alghaithst.com',
  });
  assert.equal(config.ok, true);
  assert.equal(config.url.hostname, 'socket.alghaithst.com');
});
