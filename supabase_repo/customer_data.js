const {
  nowIso,
  isUuid,
  getPhoneVariants,
  resolvePhoneKey,
  selectSingleByPhone,
  selectMany,
  hasColumn,
  saveRow,
  deleteRow,
  assertSupabaseAdmin,
  assignIfDefined,
  parseOptionalBoolean,
} = require('./common');
const {
  ensureAppUser,
  getAppUserId,
} = require('./users');
const { pickRemoteImageUrl } = require('../services/image_refs');

async function getCustomerProfile(phone) {
  return selectSingleByPhone('customer_profiles', phone);
}

async function saveCustomerProfile(phone, data = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const appUser = await ensureAppUser(phoneKey, data);
  const basePayload = {
    updated_at: nowIso(),
  };
  if (await hasColumn('customer_profiles', 'phone')) {
    basePayload.phone = phoneKey;
  }
  if (await hasColumn('customer_profiles', 'user_id')) {
    basePayload.user_id = appUser?.id || null;
  }
  assignIfDefined(
    basePayload,
    'display_name',
    data.display_name ?? data.displayName ?? data.full_name
  );
  const avatarUrl = pickRemoteImageUrl(
    data.avatar_url,
    data.avatarUrl,
    data.avatar_base64,
    data.avatarBase64,
    data.customer_avatar_base64,
    data.customerAvatarBase64
  );
  if (avatarUrl) {
    assignIfDefined(basePayload, 'avatar_base64', avatarUrl);
    if (await hasColumn('customer_profiles', 'customer_avatar_base64')) {
      assignIfDefined(basePayload, 'customer_avatar_base64', avatarUrl);
    }
  }
  assignIfDefined(basePayload, 'address', data.address);
  if (await hasColumn('customer_profiles', 'governorate')) {
    assignIfDefined(basePayload, 'governorate', data.governorate);
  }
  if (await hasColumn('customer_profiles', 'district')) {
    assignIfDefined(basePayload, 'district', data.district);
  }
  if (await hasColumn('customer_profiles', 'locality')) {
    assignIfDefined(basePayload, 'locality', data.locality);
  }

  const conflictColumn = (await hasColumn('customer_profiles', 'phone'))
    ? 'phone'
    : 'user_id';
  return saveRow('customer_profiles', basePayload, conflictColumn);
}

async function deleteCustomerProfile(phone) {
  return deleteRow('customer_profiles', 'phone', phone);
}

async function getCustomerAddresses(phone) {
  if (await hasColumn('customer_addresses', 'phone')) {
    return selectMany(
      'customer_addresses',
      [{ method: 'eq', column: 'phone', value: phone }],
      { column: 'sort_order', ascending: true }
    );
  }

  const userId = await getAppUserId(phone);
  if (!userId) return [];

  const orderBy = (await hasColumn('customer_addresses', 'sort_order'))
    ? { column: 'sort_order', ascending: true }
    : { column: 'created_at', ascending: false };

  const rows = await selectMany(
    'customer_addresses',
    [{ method: 'eq', column: 'user_id', value: userId }],
    orderBy
  );
  return rows.map((row) => ({
    ...row,
    address_text: row.address_text ?? row.address ?? '',
  }));
}

