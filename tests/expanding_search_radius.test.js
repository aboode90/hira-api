'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  usesExpandingTaxiSearch,
  matchingWaveIndex,
  matchingRadiusKm,
  isWithinSearchTimeout,
} = require('../lib/expanding_search_radius');

test('رادار الإشعارات المتكرر متوقف لكل الأنواع', () => {
  assert.equal(usesExpandingTaxiSearch('economic'), false);
  assert.equal(usesExpandingTaxiSearch('starx11'), false);
  assert.equal(usesExpandingTaxiSearch('tuktuk'), false);
  assert.equal(usesExpandingTaxiSearch('wazz'), false);
});

test('أول 30 ثانية = 1 كم ثم +1 كم كل 30 ثانية', () => {
  const createdAt = '2026-08-28T15:00:00.000Z';
  const t0 = Date.parse(createdAt);
  assert.equal(matchingWaveIndex(createdAt, t0), 0);
  assert.equal(matchingRadiusKm(createdAt, t0), 1);
  assert.equal(matchingRadiusKm(createdAt, t0 + 29_999), 1);
  assert.equal(matchingRadiusKm(createdAt, t0 + 30_000), 2);
  assert.equal(matchingRadiusKm(createdAt, t0 + 60_000), 3);
  assert.equal(matchingRadiusKm(createdAt, t0 + 270_000), 10);
});

test('مهلة البحث 5 دقائق', () => {
  const createdAt = '2026-08-28T15:00:00.000Z';
  const t0 = Date.parse(createdAt);
  assert.equal(isWithinSearchTimeout(createdAt, t0 + 299_000), true);
  assert.equal(isWithinSearchTimeout(createdAt, t0 + 300_000), false);
});
