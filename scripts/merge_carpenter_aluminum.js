/**
 * دمج قسمي النجار + الألمنيوم والزجاج → نجار والمنيوم و PVC
 * carpenter / aluminum_glass → carpenter_aluminum_pvc
 *
 * يحدّث:
 * - merchant_profiles.professional_category_id (+ professional_info.professionId)
 * - merchant_service_profiles (professionals)
 * - customer_professionals إن وُجدت
 * - إعدادات الأدمن professionalCategories في platform_settings
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { assertSupabaseAdmin } = require('../supabase_repo/common');

const FROM_IDS = ['carpenter', 'aluminum_glass'];
const TO_ID = 'carpenter_aluminum_pvc';
const TO_LABEL = 'نجار والمنيوم و PVC';

function patchInfo(info, toId) {
  const next = info && typeof info === 'object' ? { ...info } : {};
  if (FROM_IDS.includes(String(next.professionId || '').trim())) {
    next.professionId = toId;
  }
  if (FROM_IDS.includes(String(next.profession_id || '').trim())) {
    next.profession_id = toId;
  }
  return next;
}

async function migrateMerchantProfiles(supabase) {
  let total = 0;
  for (const from of FROM_IDS) {
    const { data, error } = await supabase
      .from('merchant_profiles')
      .select('phone, professional_category_id, service_sub_category, professional_info')
      .eq('professional_category_id', from);
    if (error) throw new Error(`merchant_profiles select ${from}: ${error.message}`);
    for (const row of data || []) {
      const info = patchInfo(row.professional_info, TO_ID);
      const payload = {
        professional_category_id: TO_ID,
        professional_info: info,
      };
      if (FROM_IDS.includes(String(row.service_sub_category || '').trim())) {
        payload.service_sub_category = TO_ID;
      }
      const { error: upErr } = await supabase
        .from('merchant_profiles')
        .update(payload)
        .eq('phone', row.phone);
      if (upErr) throw new Error(`merchant_profiles update ${row.phone}: ${upErr.message}`);
      total += 1;
    }
  }

  // صفوف قديمة بلا professional_category_id لكن service_sub_category قديم
  for (const from of FROM_IDS) {
    const { data, error } = await supabase
      .from('merchant_profiles')
      .select('phone, professional_category_id, service_sub_category, professional_info')
      .eq('service_sub_category', from);
    if (error) throw new Error(`merchant_profiles sub select ${from}: ${error.message}`);
    for (const row of data || []) {
      const current = String(row.professional_category_id || '').trim();
      if (current && current !== from && current !== TO_ID) continue;
      const info = patchInfo(row.professional_info, TO_ID);
      const { error: upErr } = await supabase
        .from('merchant_profiles')
        .update({
          professional_category_id: TO_ID,
          service_sub_category: TO_ID,
          professional_info: info,
        })
        .eq('phone', row.phone);
      if (upErr) throw new Error(`merchant_profiles sub update ${row.phone}: ${upErr.message}`);
      total += 1;
    }
  }
  return total;
}

async function migrateServiceProfiles(supabase) {
  let total = 0;
  for (const from of FROM_IDS) {
    const { data, error } = await supabase
      .from('merchant_service_profiles')
      .select('*')
      .eq('service_id', 'professionals')
      .or(`professional_category_id.eq.${from},service_sub_category.eq.${from}`);
    if (error) throw new Error(`service_profiles select ${from}: ${error.message}`);

    for (const row of data || []) {
      const info = patchInfo(row.professional_info, TO_ID);
      const { error: upErr } = await supabase
        .from('merchant_service_profiles')
        .update({
          professional_category_id: TO_ID,
          service_sub_category: TO_ID,
          professional_info: info,
        })
        .eq('id', row.id);
      if (upErr) {
        // قد يفشل إن كان المفتاح مركّباً بدون id — جرّب بالهاتف+القسم
        const { error: upErr2 } = await supabase
          .from('merchant_service_profiles')
          .update({
            professional_category_id: TO_ID,
            service_sub_category: TO_ID,
            professional_info: info,
          })
          .eq('phone', row.phone)
          .eq('service_id', 'professionals')
          .eq('service_sub_category', from);
        if (upErr2) {
          throw new Error(
            `service_profiles update ${row.phone}/${from}: ${upErr.message} / ${upErr2.message}`,
          );
        }
      }
      total += 1;
    }
  }
  return total;
}

async function migrateCustomerProfessionalsTable(supabase) {
  // جدول اختياري — تجاهل إن لم يوجد
  let total = 0;
  for (const from of FROM_IDS) {
    const { data, error } = await supabase
      .from('customer_professionals')
      .select('id, profession_id, owner_phone')
      .eq('profession_id', from);
    if (error) {
      if (/relation|does not exist|42P01|schema cache|Could not find the table/i.test(error.message)) {
        console.log('customer_professionals: table missing — skip');
        return 0;
      }
      throw new Error(`customer_professionals select ${from}: ${error.message}`);
    }
    for (const row of data || []) {
      const newId = `${String(row.owner_phone || '').trim()}::${TO_ID}`;
      const { error: upErr } = await supabase
        .from('customer_professionals')
        .update({ id: newId, profession_id: TO_ID })
        .eq('id', row.id);
      if (upErr) {
        console.warn(`customer_professionals ${row.id}: ${upErr.message}`);
        continue;
      }
      total += 1;
    }
  }
  return total;
}

async function migrateAdminSettings(supabase) {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['app_state', 'appState', 'state']);
  // بعض المشاريع تخزّن الحالة في صف واحد key=app_state
  const { data: rows, error: err2 } = await supabase
    .from('platform_settings')
    .select('*')
    .limit(20);
  if (err2 && error) {
    console.log('platform_settings: skip', err2.message || error.message);
    return 0;
  }

  const candidates = rows || data || [];
  let updated = 0;
  for (const row of candidates) {
    const value = row.value ?? row.settings ?? row.data;
    if (!value || typeof value !== 'object') continue;
    const cats =
      value.professionalCategories ||
      value.professional_categories ||
      null;
    if (!cats || !Array.isArray(cats.items)) continue;

    const items = [];
    let changed = false;
    let hasMerged = false;
    for (const item of cats.items) {
      const id = String(item.id || '').trim();
      if (FROM_IDS.includes(id)) {
        changed = true;
        if (!hasMerged) {
          items.push({
            ...item,
            id: TO_ID,
            labelAr: TO_LABEL,
            label: TO_LABEL,
            labelEn: 'Carpenter, Aluminum & PVC',
            builtin: true,
          });
          hasMerged = true;
        }
        continue;
      }
      if (id === TO_ID) {
        hasMerged = true;
        items.push({
          ...item,
          labelAr: TO_LABEL,
          label: TO_LABEL,
          labelEn: item.labelEn || 'Carpenter, Aluminum & PVC',
        });
        changed = true;
        continue;
      }
      items.push(item);
    }
    if (!changed) continue;

    const nextValue = {
      ...value,
      professionalCategories: {
        ...cats,
        items,
      },
      professional_categories: {
        ...cats,
        items,
      },
    };
    const keyCol = row.key != null ? 'key' : null;
    if (keyCol) {
      const { error: upErr } = await supabase
        .from('platform_settings')
        .update({ value: nextValue })
        .eq('key', row.key);
      if (upErr) console.warn('platform_settings update:', upErr.message);
      else updated += 1;
    }
  }
  return updated;
}

(async () => {
  const supabase = assertSupabaseAdmin();
  console.log(`Merging ${FROM_IDS.join(' + ')} → ${TO_ID} (${TO_LABEL})`);

  const profiles = await migrateMerchantProfiles(supabase);
  console.log('merchant_profiles updated:', profiles);

  const services = await migrateServiceProfiles(supabase);
  console.log('merchant_service_profiles updated:', services);

  const customers = await migrateCustomerProfessionalsTable(supabase);
  console.log('customer_professionals updated:', customers);

  const settings = await migrateAdminSettings(supabase);
  console.log('platform_settings rows updated:', settings);

  // تحقق
  for (const from of FROM_IDS) {
    const { count: c1 } = await supabase
      .from('merchant_profiles')
      .select('phone', { count: 'exact', head: true })
      .eq('professional_category_id', from);
    const { count: c2 } = await supabase
      .from('merchant_service_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('service_id', 'professionals')
      .eq('professional_category_id', from);
    console.log(`leftover ${from}: profiles=${c1 || 0} service=${c2 || 0}`);
  }
  const { count: merged } = await supabase
    .from('merchant_profiles')
    .select('phone', { count: 'exact', head: true })
    .eq('professional_category_id', TO_ID);
  console.log(`merged profiles now (${TO_ID}):`, merged || 0);
  console.log('DONE');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
