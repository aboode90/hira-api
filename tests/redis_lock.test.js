const test = require('node:test');
const assert = require('node:assert/strict');

test('acquireLock allows db-only when REDIS_URL is unset', async () => {
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  // Fresh module so initAttempted/redisClient reset with env.
  delete require.cache[require.resolve('../lib/redis_client')];
  const { acquireLock, releaseLock } = require('../lib/redis_client');

  const lock = await acquireLock('taxi:accept:test', 1000);
  assert.equal(lock.ok, true);
  assert.equal(lock.mode, 'db-only');
  assert.equal(lock.token, null);

  await releaseLock('taxi:accept:test', lock.token);

  if (prev === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = prev;
  delete require.cache[require.resolve('../lib/redis_client')];
});
