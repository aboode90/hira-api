/**
 * Travel Service — Proxy لـ Travelpayouts API
 *
 * يخفي مفتاح API عن التطبيق ويحوّل الطلبات إلى Travelpayouts.
 *
 * الإعدادات:
 *   TRAVELPAYOUTS_API_KEY — مفتاح API من Travelpayouts
 *   TRAVELPAYOUTS_MARKER — معرف الشريك (اختياري)
 */

const API_BASE = 'https://api.travelpayouts.com/aviasales/v3';
const HOTEL_BASE = 'https://engine.hotellook.com/api/v2';

const apiKey = () => String(process.env.TRAVELPAYOUTS_API_KEY || '').trim();
const marker = () => String(process.env.TRAVELPAYOUTS_MARKER || '1363728').trim();

function _authGuard() {
  const key = apiKey();
  if (!key) throw new Error('TRAVELPAYOUTS_API_KEY not configured.');
  return key;
}

/**
 * البحث عن رحلات طيران
 * https://support.travelpayouts.com/hc/en-us/articles/20383904281106-API-Overview
 */
async function searchFlights({ origin, destination, departDate, returnDate, passengers = 1, currency = 'IQD', locale = 'ar' }) {
  const key = _authGuard();
  const params = new URLSearchParams({
    origin,
    destination,
    depart_date: departDate,
    return_date: returnDate || '',
    passengers: String(passengers),
    currency,
    locale,
    'token': key,
    'marker': marker(),
  });
  const url = `${API_BASE}/prices_for_dates?${params}`;
  const response = await fetch(url, { timeout: 15000 });
  if (!response.ok) throw new Error(`Travelpayouts error: ${response.status}`);
  const data = await response.json();
  return data;
}

/**
 * البحث عن فنادق — عبر Hotellook (شريك Travelpayouts)
 * https://support.travelpayouts.com/hc/en-us/articles/360004484552-API-for-trips-planning
 */
async function searchHotels({ query, checkIn, checkOut, adults = 1, currency = 'IQD', locale = 'ar' }) {
  const key = _authGuard();
  const params = new URLSearchParams({
    query,
    checkIn: checkIn || '',
    checkOut: checkOut || '',
    adults: String(adults),
    currency,
    lang: locale,
    'token': key,
    'marker': marker(),
  });
  const url = `${HOTEL_BASE}/search/start?${params}`;
  const response = await fetch(url, { timeout: 15000 });
  if (!response.ok) throw new Error(`Hotellook error: ${response.status}`);
  const searchId = await response.text();
  return { searchId };
}

async function getHotelResults(searchId, { currency = 'IQD', locale = 'ar' }) {
  const key = _authGuard();
  const params = new URLSearchParams({
    id: searchId,
    currency,
    lang: locale,
    'token': key,
    'marker': marker(),
  });
  const url = `${HOTEL_BASE}/search/get_result?${params}`;
  const response = await fetch(url, { timeout: 15000 });
  if (!response.ok) throw new Error(`Hotellook error: ${response.status}`);
  const data = await response.json();
  return data;
}

/**
 * الحصول على رابط الحجز (للتحويل إلى Travelpayouts)
 */
function getAffiliateUrl(type, params = {}) {
  const mk = marker();
  if (type === 'flight') {
    return `https://www.aviasales.ps/search/${params.origin}${params.destination}${params.departDate}${params.returnDate || ''}1?marker=${mk}`;
  }
  if (type === 'hotel') {
    return `https://search.hotellook.com/?locationId=${params.locationId}&checkIn=${params.checkIn}&checkOut=${params.checkOut}&adults=${params.adults || 1}&marker=${mk}`;
  }
  return '';
}

module.exports = {
  searchFlights,
  searchHotels,
  getHotelResults,
  getAffiliateUrl,
};
