const {
  assertSupabaseAdmin,
  nowIso,
  normalizeObject,
  getPhoneVariants,
  phonesOverlap,
  resolvePhoneKey,
  selectMany,
  hasColumn,
  saveRow,
  updateRow,
} = require('./common');
const { ensureAppUser, getAppUser } = require('./users');

const COURIER_MODES = new Set(['public', 'private']);

function normalizeCourierMode(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'private' || value === 'خاص' || value === 'مندوب_خاص') {
    return 'private';
  }
  return 'public';
}

function mapMerchantCourierRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: String(row.id || ''),
    merchantPhone: String(row.merchant_phone || ''),
    courierPhone: String(row.courier_phone || ''),
    status: String(row.status || 'pending'),
    invitedBy: String(row.invited_by || 'merchant'),
    displayName: String(row.display_name || '').trim() || null,
    note: String(row.note || '').trim() || null,
    approvedAt: row.approved_at || null,
    rejectedAt: row.rejected_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function tableReady() {
  try {
    return await hasColumn('merchant_couriers', 'merchant_phone');
  } catch (_) {
    return false;
  }
}

async function listMerchantCouriers(merchantPhone, { status } = {}) {
  if (!(await tableReady())) return [];
  const merchant = await resolvePhoneKey(merchantPhone);
  const variants = getPhoneVariants(merchant);
  const rows = await selectMany(
    'merchant_couriers',
    [{ method: 'in', column: 'merchant_phone', value: variants }],
    { column: 'updated_at', ascending: false },
  );
  const wanted = status ? String(status).trim().toLowerCase() : '';
  return (rows || [])
    .map(mapMerchantCourierRow)
    .filter(Boolean)
    .filter((row) => !wanted || row.status === wanted);
}

async function listCourierMerchantLinks(courierPhone, { status } = {}) {
  if (!(await tableReady())) return [];
  const courier = await resolvePhoneKey(courierPhone);
  const variants = getPhoneVariants(courier);
  const rows = await selectMany(
    'merchant_couriers',
    [{ method: 'in', column: 'courier_phone', value: variants }],
    { column: 'updated_at', ascending: false },
  );
  const wanted = status ? String(status).trim().toLowerCase() : '';
  return (rows || [])
    .map(mapMerchantCourierRow)
    .filter(Boolean)
    .filter((row) => !wanted || row.status === wanted);
}

async function listApprovedCourierPhones(merchantPhone) {
  const links = await listMerchantCouriers(merchantPhone, { status: 'approved' });
  return [...new Set(links.map((l) => l.courierPhone).filter(Boolean))];
}

async function isApprovedMerchantCourier(merchantPhone, courierPhone) {
  if (!(await tableReady())) return false;
  const merchant = await resolvePhoneKey(merchantPhone);
  const courier = await resolvePhoneKey(courierPhone);
  if (!merchant || !courier) return false;

  const merchantVariants = getPhoneVariants(merchant);
  const courierVariants = new Set(getPhoneVariants(courier));
  const rows = await selectMany(
    'merchant_couriers',
    [
      { method: 'in', column: 'merchant_phone', value: merchantVariants },
      { method: 'eq', column: 'status', value: 'approved' },
    ],
    { column: 'updated_at', ascending: false },
  );
  return (rows || []).some((row) => {
    const c = String(row.courier_phone || '').trim();
    return courierVariants.has(c) || phonesOverlap(courier, c);
  });
}

async function findLink(merchantPhone, courierPhone) {
  if (!(await tableReady())) return null;
  const merchant = await resolvePhoneKey(merchantPhone);
  const courier = await resolvePhoneKey(courierPhone);
  const merchantVariants = getPhoneVariants(merchant);
  const courierVariants = getPhoneVariants(courier);
  const rows = await selectMany(
    'merchant_couriers',
    [{ method: 'in', column: 'merchant_phone', value: merchantVariants }],
    { column: 'updated_at', ascending: false },
  );
  const hit = (rows || []).find((row) =>
    courierVariants.some((v) => phonesOverlap(v, row.courier_phone)),
  );
  return mapMerchantCourierRow(hit);
}

