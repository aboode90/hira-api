/**
 * مساعد تخزين ملفات المهنيين في customer_professional_profiles
 * مع مرآة اختيارية إلى merchant_service_profiles أثناء الانتقال.
 */

const {
  nowIso,
  resolvePhoneKey,
  getPhoneVariants,
  selectSingle,
  selectMany,
  saveRow,
  updateRow,
  deleteRow,
  assertSupabaseAdmin,
} = require('./common');

const MIRROR =
  String(process.env.CUSTOMER_PROFESSIONALS_MIRROR_MERCHANT || '1').trim() !== '0';

function professionalRowId(ownerPhone, professionId) {
  return `${String(ownerPhone || '').trim()}::${String(professionId || '').trim()}`;
}

function toProfessionalRow(payload, ownerPhone, professionId) {
  const id = professionalRowId(ownerPhone, professionId);
  return {
    id,
    owner_phone: ownerPhone,
    profession_id: professionId,
    store_name: payload.store_name ?? payload.storeName ?? null,
    description: payload.description ?? null,
    address: payload.address ?? null,
    open_time: payload.open_time ?? payload.openTime ?? null,
    close_time: payload.close_time ?? payload.closeTime ?? null,
    whatsapp: payload.whatsapp ?? null,
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    cover_image_url: payload.cover_image_url ?? payload.coverImageUrl ?? null,
    logo_image_url: payload.logo_image_url ?? payload.logoImageUrl ?? null,
    profile_image_base64:
      payload.profile_image_base64 ?? payload.profileImageBase64 ?? null,
    professional_info: payload.professional_info ?? payload.professionalInfo ?? {},
    is_open: payload.is_open !== false && payload.isOpen !== false,
    is_approved: Boolean(payload.is_approved ?? payload.isApproved ?? false),
    approval_status:
      String(payload.approval_status ?? payload.approvalStatus ?? 'pending').trim() ||
      'pending',
    is_frozen: Boolean(payload.is_frozen ?? payload.isFrozen ?? false),
    rejection_message_ar:
      payload.rejection_message_ar ?? payload.rejectionMessageAr ?? null,
    rejected_at: payload.rejected_at ?? payload.rejectedAt ?? null,
    legacy_id: payload.legacy_id || id,
    migrated_from: payload.migrated_from || 'merchant_service_profiles',
    created_at: payload.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

function professionalToServiceShape(row) {
  if (!row) return null;
  return {
    ...row,
    phone: row.owner_phone,
    service_id: 'professionals',
    service_sub_category: row.profession_id,
    professional_category_id: row.profession_id,
  };
}

async function getCustomerProfessional(ownerPhone, professionId) {
  const id = professionalRowId(ownerPhone, professionId);
  try {
    return await selectSingle('customer_professional_profiles', 'id', id);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return null;
    }
    throw error;
  }
}

async function upsertCustomerProfessional(payload, ownerPhone, professionId) {
  const row = toProfessionalRow(payload, ownerPhone, professionId);
  try {
    const saved = await saveRow('customer_professional_profiles', row, 'id');
    return professionalToServiceShape(saved || row);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      console.warn(
        'customer_professional_profiles missing — apply 20260902_customer_publish_decoupling.sql',
      );
      return null;
    }
    throw error;
  }
}

async function listCustomerProfessionalsByPhone(phone) {
  try {
    const variants = getPhoneVariants(phone);
    const rows = await selectMany(
      'customer_professional_profiles',
      [{ method: 'in', column: 'owner_phone', value: variants }],
      { column: 'updated_at', ascending: false },
      100,
    );
    return (rows || []).map(professionalToServiceShape);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return [];
    }
    throw error;
  }
}

async function listCustomerProfessionalsDirectory(professionId = '') {
  try {
    const {
      normalizeProfessionalCategoryId,
      LEGACY_PROFESSIONAL_CATEGORY_ALIASES,
    } = require('../lib/professional_categories');
    const clauses = [
      { method: 'eq', column: 'is_approved', value: true },
      { method: 'eq', column: 'is_open', value: true },
      { method: 'eq', column: 'is_frozen', value: false },
    ];
    const target = normalizeProfessionalCategoryId(professionId);
    if (target) {
      const legacyIds = Object.entries(LEGACY_PROFESSIONAL_CATEGORY_ALIASES)
        .filter(([, to]) => to === target)
        .map(([from]) => from);
      const ids = [target, ...legacyIds];
      if (ids.length === 1) {
        clauses.push({ method: 'eq', column: 'profession_id', value: target });
      } else {
        clauses.push({ method: 'in', column: 'profession_id', value: ids });
      }
    }
    const rows = await selectMany(
      'customer_professional_profiles',
      clauses,
      { column: 'updated_at', ascending: false },
      2000,
    );
    return (rows || []).map(professionalToServiceShape);
  } catch (error) {
    if (/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      return [];
    }
    throw error;
  }
}

async function deleteCustomerProfessional(ownerPhone, professionId) {
  const phoneKey = await resolvePhoneKey(ownerPhone);
  const id = professionalRowId(phoneKey, professionId);
  const profession = String(professionId || '').trim();
  if (!profession) throw new Error('اختر التخصص المراد حذفه.');

  try {
    await deleteRow('customer_professional_profiles', 'id', id);
  } catch (error) {
    if (!/relation|does not exist|42P01/i.test(String(error?.message || ''))) {
      throw error;
    }
  }

  return { ok: true, deleted: true, id, profession_id: profession };
}

module.exports = {
  MIRROR,
  professionalRowId,
  toProfessionalRow,
  professionalToServiceShape,
  getCustomerProfessional,
  upsertCustomerProfessional,
  listCustomerProfessionalsByPhone,
  listCustomerProfessionalsDirectory,
  deleteCustomerProfessional,
};
