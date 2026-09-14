/**
 * استخراج اسم وإحداثيات من رابط Google Maps (مشاركة قصيرة أو كاملة).
 */

// مرجع افتراضي لفك أكواد Plus القصيرة (العراق — سوق التطبيق).
const DEFAULT_SHORT_CODE_REFERENCE = { latitude: 32.93, longitude: 44.78 };

function safeDecode(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text.replace(/\+/g, ' ');
  }
}

function decodePlaceName(url) {
  const placeMatch = String(url).match(/\/maps\/place\/([^/@]+)/i);
  if (!placeMatch) return '';
  return safeDecode(placeMatch[1].replace(/\+/g, ' '))
    .replace(/[\u200e\u200f]/g, '')
    .trim();
}

function coordsFromUrl(url) {
  const text = String(url);
  const precise = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (precise) {
    return { latitude: Number(precise[1]), longitude: Number(precise[2]) };
  }
  const atMatch = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (atMatch) {
    return { latitude: Number(atMatch[1]), longitude: Number(atMatch[2]) };
  }
  const qMatch = text.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (qMatch) {
    return { latitude: Number(qMatch[1]), longitude: Number(qMatch[2]) };
  }
  const searchMatch = text.match(
    /\/maps\/search\/(-?\d+(?:\.\d+)?)\s*,\s*\+?(-?\d+(?:\.\d+)?)/,
  );
  if (searchMatch) {
    return { latitude: Number(searchMatch[1]), longitude: Number(searchMatch[2]) };
  }
  const llMatch = text.match(/[?&](?:ll|sll)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (llMatch) {
    return { latitude: Number(llMatch[1]), longitude: Number(llMatch[2]) };
  }
  return null;
}

function plusCodeFromUrl(url) {
  const raw = String(url);
  const text = raw.length > 4000 ? raw : safeDecode(raw);
  // كود Plus في أي مكان بالرابط (غالباً داخل اسم المكان) مثل XVPV+2G
  const direct = text.match(/([A-Z0-9]{2,4}\+[A-Z0-9]{2,7})/i);
  if (direct) return direct[1].toUpperCase();
  // مشفّر مثل WQMJ%2BWJ4
  const encoded = String(url).match(/[A-Z0-9%]{2,8}%2B[A-Z0-9%]{2,7}/i);
  if (encoded) return safeDecode(encoded[0]).toUpperCase();
  return null;
}

function coordsFromPlusCode(code, referenceLatitude, referenceLongitude) {
  if (!code) return null;
  try {
    const { OpenLocationCode } = require('open-location-code');
    const olc = new OpenLocationCode();
    const refLat = Number(referenceLatitude) || DEFAULT_SHORT_CODE_REFERENCE.latitude;
    const refLng = Number(referenceLongitude) || DEFAULT_SHORT_CODE_REFERENCE.longitude;
    const full = olc.recoverNearest(code, refLat, refLng);
    const area = olc.decode(full);
    return {
      latitude: area.latitudeCenter,
      longitude: area.longitudeCenter,
    };
  } catch (_) {
    return null;
  }
}

function coordsFromPreviewJson(text) {
  const pin = String(text).match(/\[null,null,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/);
  if (!pin) return null;
  const latitude = Number(pin[1]);
  const longitude = Number(pin[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

const MAPS_FETCH_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept-language': 'ar,en;q=0.9',
};

async function fetchPreviewCoords(html, baseUrl) {
  const match = String(html).match(/href="(\/maps\/preview\/place[^"]+)"/i);
  if (!match) return null;
  const previewUrl = new URL(match[1].replace(/&amp;/g, '&'), baseUrl || 'https://www.google.com').toString();
  try {
    const response = await fetch(previewUrl, { headers: MAPS_FETCH_HEADERS });
    if (!response.ok) return null;
    const body = await response.text();
    return coordsFromPreviewJson(body) || coordsFromUrl(body);
  } catch (_) {
    return null;
  }
}

async function resolveGoogleMapsUrl(inputUrl, options = {}) {
  const raw = String(inputUrl || '').trim();
  if (!raw) {
    throw new Error('رابط Google Maps مطلوب.');
  }

  let finalUrl = raw;
  let htmlSnippet = '';
  try {
    const response = await fetch(raw, { redirect: 'follow', headers: MAPS_FETCH_HEADERS });
    if (response.url) finalUrl = response.url;
    const contentType = String(response.headers.get('content-type') || '');
    if (!coordsFromUrl(finalUrl) && /html|javascript|text|json/i.test(contentType)) {
      const body = await response.text();
      htmlSnippet = body.slice(0, 800000);
    }
  } catch (error) {
    throw new Error('تعذر فتح رابط الخريطة. تحقق من الرابط والإنترنت.');
  }

  let coords = coordsFromUrl(finalUrl);
  if (!coords) {
    coords = await fetchPreviewCoords(htmlSnippet, finalUrl);
  }
  if (!coords) {
    // جرب Plus Code من الرابط فقط (وليس من HTML الكامل).
    coords = coordsFromPlusCode(
      plusCodeFromUrl(finalUrl),
      options.referenceLatitude,
      options.referenceLongitude
    );
  }
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
    throw new Error('تعذر استخراج الإحداثيات من الرابط.');
  }

  const name = decodePlaceName(finalUrl);
  return {
    name,
    latitude: coords.latitude,
    longitude: coords.longitude,
    resolvedUrl: finalUrl,
  };
}

module.exports = {
  resolveGoogleMapsUrl,
  decodePlaceName,
  coordsFromUrl,
  coordsFromPlusCode,
};
