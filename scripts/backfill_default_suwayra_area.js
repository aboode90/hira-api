/**
 * تعبئة لمرة واحدة: كل الحسابات المسجّلة سابقاً بدون منطقة
 * تُضبط على واسط / الصويرة / الصويرة كأنهم اختاروها.
 *
 *   cd backend
 *   node -r dotenv/config scripts/backfill_default_suwayra_area.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const DEFAULTS = {
  governorate: 'واسط',
  district: 'الصويرة',
  locality: 'الصويرة',
  city: 'الصويرة',
  area: 'الصويرة',
};

function needsArea(obj = {}) {
  const gov = String(obj.governorate || '').trim();
  const district = String(obj.district || '').trim();
  const locality = String(obj.locality || obj.subArea || '').trim();
  return !gov || !district || !locality;
}

function mergeDefaults(obj = {}) {
  const next = { ...obj };
  if (!String(next.governorate || '').trim()) next.governorate = DEFAULTS.governorate;
  if (!String(next.district || '').trim()) next.district = DEFAULTS.district;
  if (!String(next.locality || '').trim() && !String(next.subArea || '').trim()) {
    next.locality = DEFAULTS.locality;
  }
  if (!String(next.city || '').trim()) next.city = DEFAULTS.city;
  if (!String(next.area || '').trim()) next.area = DEFAULTS.area;
  return next;
}

async function backfillJsonPayloadTable(supabase, table, keyColumn = 'phone') {
  let updated = 0;
  let scanned = 0;
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(`${keyColumn}, profile_payload`)
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;
    for (const row of rows) {
      scanned += 1;
      const payload =
        row.profile_payload && typeof row.profile_payload === 'object'
          ? row.profile_payload
          : {};
      if (!needsArea(payload)) continue;
      const next = mergeDefaults(payload);
      const { error: upErr } = await supabase
        .from(table)
        .update({
          profile_payload: next,
          updated_at: new Date().toISOString(),
        })
        .eq(keyColumn, row[keyColumn]);
      if (upErr) {
        console.error(`${table} update failed for ${row[keyColumn]}:`, upErr.message);
        continue;
      }
      updated += 1;
    }
    if (rows.length < page) break;
    from += page;
  }
  return { scanned, updated };
}

async function backfillCustomers(supabase) {
  let updated = 0;
  let scanned = 0;
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await supabase
      .from('customer_profiles')
      .select('phone, address, governorate, district, locality')
      .range(from, from + page - 1);
    if (error) {
      // أعمدة المنطقة قد لا تكون موجودة بعد — نحدّث العنوان فقط إن لزم
      if (/governorate|column/i.test(error.message)) {
        return backfillCustomersAddressOnly(supabase);
      }
      throw error;
    }
    const rows = data || [];
    if (!rows.length) break;
    for (const row of rows) {
      scanned += 1;
      if (!needsArea(row)) continue;
      const patch = {
        governorate: String(row.governorate || '').trim() || DEFAULTS.governorate,
        district: String(row.district || '').trim() || DEFAULTS.district,
        locality: String(row.locality || '').trim() || DEFAULTS.locality,
        updated_at: new Date().toISOString(),
      };
      if (!String(row.address || '').trim()) {
        patch.address = DEFAULTS.area;
      }
      const { error: upErr } = await supabase
        .from('customer_profiles')
        .update(patch)
        .eq('phone', row.phone);
      if (upErr) {
        console.error('customer update failed:', row.phone, upErr.message);
        continue;
      }
      updated += 1;
    }
    if (rows.length < page) break;
    from += page;
  }
  return { scanned, updated };
}

async function backfillCustomersAddressOnly(supabase) {
  console.warn(
    'customer_profiles missing area columns — applying address fallback only',
  );
  let updated = 0;
  let scanned = 0;
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await supabase
      .from('customer_profiles')
      .select('phone, address')
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;
    for (const row of rows) {
      scanned += 1;
      const address = String(row.address || '').trim();
      if (address) continue;
      const { error: upErr } = await supabase
        .from('customer_profiles')
        .update({
          address: DEFAULTS.area,
          updated_at: new Date().toISOString(),
        })
        .eq('phone', row.phone);
      if (upErr) {
        console.error('customer address update failed:', row.phone, upErr.message);
        continue;
      }
      updated += 1;
    }
    if (rows.length < page) break;
    from += page;
  }
  return { scanned, updated };
}

async function backfillMerchants(supabase) {
  let updated = 0;
  let scanned = 0;
  let from = 0;
  const page = 200;
  for (;;) {
    const { data, error } = await supabase
      .from('merchant_profiles')
      .select('phone, address, store_data, professional_info')
      .range(from, from + page - 1);
    if (error) {
      // store_data قد لا يوجد
      const fallback = await supabase
        .from('merchant_profiles')
        .select('phone, address, professional_info')
        .range(from, from + page - 1);
      if (fallback.error) throw fallback.error;
      return backfillMerchantsRows(supabase, fallback.data || [], true);
    }
    const rows = data || [];
    if (!rows.length) break;
    const result = await backfillMerchantsRows(supabase, rows, false);
    scanned += result.scanned;
    updated += result.updated;
    if (rows.length < page) break;
    from += page;
  }
  return { scanned, updated };
}

async function backfillMerchantsRows(supabase, rows, skipStoreData) {
  let updated = 0;
  let scanned = 0;
  for (const row of rows) {
    scanned += 1;
    const storeData =
      row.store_data && typeof row.store_data === 'object' ? row.store_data : {};
    const professionalInfo =
      row.professional_info && typeof row.professional_info === 'object'
        ? row.professional_info
        : {};

    const needsStore = !skipStoreData && needsArea(storeData);
    const needsProf = needsArea(professionalInfo);
    const needsTop =
      !String(storeData.governorate || professionalInfo.governorate || '').trim() ||
      !String(storeData.district || professionalInfo.district || '').trim() ||
      !String(storeData.locality || professionalInfo.locality || '').trim();

    if (!needsStore && !needsProf && !needsTop) continue;

    const patch = {
      updated_at: new Date().toISOString(),
    };
    if (!skipStoreData) {
      patch.store_data = mergeDefaults(storeData);
    }
    if (Object.keys(professionalInfo).length || needsProf) {
      patch.professional_info = mergeDefaults(professionalInfo);
    }
    if (!String(row.address || '').trim()) {
      patch.address = DEFAULTS.area;
    }

    let { error: upErr } = await supabase
      .from('merchant_profiles')
      .update(patch)
      .eq('phone', row.phone);
    if (upErr && /store_data/i.test(upErr.message) && patch.store_data) {
      delete patch.store_data;
      ({ error: upErr } = await supabase
        .from('merchant_profiles')
        .update(patch)
        .eq('phone', row.phone));
    }
    if (upErr) {
      console.error('merchant update failed:', row.phone, upErr.message);
      continue;
    }
    updated += 1;
  }
  return { scanned, updated };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  console.log('Backfilling default area → واسط / الصويرة / الصويرة');
  console.log('Drivers...');
  const drivers = await backfillJsonPayloadTable(supabase, 'driver_profiles');
  console.log(drivers);

  console.log('Couriers...');
  const couriers = await backfillJsonPayloadTable(supabase, 'courier_profiles');
  console.log(couriers);

  console.log('Customers...');
  const customers = await backfillCustomers(supabase);
  console.log(customers);

  console.log('Merchants...');
  const merchants = await backfillMerchants(supabase);
  console.log(merchants);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
