const test = require('node:test');
const assert = require('node:assert/strict');
const { remember, cacheStats } = require('../lib/response_cache');

test('remember returns cached value on second call', async () => {
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return { ok: true, count: loads };
  };

  const first = await remember('test:remember:1', 60_000, loader);
  const second = await remember('test:remember:1', 60_000, loader);

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.value.count, 1);
  assert.equal(loads, 1);
});

test('cacheStats exposes memory cache metadata', () => {
  const stats = cacheStats();
  assert.equal(typeof stats.memoryEntries, 'number');
  assert.equal(typeof stats.redisConfigured, 'boolean');
  assert.ok(stats.ttlsMs.homeCategories > 0);
});
