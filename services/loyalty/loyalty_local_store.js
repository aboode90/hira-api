const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'loyalty');

function ensureDir() {
  fs.mkdirSync(path.join(DATA_DIR, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'coupons'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'ledger'), { recursive: true });
}

function profilePath(phone) {
  return path.join(DATA_DIR, 'profiles', `${phone}.json`);
}

function couponsPath(phone) {
  return path.join(DATA_DIR, 'coupons', `${phone}.json`);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function defaultProfile(phone) {
  return {
    phone,
    level: 1,
    lifetimePoints: 0,
    completedMarketplace: 0,
    completedTaxi: 0,
    updatedAt: new Date().toISOString(),
  };
}

function getProfile(phone) {
  ensureDir();
  return readJson(profilePath(phone), defaultProfile(phone));
}

function saveProfile(profile) {
  writeJson(profilePath(profile.phone), profile);
  return profile;
}

function listCoupons(phone) {
  return readJson(couponsPath(phone), []);
}

function saveCoupons(phone, coupons) {
  writeJson(couponsPath(phone), coupons);
}

function appendLedger(phone, entry) {
  const file = path.join(DATA_DIR, 'ledger', `${phone}.json`);
  const rows = readJson(file, []);
  rows.unshift(entry);
  writeJson(file, rows.slice(0, 200));
}

function addCoupon(phone, coupon) {
  const coupons = listCoupons(phone);
  const row = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    usesLeft: 1,
    ...coupon,
  };
  coupons.unshift(row);
  saveCoupons(phone, coupons);
  return row;
}

function findCoupon(phone, code) {
  const normalized = String(code || '').trim().toUpperCase();
  return listCoupons(phone).find(
    (c) =>
      String(c.code || '').trim().toUpperCase() === normalized && (c.usesLeft ?? 0) > 0,
  );
}

function findCouponById(phone, couponId) {
  const id = String(couponId || '').trim();
  return listCoupons(phone).find((c) => c.id === id && (c.usesLeft ?? 0) > 0);
}

function consumeCoupon(phone, couponId) {
  const coupons = listCoupons(phone);
  const idx = coupons.findIndex((c) => c.id === couponId);
  if (idx < 0) return null;
  const coupon = coupons[idx];
  coupon.usesLeft = Math.max(0, (coupon.usesLeft ?? 1) - 1);
  coupons[idx] = coupon;
  saveCoupons(phone, coupons);
  return coupon;
}

module.exports = {
  getProfile,
  saveProfile,
  listCoupons,
  addCoupon,
  findCoupon,
  findCouponById,
  consumeCoupon,
  appendLedger,
};
