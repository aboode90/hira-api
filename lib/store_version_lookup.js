'use strict';

const IOS_BUNDLE_ID = 'com.hira.app';
const IOS_APP_ID = '6776741811';
const ANDROID_PACKAGE_ID = 'com.hira.app';
const TIMEOUT_MS = 12_000;

function versionParts(raw) {
  return String(raw || '')
    .split('.')
    .map((part) => Number.parseInt(String(part).replace(/\D/g, ''), 10) || 0);
}

function compareVersionStrings(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = index < leftParts.length ? leftParts[index] : 0;
    const b = index < rightParts.length ? rightParts[index] : 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function looksLikeAppVersion(raw) {
  const parts = versionParts(raw);
  if (!parts.length) return false;
  if (parts[0] <= 0 || parts[0] > 50) return false;
  return true;
}

/** يمنع مقارنة 1.2.378 (أندرويد) مع 2.84 (آيفون). */
function areVersionSchemesCompatible(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts.length || !rightParts.length) return false;
  if (leftParts[0] > 50 || rightParts[0] > 50) return false;

  const depthDelta = Math.abs(leftParts.length - rightParts.length);
  if (depthDelta >= 1 && leftParts[0] !== rightParts[0]) return false;
  return true;
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parsePlayStoreVersion(html, preferSimilarTo = '') {
  const patterns = [
    /itemprop="softwareVersion"[^>]*content="([^"]+)"/gi,
    /itemprop="softwareVersion"[^>]*>([^<]+)</gi,
    /\[\[\["([0-9]+(?:\.[0-9]+){1,3})"\]\]/g,
    /Current Version<\/div><span[^>]*><div[^>]*><span[^>]*>([^<]+)</gi,
  ];
  const found = new Set();
  const source = String(html || '');
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      const value = String(match[1] || '').trim();
      if (value && looksLikeAppVersion(value)) found.add(value);
      match = pattern.exec(source);
    }
  }
  if (!found.size) return null;

  const all = [...found];
  const prefer = String(preferSimilarTo || '').trim();
  const compatible = prefer
    ? all.filter((version) => areVersionSchemesCompatible(prefer, version))
    : all;
  const pool = compatible.length ? compatible : all;
  pool.sort(compareVersionStrings);
  return pool[pool.length - 1] || null;
}

async function fetchIosStoreVersion() {
  const uris = [
    `https://itunes.apple.com/lookup?bundleId=${IOS_BUNDLE_ID}&country=iq`,
    `https://itunes.apple.com/lookup?id=${IOS_APP_ID}&country=iq`,
    `https://itunes.apple.com/lookup?bundleId=${IOS_BUNDLE_ID}`,
  ];
  for (const uri of uris) {
    const decoded = await fetchJson(uri);
    const results = decoded?.results;
    if (!Array.isArray(results) || results.length === 0) continue;
    const version = String(results[0]?.version || '').trim();
    if (!version) continue;
    return {
      platform: 'ios',
      version,
      buildNumber: null,
      source: 'app_store',
    };
  }
  return null;
}

async function fetchAndroidStoreVersion() {
  const uris = [
    `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE_ID}&hl=ar`,
    `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE_ID}&hl=en`,
  ];
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept-Language': 'ar,en;q=0.9',
  };
  for (const uri of uris) {
    const html = await fetchText(uri, headers);
    if (!html) continue;
    const version = parsePlayStoreVersion(html, '1.2.0');
    if (!version) continue;
    return {
      platform: 'android',
      version,
      buildNumber: null,
      source: 'play_store',
    };
  }
  return null;
}

async function fetchStoreVersions() {
  const [ios, android] = await Promise.all([
    fetchIosStoreVersion(),
    fetchAndroidStoreVersion(),
  ]);
  return { ios, android };
}

module.exports = {
  compareVersionStrings,
  areVersionSchemesCompatible,
  fetchStoreVersions,
  fetchIosStoreVersion,
  fetchAndroidStoreVersion,
};
