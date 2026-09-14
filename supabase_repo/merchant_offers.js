const {
  selectSingleByPhone,
  selectMany,
  resolvePhoneKey,
  saveRow,
  nowIso,
  normalizeArray,
  assertSupabaseAdmin,
  hasColumn,
} = require('./common');
const { ensureAppUser } = require('./users');

function rowToOfferMap(row) {
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    titleAr: row.title_ar || '',
    titleEn: row.title_en || '',
    discountPercent: Number(row.discount_percent || 0),
    startDate: row.start_date || '',
    endDate: row.end_date || '',
    productNamesAr: normalizeArray(row.product_names_ar),
    isActive: row.is_active !== false,
  };
}

async function buildOfferRow(phoneKey, offer = {}) {
  const id = String(offer.id || '').trim();
  if (!id) throw new Error('Offer id is required.');

  const appUser = await ensureAppUser(phoneKey);
  const merchantProfile = await selectSingleByPhone('merchant_profiles', phoneKey);

  const row = {
    id,
    title_ar: String(offer.titleAr ?? offer.title_ar ?? '').trim(),
    title_en: String(offer.titleEn ?? offer.title_en ?? '').trim(),
    discount_percent:
      Number.parseInt(offer.discountPercent ?? offer.discount_percent, 10) || 0,
    start_date: String(offer.startDate ?? offer.start_date ?? '').trim() || null,
    end_date: String(offer.endDate ?? offer.end_date ?? '').trim() || null,
    product_names_ar: normalizeArray(offer.productNamesAr ?? offer.product_names_ar),
    is_active: offer.isActive !== false && offer.is_active !== false,
    updated_at: nowIso(),
  };

  if (await hasColumn('merchant_offers', 'phone')) {
    row.phone = phoneKey;
  }
  if (await hasColumn('merchant_offers', 'merchant_user_id')) {
    if (!appUser?.id) {
      throw new Error('App user id is required for merchant offers.');
    }
    row.merchant_user_id = appUser.id;
  }
  if (await hasColumn('merchant_offers', 'merchant_service_id')) {
    row.merchant_service_id =
      merchantProfile?.id || merchantProfile?.user_id || appUser?.id || null;
  }
  if (await hasColumn('merchant_offers', 'service_id')) {
    row.service_id =
      String(
        offer.serviceId ??
          offer.service_id ??
          merchantProfile?.primary_service_id ??
          'restaurant'
      ).trim() || 'restaurant';
  }

  return row;
}

async function getMerchantOffers(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const filters = [];

  if (await hasColumn('merchant_offers', 'phone')) {
    filters.push({ method: 'eq', column: 'phone', value: phoneKey });
  } else if (await hasColumn('merchant_offers', 'merchant_user_id')) {
    const appUser = await selectSingleByPhone('app_users', phoneKey);
    if (!appUser?.id) return [];
    filters.push({ method: 'eq', column: 'merchant_user_id', value: appUser.id });
  } else {
    return [];
  }

  const rows = await selectMany(
    'merchant_offers',
    filters,
    { column: 'updated_at', ascending: false },
    100
  );
  return (rows || []).map(rowToOfferMap).filter(Boolean);
}

async function saveMerchantOffer(phone, offer = {}) {
  const phoneKey = await resolvePhoneKey(phone);
  const row = await buildOfferRow(phoneKey, offer);
  await saveRow('merchant_offers', row, 'id');
  return rowToOfferMap(row);
}

async function deleteMerchantOffer(phone, offerId) {
  const phoneKey = await resolvePhoneKey(phone);
  const id = String(offerId || '').trim();
  if (!id) throw new Error('Offer id is required.');
  const supabase = assertSupabaseAdmin();

  let query = supabase.from('merchant_offers').delete().eq('id', id);
  if (await hasColumn('merchant_offers', 'phone')) {
    query = query.eq('phone', phoneKey);
  } else if (await hasColumn('merchant_offers', 'merchant_user_id')) {
    const appUser = await selectSingleByPhone('app_users', phoneKey);
    if (!appUser?.id) throw new Error('Offer not found.');
    query = query.eq('merchant_user_id', appUser.id);
  }

  const { error } = await query;
  if (error) throw new Error(error.message);
}