async function upsertMerchantCourierLink({
  merchantPhone,
  courierPhone,
  status = 'pending',
  invitedBy = 'merchant',
  displayName,
  note,
}) {
  if (!(await tableReady())) {
    throw new Error('جدول ربط مندوبي المتجر غير متوفر بعد. طبّق ترحيل قاعدة البيانات.');
  }
  const merchant = await resolvePhoneKey(merchantPhone);
  const courier = await resolvePhoneKey(courierPhone);
  if (!merchant || !courier) {
    throw new Error('رقم الهاتف مطلوب.');
  }
  if (phonesOverlap(merchant, courier)) {
    throw new Error('لا يمكن ربط التاجر بنفسه كمندوب.');
  }

  await ensureAppUser(merchant, { role: 'merchant' });
  const existingUser = await getAppUser(courier);
  if (!existingUser) {
    await ensureAppUser(courier, {
      role: 'customer',
      account_type: 'marketplace',
      full_name: displayName || undefined,
    });
  }

  const nextStatus = ['pending', 'approved', 'rejected', 'removed'].includes(status)
    ? status
    : 'pending';
  const stamp = nowIso();
  const existing = await findLink(merchant, courier);
  const payload = {
    merchant_phone: merchant,
    courier_phone: courier,
    status: nextStatus,
    invited_by: ['merchant', 'courier', 'admin'].includes(invitedBy)
      ? invitedBy
      : 'merchant',
    display_name: String(displayName || existing?.displayName || '').trim() || null,
    note: String(note || existing?.note || '').trim() || null,
    updated_at: stamp,
    approved_at:
      nextStatus === 'approved' ? stamp : existing?.approvedAt || null,
    rejected_at:
      nextStatus === 'rejected' || nextStatus === 'removed'
        ? stamp
        : existing?.rejectedAt || null,
  };

  if (existing?.id) {
    await updateRow('merchant_couriers', 'id', existing.id, payload);
    return findLink(merchant, courier);
  }

  payload.created_at = stamp;
  const saved = await saveRow('merchant_couriers', payload, 'id');
  return mapMerchantCourierRow(saved) || findLink(merchant, courier);
}

async function inviteCourierByMerchant(merchantPhone, body = {}) {
  const courierPhone = String(body.courierPhone || body.phone || '').trim();
  if (!courierPhone) throw new Error('رقم المندوب مطلوب.');
  return upsertMerchantCourierLink({
    merchantPhone,
    courierPhone,
    status: 'approved',
    invitedBy: 'merchant',
    displayName: body.displayName || body.name,
    note: body.note,
  });
}

async function requestMerchantLinkByCourier(courierPhone, body = {}) {
  const merchantPhone = String(body.merchantPhone || body.phone || '').trim();
  if (!merchantPhone) throw new Error('رقم المتجر مطلوب.');
  const existing = await findLink(merchantPhone, courierPhone);
  if (existing?.status === 'approved') return existing;
  if (existing?.status === 'pending') return existing;
  return upsertMerchantCourierLink({
    merchantPhone,
    courierPhone,
    status: 'pending',
    invitedBy: 'courier',
    displayName: body.displayName || body.name,
    note: body.note,
  });
}

async function setMerchantCourierStatus(merchantPhone, courierPhone, status) {
  const next = String(status || '').trim().toLowerCase();
  if (!['approved', 'rejected', 'removed', 'pending'].includes(next)) {
    throw new Error('حالة غير صالحة.');
  }
  return upsertMerchantCourierLink({
    merchantPhone,
    courierPhone,
    status: next,
    invitedBy: 'merchant',
  });
}

async function resolveMerchantCourierMode(merchantPhone) {
  try {
    const { getMerchantProfile } = require('./merchants');
    const profile = await getMerchantProfile(merchantPhone);
    if (!profile) return 'public';
    const storeData = normalizeObject(profile.store_data || profile.storeData);
    return normalizeCourierMode(
      profile.courier_mode ??
        profile.courierMode ??
        storeData.courierMode ??
        storeData.courier_mode,
    );
  } catch (_) {
    return 'public';
  }
}

function resolveEffectiveCourierModeFromPayload(payload = {}, fallback = 'public') {
  return normalizeCourierMode(
    payload.courierModeEffective ??
      payload.courier_mode_effective ??
      payload.courierMode ??
      payload.courier_mode ??
      fallback,
  );
}

module.exports = {
  COURIER_MODES,
  normalizeCourierMode,
  mapMerchantCourierRow,
  listMerchantCouriers,
  listCourierMerchantLinks,
  listApprovedCourierPhones,
  isApprovedMerchantCourier,
  findLink,
  upsertMerchantCourierLink,
  inviteCourierByMerchant,
  requestMerchantLinkByCourier,
  setMerchantCourierStatus,
  resolveMerchantCourierMode,
  resolveEffectiveCourierModeFromPayload,
};
