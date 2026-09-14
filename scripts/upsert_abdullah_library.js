#!/usr/bin/env node
/**
 * يسجّل مكتبة عبدالله في النظام ويربطها برقم 07744009992.
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  resolvePhoneKey,
  getPhoneVariants,
  assertSupabaseAdmin,
} = require('../supabase_repo/common');
const {
  getMerchantProfile,
  saveMerchantProfile,
} = require('../supabase_repo/merchants');
const { getAppUser, saveUserState, getUserState } = require('../supabase_repo/users');

const PHONE = '07744009992';
const LOGO_PATH = path.join(
  __dirname,
  '..',
  '..',
  'assets',
  'images',
  'print_abdullah_library.png'
);

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  return `data:image/png;base64,${b64}`;
}

function mergeServiceIds(existing, extra) {
  const list = Array.isArray(existing) ? existing : [];
  const set = new Set(
    list.map((item) => String(item || '').trim()).filter(Boolean)
  );
  for (const id of extra) set.add(id);
  return [...set];
}

async function main() {
  const phoneKey = await resolvePhoneKey(PHONE);
  console.log('phoneKey:', phoneKey);
  console.log('variants:', getPhoneVariants(phoneKey));

  const existing = await getMerchantProfile(phoneKey);
  if (existing) {
    console.log('existing merchant:', {
      phone: existing.phone,
      store_name: existing.store_name,
      primary_service_id: existing.primary_service_id,
      service_ids: existing.service_ids,
      is_approved: existing.is_approved,
      approval_status: existing.approval_status,
    });
  } else {
    console.log('no merchant profile yet');
  }

  const appUser = await getAppUser(phoneKey);
  console.log('app_user:', appUser
    ? { phone: appUser.phone, role: appUser.role, full_name: appUser.full_name }
    : 'none');

  const logoDataUrl = toDataUrl(LOGO_PATH);
  const serviceIds = mergeServiceIds(existing?.service_ids, ['eden_printing']);

  const saved = await saveMerchantProfile(phoneKey, {
    store_name: 'مكتبة عبدالله',
    description: 'للطباعة والاستنساخ',
    address: 'الصويرة - شارع ام وليد - مجاور افران الوليد',
    primary_service_id: 'eden_printing',
    service_ids: serviceIds,
    whatsapp: '07744009992',
    show_phone_to_customers: true,
    show_whatsapp_to_customers: true,
    is_open: true,
    is_approved: true,
    approval_status: 'approved',
    logoImageBase64: logoDataUrl,
    coverImageBase64: logoDataUrl,
    profileImageBase64: logoDataUrl,
    logo_image_base64: logoDataUrl,
    cover_image_base64: logoDataUrl,
    profile_image_base64: logoDataUrl,
    _adminModerationBypass: true,
  });

  const currentState = (await getUserState(phoneKey)) || {};
  const currentStore = currentState.merchantStore || {};
  await saveUserState(phoneKey, {
    merchantProfileComplete: true,
    merchantStore: {
      ...currentStore,
      name: 'مكتبة عبدالله',
      store_name: 'مكتبة عبدالله',
      description: 'للطباعة والاستنساخ',
      address: 'الصويرة - شارع ام وليد - مجاور افران الوليد',
      phone: phoneKey,
      whatsapp: '07744009992',
      primary_service_id: 'eden_printing',
      primaryServiceId: 'eden_printing',
      service_ids: serviceIds,
      serviceIds,
      is_open: true,
      isOpen: true,
      is_approved: true,
      isApproved: true,
    },
  });

  console.log('saved:', {
    phone: saved?.phone,
    store_name: saved?.store_name,
    primary_service_id: saved?.primary_service_id,
    service_ids: saved?.service_ids,
    is_approved: saved?.is_approved,
    approval_status: saved?.approval_status,
    has_logo: Boolean(saved?.logo_image_url || saved?.logo_image_base64),
    address: saved?.address,
  });

  const supabase = assertSupabaseAdmin();
  const { data: products, error } = await supabase
    .from('merchant_products')
    .select('id, name_ar, category, is_available')
    .in('phone', getPhoneVariants(phoneKey))
    .eq('category', 'eden_printing')
    .limit(5);
  if (error) console.log('products check error:', error.message);
  else console.log('existing eden_printing products:', (products || []).length);
}

main().catch((error) => {
  console.error('Fatal:', error?.message || error);
  process.exit(1);
});