async function saveCustomerAddress(phone, data = {}) {
  const addressText = String(data.address ?? data.address_text ?? '').trim();
  if (!addressText) {
    throw new Error('Address is required.');
  }
  const sortOrder = Number.parseInt(data.sortOrder ?? data.sort_order, 10) || 0;
  const supabase = assertSupabaseAdmin();
  const appUser = await ensureAppUser(phone, data);
  if (!appUser?.id) {
    throw new Error('Unable to resolve app user for address.');
  }

  let existingQuery = supabase.from('customer_addresses').select('id');
  if (await hasColumn('customer_addresses', 'phone')) {
    existingQuery = existingQuery.eq('phone', phone);
  } else {
    existingQuery = existingQuery.eq('user_id', appUser.id);
  }
  existingQuery = existingQuery.eq(
    (await hasColumn('customer_addresses', 'address_text')) ? 'address_text' : 'address',
    addressText
  );
  const existing = await existingQuery.maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const payload = { updated_at: nowIso() };
  if (await hasColumn('customer_addresses', 'phone')) {
    payload.phone = phone;
  }
  if (await hasColumn('customer_addresses', 'user_id')) {
    payload.user_id = appUser.id;
  }
  if (await hasColumn('customer_addresses', 'address_text')) {
    payload.address_text = addressText;
  }
  if (await hasColumn('customer_addresses', 'address')) {
    payload.address = addressText;
  }
  if (await hasColumn('customer_addresses', 'sort_order')) {
    payload.sort_order = sortOrder;
  }
  if (await hasColumn('customer_addresses', 'label')) {
    payload.label = String(data.label || 'عنوان محفوظ');
  }
  if (await hasColumn('customer_addresses', 'is_default')) {
    payload.is_default = Boolean(data.is_default ?? false);
  }

  if (existing.data?.id) {
    const { data: updated, error } = await supabase
      .from('customer_addresses')
      .update(payload)
      .eq('id', existing.data.id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return updated || null;
  }

  const { data: inserted, error } = await supabase
    .from('customer_addresses')
    .insert(payload)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return inserted || null;
}

async function deleteCustomerAddress(phone, address) {
  const supabase = assertSupabaseAdmin();
  let query = supabase.from('customer_addresses').delete();
  if (await hasColumn('customer_addresses', 'phone')) {
    query = query.eq('phone', phone);
  } else {
    const userId = await getAppUserId(phone);
    if (!userId) return;
    query = query.eq('user_id', userId);
  }
  query = query.eq(
    (await hasColumn('customer_addresses', 'address_text')) ? 'address_text' : 'address',
    address
  );
  const { error } = await query;
  if (error) throw new Error(error.message);
}

async function getCustomerFavorites(phone) {
  if (await hasColumn('customer_favorites', 'phone')) {
    return selectMany(
      'customer_favorites',
      [{ method: 'eq', column: 'phone', value: phone }],
      { column: 'created_at', ascending: false }
    );
  }

  const userId = await getAppUserId(phone);
  if (!userId) return [];
  return selectMany(
    'customer_favorites',
    [{ method: 'eq', column: 'user_id', value: userId }],
    { column: 'created_at', ascending: false }
  );
}

async function deleteAllCustomerAddressesForPhone(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const supabase = assertSupabaseAdmin();
  const variants = getPhoneVariants(phoneKey);
  if (variants.length === 0) return;

  if (await hasColumn('customer_addresses', 'phone')) {
    const { error } = await supabase
      .from('customer_addresses')
      .delete()
      .in('phone', variants);
    if (error && !/does not exist/i.test(error.message || '')) {
      throw new Error(error.message);
    }
    return;
  }

  const userId = await getAppUserId(phoneKey);
  if (!userId) return;
  const { error } = await supabase
    .from('customer_addresses')
    .delete()
    .eq('user_id', userId);
  if (error && !/does not exist/i.test(error.message || '')) {
    throw new Error(error.message);
  }
}

async function saveCustomerFavorite(phone, data = {}) {
  const productId = String(data.productId ?? data.product_id ?? '').trim();
  if (!productId) {
    throw new Error('Product id is required.');
  }
  const isFavorite = data.isFavorite !== false && data.is_favorite !== false;
  const supabase = assertSupabaseAdmin();
  const appUser = await ensureAppUser(phone, data);
  if (!appUser?.id) {
    throw new Error('Unable to resolve app user for favorite.');
  }

  if (!isUuid(productId)) {
    return null;
  }

  if (!isFavorite) {
    let removeQuery = supabase.from('customer_favorites').delete();
    if (await hasColumn('customer_favorites', 'phone')) {
      removeQuery = removeQuery.eq('phone', phone);
    } else {
      removeQuery = removeQuery.eq('user_id', appUser.id);
    }
    const { error } = await removeQuery.eq('product_id', productId);
    if (error) throw new Error(error.message);
    return null;
  }

  const payload = {
    product_id: productId,
    updated_at: nowIso(),
  };
  if (await hasColumn('customer_favorites', 'phone')) {
    payload.phone = phone;
  }
  if (await hasColumn('customer_favorites', 'user_id')) {
    payload.user_id = appUser.id;
  }

  let existingQuery = supabase
    .from('customer_favorites')
    .select('product_id')
    .eq('product_id', productId);
  if (await hasColumn('customer_favorites', 'phone')) {
    existingQuery = existingQuery.eq('phone', phone);
  } else {
    existingQuery = existingQuery.eq('user_id', appUser.id);
  }
  const existing = await existingQuery.maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  if (existing.data) {
    let updateQuery = supabase
      .from('customer_favorites')
      .update(payload)
      .eq('product_id', productId);
    if (await hasColumn('customer_favorites', 'phone')) {
      updateQuery = updateQuery.eq('phone', phone);
    } else {
      updateQuery = updateQuery.eq('user_id', appUser.id);
    }
    const { data: updated, error } = await updateQuery.select().maybeSingle();
    if (error) throw new Error(error.message);
    return updated || null;
  }

  const { data: inserted, error } = await supabase
    .from('customer_favorites')
    .insert(payload)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return inserted || null;
}

module.exports = {
  getCustomerProfile,
  saveCustomerProfile,
  deleteCustomerProfile,
  getCustomerAddresses,
  saveCustomerAddress,
  deleteCustomerAddress,
  getCustomerFavorites,
  saveCustomerFavorite,
};
