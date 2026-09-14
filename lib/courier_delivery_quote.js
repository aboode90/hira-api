'use strict';

const { getDeliveryConfig } = require('../services/app_config_service');

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function geocodeAddressWithMapbox(addressText) {
  const token = String(process.env.MAPBOX_ACCESS_TOKEN || '').trim();
  const address = String(addressText || '').trim();
  if (!token || !address) {
    throw new Error('Mapbox or address missing');
  }
  const query = encodeURIComponent(address);
  const params = new URLSearchParams({
    language: 'ar',
    country: 'iq',
    limit: '1',
    access_token: token,
  });
  const response = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?${params}`,
  );
  if (!response.ok) throw new Error(`Geocode failed (${response.status})`);
  const payload = await response.json();
  const center = payload?.features?.[0]?.center;
  if (!Array.isArray(center) || center.length < 2) {
    throw new Error('Could not geocode address');
  }
  return { latitude: Number(center[1]), longitude: Number(center[0]) };
}

function roundFee(value, step) {
  const safeStep = step > 0 ? step : 250;
  return Math.ceil(value / safeStep) * safeStep;
}

function calculateCourierDeliveryFeeKm(distanceKm, config = {}) {
  const minFee = Number(config.minFee) || 1000;
  const rate = Number(config.defaultRatePerKm) || 700;
  const minRate = Number(config.minPerKm) || 400;
  const maxRate = Number(config.maxPerKm) || 1500;
  const step = Number(config.roundingStep) || 250;
  const safeRate = Math.min(maxRate, Math.max(minRate, rate));
  const km = Math.max(0, Number(distanceKm) || 0);
  const raw = Math.max(minFee, km * safeRate);
  return roundFee(raw, step);
}

async function quoteCourierDeliveryByAddresses(pickupAddress, dropoffAddress) {
  const cfg = await getDeliveryConfig();
  let distanceKm = 1.5;
  try {
    const [origin, destination] = await Promise.all([
      geocodeAddressWithMapbox(pickupAddress),
      geocodeAddressWithMapbox(dropoffAddress),
    ]);
    distanceKm = (haversineMeters(origin, destination) / 1000) * 1.3;
  } catch (error) {
    console.warn('parcel quote geocode fallback:', error?.message || error);
  }
  const feeIqd = calculateCourierDeliveryFeeKm(distanceKm, cfg);
  return { distanceKm, feeIqd };
}

module.exports = {
  calculateCourierDeliveryFeeKm,
  quoteCourierDeliveryByAddresses,
};