async function getMerchantReviewOwnerFilter(phoneKey) {
  if (await hasColumn('merchant_reviews', 'merchant_phone')) {
    return { column: 'merchant_phone', value: phoneKey };
  }
  if (await hasColumn('merchant_reviews', 'merchant_user_id')) {
    const appUser = await selectSingleByPhone('app_users', phoneKey);
    if (!appUser?.id) return null;
    return { column: 'merchant_user_id', value: appUser.id };
  }
  return null;
}

function formatMerchantReviewRow(row) {
  if (!row) return null;
  return {
    id: String(row.order_id || row.id || '').trim(),
    customerName: String(row.customer_name || row.customer_phone || '').trim(),
    customerPhone: String(row.customer_phone || '').trim(),
    stars: Number(row.stars || 0),
    comment: String(row.comment || '').trim(),
    date: row.created_at
      ? new Date(row.created_at).toLocaleDateString('ar-EG')
      : '',
    reply: String(row.reply || '').trim() || null,
  };
}

async function getMerchantReviewsForMerchant(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const ownerFilter = await getMerchantReviewOwnerFilter(phoneKey);
  if (!ownerFilter) return [];

  const rows = await selectMany(
    'merchant_reviews',
    [{ method: 'eq', column: ownerFilter.column, value: ownerFilter.value }],
    { column: 'created_at', ascending: false },
    100
  );
  return (rows || []).map(formatMerchantReviewRow).filter(Boolean);
}

async function replyMerchantReview(phone, reviewId, reply) {
  const phoneKey = await resolvePhoneKey(phone);
  const ownerFilter = await getMerchantReviewOwnerFilter(phoneKey);
  if (!ownerFilter) throw new Error('Reviews schema is not configured.');

  const id = String(reviewId || '').trim();
  if (!id) throw new Error('Review id is required.');
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('merchant_reviews')
    .update({ reply: String(reply || '').trim(), updated_at: nowIso() })
    .eq(ownerFilter.column, ownerFilter.value)
    .or(`order_id.eq.${id},id.eq.${id}`)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Review not found.');
  return formatMerchantReviewRow(data);
}

async function buildMerchantReviewUpsertPayload({
  merchantPhone,
  customerPhone,
  customerName,
  orderId,
  stars,
  comment,
}) {
  const mPhone = await resolvePhoneKey(merchantPhone);
  const cPhone = await resolvePhoneKey(customerPhone);
  const payload = {
    order_id: orderId,
    stars: Number(stars),
    comment: comment || '',
    updated_at: nowIso(),
  };

  if (await hasColumn('merchant_reviews', 'merchant_phone')) {
    payload.merchant_phone = mPhone;
  } else if (await hasColumn('merchant_reviews', 'merchant_user_id')) {
    const merchantUser = await selectSingleByPhone('app_users', mPhone);
    if (!merchantUser?.id) throw new Error('Merchant user not found.');
    payload.merchant_user_id = merchantUser.id;
  } else {
    throw new Error('merchant_reviews merchant column is missing.');
  }

  if (await hasColumn('merchant_reviews', 'customer_phone')) {
    payload.customer_phone = cPhone;
  } else if (await hasColumn('merchant_reviews', 'customer_user_id')) {
    const customerUser = await selectSingleByPhone('app_users', cPhone);
    if (customerUser?.id) payload.customer_user_id = customerUser.id;
  }

  if (await hasColumn('merchant_reviews', 'customer_name')) {
    payload.customer_name = customerName;
  }

  return { payload, merchantPhone: mPhone };
}

module.exports = {
  getMerchantOffers,
  saveMerchantOffer,
  deleteMerchantOffer,
  getMerchantReviewsForMerchant,
  replyMerchantReview,
  buildMerchantReviewUpsertPayload,
  getMerchantReviewOwnerFilter,
  rowToOfferMap,
  buildOfferRow,
};
