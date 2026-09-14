/**
 * كباتن مشغولون برحلة نشطة (مقبولة ولم تُنهَ) — لا يُرسل لهم طلب/إشعار جديد.
 */

const BUSY_TAXI_STATUS_KEYS = [
  'accepted',
  'arrived',
  'picked_up',
  'in_progress',
  'cancel_requested',
  'on_way',
  'return_waiting',
  'return_on_way',
  'return_arrived',
];

function phoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

function collectPhoneVariants(phone) {
  const key = phoneLast10(phone);
  if (!key) return [];
  return [`+964${key}`, `0${key}`, key, `964${key}`];
}

/**
 * @returns {Promise<Set<string>>} مجموعة آخر 10 أرقام لهواتف الكباتن المشغولين
 */
async function getBusyDriverLast10Set() {
  const { assertSupabaseAdmin } = require('../supabase_repo/common');
  const supabase = assertSupabaseAdmin();
  const busy = new Set();

  const { data, error } = await supabase
    .from('taxi_requests')
    .select('driver_phone')
    .in('status_key', BUSY_TAXI_STATUS_KEYS)
    .not('driver_phone', 'is', null)
    .limit(2000);
  if (error) {
    console.error('getBusyDriverLast10Set trips error:', error.message);
  } else {
    for (const row of data || []) {
      const key = phoneLast10(row.driver_phone);
      if (key) busy.add(key);
    }
  }

  // طبقة ثانية: من وضع نفسه غير متاح أثناء رحلة (حتى لو تأخر تحديث status_key).
  try {
    const { data: locRows, error: locError } = await supabase
      .from('driver_locations')
      .select('phone')
      .eq('available', false)
      .eq('is_online', true)
      .not('phone', 'is', null)
      .limit(2000);
    if (locError) {
      console.error('getBusyDriverLast10Set locations error:', locError.message);
    } else {
      for (const row of locRows || []) {
        const key = phoneLast10(row.phone);
        if (key) busy.add(key);
      }
    }
  } catch (e) {
    console.error('getBusyDriverLast10Set locations exception:', e?.message || e);
  }

  return busy;
}

async function isDriverOnActiveTrip(driverPhone) {
  const key = phoneLast10(driverPhone);
  if (!key) return false;
  const busy = await getBusyDriverLast10Set();
  return busy.has(key);
}

/**
 * يزيل من القائمة أي هاتف لكابتن لديه رحلة نشطة أو available=false.
 * @param {Array<string|{phone?:string,driverPhone?:string}>} entries
 */
async function filterOutBusyDrivers(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return [];
  const busy = await getBusyDriverLast10Set();
  if (busy.size === 0) return list;
  return list.filter((entry) => {
    const phone =
      typeof entry === 'string'
        ? entry
        : String(entry?.driverPhone || entry?.phone || '').trim();
    const key = phoneLast10(phone);
    return !key || !busy.has(key);
  });
}

module.exports = {
  BUSY_TAXI_STATUS_KEYS,
  phoneLast10,
  collectPhoneVariants,
  getBusyDriverLast10Set,
  isDriverOnActiveTrip,
  filterOutBusyDrivers,
};
