const express = require('express');
const router = express.Router();
const {
  getAppUser,
  saveAppUser,
  deleteAppUser,
  getCustomerProfile,
  saveCustomerProfile,
  deleteCustomerProfile,
  getCustomerAddresses,
  saveCustomerAddress,
  deleteCustomerAddress,
  getCustomerFavorites,
  saveCustomerFavorite,
  getCustomerOrders,
  mapOrderRow,
  saveCustomerOrder,
  createParcelOrder,
  saveDeviceToken,
  deleteDeviceToken,
  markPushInboxOpened,
  listUserNotifications,
  markUserNotificationsRead,
} = require('../supabase_repo');
const {
  requireAuthorizedPhone,
  requireOptionalAuthorizedPhone,
  parseQueryValue,
} = require('./_middleware');
const { getUserState, saveUserState } = require('../supabase_repo');
const {
  getDriverProfile,
  saveDriverProfile,
  getCourierProfile,
  saveCourierProfile,
} = require('../supabase_repo');
const {
  serializeUserStateForClient,
  serializeCustomerProfileForClient,
} = require('../services/image_refs');

// ── App User ────────────────────────────────────────────────────────────

router.get('/app-user', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await getAppUser(phone);
    return res.json(row);
  } catch (error) {
    console.error('get app-user error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load app user.' });
  }
});

router.put('/app-user', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveAppUser(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save app-user error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save app user.' });
  }
});

router.delete('/app-user', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    await deleteAppUser(phone);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete app-user error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete app user.' });
  }
});

// ── Device Token ────────────────────────────────────────────────────────

router.put('/device-token', async (req, res) => {
  try {
    const { shouldShedOptionalPolling, isTransientDbFailure } = require('../lib/db_circuit');
    if (shouldShedOptionalPolling()) {
      return res.json({ success: true, deferred: true });
    }
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveDeviceToken(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    const { isTransientDbFailure } = require('../lib/db_circuit');
    if (isTransientDbFailure(error)) {
      // لا نُفشل التطبيق بسبب توكن مؤجل — يُعاد لاحقاً.
      return res.json({ success: true, deferred: true });
    }
    console.error('save device-token error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save device token.' });
  }
});

router.get('/device-token/status', async (req, res) => {
  try {
    const { shouldShedOptionalPolling } = require('../lib/db_circuit');
    if (shouldShedOptionalPolling()) {
      return res.json({ hasToken: false, count: 0, platforms: [], deferred: true });
    }
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const { getDeviceTokensForPhone } = require('../supabase_repo/push_notifications');
    const rows = await getDeviceTokensForPhone(phone);
    const tokens = (rows || [])
      .map((row) => String(row.token || '').trim())
      .filter(Boolean);
    return res.json({
      hasToken: tokens.length > 0,
      count: tokens.length,
      platforms: [...new Set((rows || []).map((row) => String(row.platform || 'unknown')))],
      tokens,
    });
  } catch (error) {
    console.error('device-token status error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get device token status.' });
  }
});

router.delete('/device-token', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const token = String(req.body?.token || req.query?.token || '').trim();
    if (!token) {
      return res.status(400).json({ message: 'Device token is required.' });
    }
    await deleteDeviceToken(phone, token);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete device-token error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete device token.' });
  }
});

router.put('/push-inbox/opened', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await markPushInboxOpened(phone);
    return res.json(result);
  } catch (error) {
    console.error('mark push-inbox opened error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to mark inbox opened.' });
  }
});

// ── User in-app notifications ───────────────────────────────────────────

router.get('/user-notifications', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const since = parseQueryValue(req.query.since);
    const limit = parseQueryValue(req.query.limit);
    const rows = await listUserNotifications(phone, { since, limit });
    return res.json(rows);
  } catch (error) {
    console.error('list user-notifications error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load notifications.' });
  }
});

router.put('/user-notifications/read', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    const result = await markUserNotificationsRead(phone, ids);
    return res.json(result);
  } catch (error) {
    console.error('mark user-notifications read error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to mark notifications read.' });
  }
});

// ── Customer Profile ────────────────────────────────────────────────────

router.get('/customer-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await getCustomerProfile(phone);
    return res.json(serializeCustomerProfileForClient(row));
  } catch (error) {
    console.error('get customer-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load customer profile.' });
  }
});

router.put('/customer-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveCustomerProfile(phone, req.body || {});
    return res.json(serializeCustomerProfileForClient(row));
  } catch (error) {
    console.error('save customer-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save customer profile.' });
  }
});

router.delete('/customer-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    await deleteCustomerProfile(phone);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete customer-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete customer profile.' });
  }
});

// ── Customer Addresses ──────────────────────────────────────────────────

router.get('/customer-addresses', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getCustomerAddresses(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get customer-addresses error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load customer addresses.' });
  }
});

router.put('/customer-address', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveCustomerAddress(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer-address error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save customer address.' });
  }
});

router.delete('/customer-address', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    const address = String(parseQueryValue(req.query.address) || '').trim();
    if (!phone) return;
    if (!address) {
      return res.status(400).json({ message: 'Address is required.' });
    }
    await deleteCustomerAddress(phone, address);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete customer-address error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete customer address.' });
  }
});

// ── Customer Favorites ──────────────────────────────────────────────────

router.get('/customer-favorites', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getCustomerFavorites(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get customer-favorites error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load customer favorites.' });
  }
});

router.put('/customer-favorite', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveCustomerFavorite(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer-favorite error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save customer favorite.' });
  }
});

// ── Customer Orders ─────────────────────────────────────────────────────

router.get('/customer-orders', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getCustomerOrders(phone);
    // تحويل كل صف من تنسيق قاعدة البيانات (snake_case + order_payload)
    // إلى تنسيق camelCase مسطّح ليتوافق مع نموذج ActiveOrder في Flutter
    const mapped = rows.map(mapOrderRow);
    return res.json(mapped);
  } catch (error) {
    console.error('get customer-orders error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load customer orders.' });
  }
});

router.post('/parcel-quote', async (req, res) => {
  try {
    const pickup = String(req.body?.pickup ?? req.body?.pickupAddress ?? '').trim();
    const dropoff = String(req.body?.dropoff ?? req.body?.dropoffAddress ?? '').trim();
    if (!pickup || !dropoff) {
      return res.status(400).json({ message: 'عنوان الاستلام والتسليم مطلوبان.' });
    }
    const { quoteCourierDeliveryByAddresses } = require('../lib/courier_delivery_quote');
    const quote = await quoteCourierDeliveryByAddresses(pickup, dropoff);
    return res.json({
      distanceKm: quote.distanceKm,
      deliveryFeeIqd: quote.feeIqd,
    });
  } catch (error) {
    console.error('parcel-quote error:', error);
    return res.status(500).json({ message: error?.message || 'تعذر حساب سعر التوصيل.' });
  }
});

router.post('/parcel-order', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await createParcelOrder(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('create parcel-order error:', error);
    return res.status(400).json({
      message: error?.message || 'تعذر إرسال طلب وصلها.',
    });
  }
});

router.put('/customer-order', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveCustomerOrder(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer-order error:', error);
    const message = error?.message || 'Failed to save customer order.';
    const {
      PLATFORM_NIGHT_CLOSED_MESSAGE_AR,
    } = require('../services/merchant_working_hours');
    const isHoursBlocked =
      message === 'MERCHANT_FROZEN' ||
      message === PLATFORM_NIGHT_CLOSED_MESSAGE_AR ||
      message === 'MERCHANT_CLOSED' ||
      String(message).includes('انتهى وقت الدوام') ||
      String(message).includes('المتجر مغلق حالياً') ||
      String(message).includes('لا يمكن الطلب');
    const isWalletBlocked =
      error?.code === 'INSUFFICIENT_WALLET_BALANCE' ||
      message.includes('رصيد الحساب غير كافٍ');
    const status = isHoursBlocked || isWalletBlocked ? 409 : 500;
    return res.status(status).json({
      message: isWalletBlocked
        ? 'المتجر غير متاح حالياً لاستقبال الطلبات. حاول لاحقاً.'
        : message,
      code: error?.code || undefined,
    });
  }
});

// ── User State (للمستخدم العادي، بدون صلاحية أدمن) ─────────────────

router.get('/user-state', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const state = serializeUserStateForClient((await getUserState(phone)) || {});
    return res.json(state);
  } catch (error) {
    console.error('get user-state error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load user state.' });
  }
});

router.put('/user-state', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveUserState(phone, req.body?.state || {});
    const state = row?.state ?? (await getUserState(phone)) ?? {};
    return res.json(serializeUserStateForClient(state));
  } catch (error) {
    console.error('save user-state error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save user state.' });
  }
});

// ── Driver / Courier profiles ───────────────────────────────────────────

router.get('/driver-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const profile = await getDriverProfile(phone);
    return res.json(profile);
  } catch (error) {
    console.error('get driver-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load driver profile.' });
  }
});

router.put('/driver-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const profile = await saveDriverProfile(phone, req.body || {});
    return res.json(profile);
  } catch (error) {
    console.error('save driver-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save driver profile.' });
  }
});

router.get('/courier-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const profile = await getCourierProfile(phone);
    return res.json(profile);
  } catch (error) {
    console.error('get courier-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load courier profile.' });
  }
});

router.put('/courier-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const profile = await saveCourierProfile(phone, req.body || {});
    return res.json(profile);
  } catch (error) {
    console.error('save courier-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save courier profile.' });
  }
});

// ── Customer offers (قسم العروض والخصومات) ───────────────────────────────

router.post('/customer/offers', async (req, res) => {
  try {
    // يعتمد على رقم الجلسة — التطبيق لا يرسل phone في الجسم دائماً.
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerOffer } = require('../supabase_repo/customer_offers');
    const row = await saveCustomerOffer(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer offer error:', error);
    const message = error?.message || 'Failed to save offer.';
    const status = /Unauthorized|أدخل|اختر/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/offers', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerOffer } = require('../supabase_repo/customer_offers');
    const row = await saveCustomerOffer(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer offer error:', error);
    const message = error?.message || 'Failed to update offer.';
    const status = /Unauthorized|أدخل|اختر|Not a customer/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-offers', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { listMyCustomerOffers } = require('../supabase_repo/customer_offers');
    const rows = await listMyCustomerOffers(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list my customer offers error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load offers.' });
  }
});

router.delete('/customer/offers', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const offerId = String(
      req.query?.id || req.body?.id || req.body?.offerId || '',
    ).trim();
    if (!offerId) {
      return res.status(400).json({ message: 'Offer id is required.' });
    }
    const { deleteCustomerOffer } = require('../supabase_repo/customer_offers');
    const result = await deleteCustomerOffer(phone, offerId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer offer error:', error);
    const message = error?.message || 'Failed to delete offer.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer used listings (قسم المستعمل) ───────────────────────────────

router.post('/customer/used', async (req, res) => {
  try {
    // يعتمد على رقم الجلسة — التطبيق يرسل contact_phone لا phone.
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerUsedListing } = require('../supabase_repo/customer_used');
    const row = await saveCustomerUsedListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer used error:', error);
    const message = error?.message || 'Failed to save used listing.';
    const status = /Unauthorized|أدخل|اختر/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/used', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerUsedListing } = require('../supabase_repo/customer_used');
    const row = await saveCustomerUsedListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer used error:', error);
    const message = error?.message || 'Failed to update used listing.';
    const status = /Unauthorized|أدخل|اختر|Not a customer/.test(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-used', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listMyCustomerUsedListings,
    } = require('../supabase_repo/customer_used');
    const rows = await listMyCustomerUsedListings(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list my customer used error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load used listings.' });
  }
});

router.delete('/customer/used', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const listingId = String(
      req.query?.id || req.body?.id || req.body?.listingId || '',
    ).trim();
    if (!listingId) {
      return res.status(400).json({ message: 'Listing id is required.' });
    }
    const {
      deleteCustomerUsedListing,
    } = require('../supabase_repo/customer_used');
    const result = await deleteCustomerUsedListing(phone, listingId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer used error:', error);
    const message = error?.message || 'Failed to delete used listing.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer car sell listings (بيع سيارة من حساب الزبون) ───────────────

router.post('/customer/cars', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerCarListing } = require('../supabase_repo/customer_cars');
    const row = await saveCustomerCarListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer car error:', error);
    const message = error?.message || 'Failed to save car listing.';
    const status = /Unauthorized|أدخل/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/cars', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerCarListing } = require('../supabase_repo/customer_cars');
    const row = await saveCustomerCarListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer car error:', error);
    const message = error?.message || 'Failed to update car listing.';
    const status = /Unauthorized|أدخل|Not a car/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-cars', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listMyCustomerCarListings,
    } = require('../supabase_repo/customer_cars');
    const rows = await listMyCustomerCarListings(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list my customer cars error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load car listings.' });
  }
});

router.delete('/customer/cars', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const listingId = String(
      req.query?.id || req.body?.id || req.body?.listingId || '',
    ).trim();
    if (!listingId) {
      return res.status(400).json({ message: 'Listing id is required.' });
    }
    const {
      deleteCustomerCarListing,
    } = require('../supabase_repo/customer_cars');
    const result = await deleteCustomerCarListing(phone, listingId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer car error:', error);
    const message = error?.message || 'Failed to delete car listing.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer shopping products (التسوق من حساب الزبون) ─────────────────

router.post('/customer/shopping-products', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerShoppingProduct,
    } = require('../supabase_repo/customer_shopping');
    const row = await saveCustomerShoppingProduct(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer shopping product error:', error);
    const message = error?.message || 'Failed to save shopping product.';
    const status = /Unauthorized|أدخل|اختر|Not a shopping/.test(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/shopping-products', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerShoppingProduct,
    } = require('../supabase_repo/customer_shopping');
    const row = await saveCustomerShoppingProduct(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer shopping product error:', error);
    const message = error?.message || 'Failed to update shopping product.';
    const status = /Unauthorized|أدخل|اختر|Not a shopping/.test(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-shopping-products', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const subCategoryId = String(
      req.query?.subCategoryId || req.query?.sub_category || '',
    ).trim();
    const {
      listMyCustomerShoppingProducts,
    } = require('../supabase_repo/customer_shopping');
    const rows = await listMyCustomerShoppingProducts(phone, { subCategoryId });
    return res.json(rows);
  } catch (error) {
    console.error('list my shopping products error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load shopping products.' });
  }
});

router.get('/customer/has-shopping-store', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      hasMyCustomerShoppingStore,
    } = require('../supabase_repo/customer_shopping');
    const hasStore = await hasMyCustomerShoppingStore(phone);
    return res.json({ hasStore: Boolean(hasStore) });
  } catch (error) {
    console.error('has shopping store error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to check shopping store.' });
  }
});

router.get('/customer/has-printing-store', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      hasMyCustomerPrintingStore,
    } = require('../supabase_repo/customer_printing');
    const hasStore = await hasMyCustomerPrintingStore(phone);
    return res.json({ hasStore: Boolean(hasStore) });
  } catch (error) {
    console.error('has printing store error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to check printing store.' });
  }
});

router.delete('/customer/shopping-products', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const productId = String(
      req.query?.id || req.body?.id || req.body?.productId || '',
    ).trim();
    if (!productId) {
      return res.status(400).json({ message: 'Product id is required.' });
    }
    const {
      deleteCustomerShoppingProduct,
    } = require('../supabase_repo/customer_shopping');
    const result = await deleteCustomerShoppingProduct(phone, productId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer shopping product error:', error);
    const message = error?.message || 'Failed to delete shopping product.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.delete('/customer/shopping-store', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      deleteCustomerShoppingStore,
    } = require('../supabase_repo/customer_shopping');
    const result = await deleteCustomerShoppingStore(phone);
    return res.json(result);
  } catch (error) {
    console.error('delete customer shopping store error:', error);
    const message = error?.message || 'Failed to delete shopping store.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer car request listings (طلب سيارة من حساب الزبون) ────────────

router.post('/customer/car-requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerCarRequestListing,
    } = require('../supabase_repo/customer_cars');
    const row = await saveCustomerCarRequestListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer car-request error:', error);
    const message = error?.message || 'Failed to save car request.';
    const status = /Unauthorized|أدخل|اختر/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/car-requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerCarRequestListing,
    } = require('../supabase_repo/customer_cars');
    const row = await saveCustomerCarRequestListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer car-request error:', error);
    const message = error?.message || 'Failed to update car request.';
    const status = /Unauthorized|أدخل|اختر|Not a car/.test(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-car-requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listMyCustomerCarRequestListings,
    } = require('../supabase_repo/customer_cars');
    const rows = await listMyCustomerCarRequestListings(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list my customer car-requests error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load car requests.' });
  }
});

router.delete('/customer/car-requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const listingId = String(
      req.query?.id || req.body?.id || req.body?.listingId || '',
    ).trim();
    if (!listingId) {
      return res.status(400).json({ message: 'Listing id is required.' });
    }
    const {
      deleteCustomerCarRequestListing,
    } = require('../supabase_repo/customer_cars');
    const result = await deleteCustomerCarRequestListing(phone, listingId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer car-request error:', error);
    const message = error?.message || 'Failed to delete car request.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer real estate listings (قسم العقارات — نشر مباشر) ─────────────

router.post('/customer/real-estate', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerRealEstateListing,
    } = require('../supabase_repo/customer_real_estate');
    const row = await saveCustomerRealEstateListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer real-estate error:', error);
    const message = error?.message || 'Failed to save real estate listing.';
    const status = /Unauthorized|أدخل|اختر/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/real-estate', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerRealEstateListing,
    } = require('../supabase_repo/customer_real_estate');
    const row = await saveCustomerRealEstateListing(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer real-estate error:', error);
    const message = error?.message || 'Failed to update real estate listing.';
    const status = /Unauthorized|أدخل|اختر|Not a real/.test(message)
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-real-estate', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listMyCustomerRealEstateListings,
    } = require('../supabase_repo/customer_real_estate');
    const limit = Number(req.query?.limit ?? 10);
    const offset = Number(req.query?.offset ?? 0);
    const rows = await listMyCustomerRealEstateListings(phone, {
      limit,
      offset,
    });
    return res.json(rows);
  } catch (error) {
    console.error('list my customer real-estate error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load real estate listings.' });
  }
});

router.get('/customer/my-real-estate/has', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      hasMyCustomerRealEstateListings,
    } = require('../supabase_repo/customer_real_estate');
    const result = await hasMyCustomerRealEstateListings(phone);
    return res.json(result);
  } catch (error) {
    console.error('has my customer real-estate error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to check real estate listings.' });
  }
});

router.delete('/customer/real-estate', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const listingId = String(
      req.query?.id || req.body?.id || req.body?.listingId || '',
    ).trim();
    if (!listingId) {
      return res.status(400).json({ message: 'Listing id is required.' });
    }
    const {
      deleteCustomerRealEstateListing,
    } = require('../supabase_repo/customer_real_estate');
    const result = await deleteCustomerRealEstateListing(phone, listingId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer real-estate error:', error);
    const message = error?.message || 'Failed to delete real estate listing.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer professional profiles (قسم المهنيين — نشر مباشر) ─────────────

router.post('/customer/professionals', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerProfessionalProfile,
    } = require('../supabase_repo/customer_professionals');
    const row = await saveCustomerProfessionalProfile(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer professional error:', error);
    const message = error?.message || 'Failed to save professional profile.';
    const status = /Unauthorized|أدخل|اختر|حدّد|أضف/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/professionals', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerProfessionalProfile,
    } = require('../supabase_repo/customer_professionals');
    const row = await saveCustomerProfessionalProfile(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer professional error:', error);
    const message = error?.message || 'Failed to update professional profile.';
    const status = /Unauthorized|أدخل|اختر|حدّد|أضف/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-professionals', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listMyCustomerProfessionalProfiles,
    } = require('../supabase_repo/customer_professionals');
    const rows = await listMyCustomerProfessionalProfiles(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list my customer professionals error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load professional profiles.' });
  }
});

router.get('/customer/my-professional', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const professionId = String(
      req.query.professionId ?? req.query.profession_id ?? req.query.categoryId ?? '',
    ).trim();
    const {
      getMyCustomerProfessionalProfile,
    } = require('../supabase_repo/customer_professionals');
    const row = await getMyCustomerProfessionalProfile(phone, professionId);
    return res.json(row);
  } catch (error) {
    console.error('get my customer professional error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load professional profile.' });
  }
});

router.get('/customer/my-professional/has', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const professionId = String(
      req.query.professionId ?? req.query.profession_id ?? req.query.categoryId ?? '',
    ).trim();
    const {
      hasMyCustomerProfessionalProfile,
    } = require('../supabase_repo/customer_professionals');
    const result = await hasMyCustomerProfessionalProfile(phone, professionId);
    return res.json(result);
  } catch (error) {
    console.error('has my customer professional error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to check professional profile.' });
  }
});

router.delete('/customer/professionals', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const professionId = String(
      req.query?.professionId ||
        req.query?.profession_id ||
        req.body?.professionId ||
        req.body?.profession_id ||
        '',
    ).trim();
    if (!professionId) {
      return res.status(400).json({ message: 'Profession id is required.' });
    }
    const {
      deleteCustomerProfessionalProfile,
    } = require('../supabase_repo/customer_professionals');
    const result = await deleteCustomerProfessionalProfile(phone, professionId);
    return res.json(result);
  } catch (error) {
    console.error('delete customer professional error:', error);
    const message = error?.message || 'Failed to delete professional profile.';
    const status = /Unauthorized|اختر/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer restaurant (قسم مطاعم ومرطبات — نشر مباشر كمتجر كامل) ────────

router.post('/customer/restaurant', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerRestaurant,
    } = require('../supabase_repo/customer_restaurants');
    const row = await saveCustomerRestaurant(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer restaurant error:', error);
    const message = error?.message || 'Failed to save restaurant.';
    const status = /Unauthorized|أدخل|اختر|حدّد/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/restaurant', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      saveCustomerRestaurant,
    } = require('../supabase_repo/customer_restaurants');
    const row = await saveCustomerRestaurant(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer restaurant error:', error);
    const message = error?.message || 'Failed to update restaurant.';
    const status = /Unauthorized|أدخل|اختر|حدّد/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-restaurant', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      getMyCustomerRestaurant,
    } = require('../supabase_repo/customer_restaurants');
    const row = await getMyCustomerRestaurant(phone);
    return res.json(row);
  } catch (error) {
    console.error('get my customer restaurant error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load restaurant.' });
  }
});

router.delete('/customer/restaurant', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      deleteCustomerRestaurant,
    } = require('../supabase_repo/customer_restaurants');
    const result = await deleteCustomerRestaurant(phone);
    return res.json(result);
  } catch (error) {
    console.error('delete customer restaurant error:', error);
    const message = error?.message || 'Failed to delete restaurant.';
    const status = /Unauthorized/.test(message) ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Customer pharmacy (قسم الصيدليات — نشر من حساب الزبون) ────────────────

router.post('/customer/pharmacy', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerPharmacy } = require('../supabase_repo/customer_pharmacies');
    const row = await saveCustomerPharmacy(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer pharmacy error:', error);
    const message = error?.message || 'Failed to save pharmacy.';
    const status = /Unauthorized|أدخل|اختر|حدّد|جدول/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/pharmacy', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerPharmacy } = require('../supabase_repo/customer_pharmacies');
    const row = await saveCustomerPharmacy(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer pharmacy error:', error);
    const message = error?.message || 'Failed to update pharmacy.';
    const status = /Unauthorized|أدخل|اختر|حدّد|جدول/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-pharmacy', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { getMyCustomerPharmacy } = require('../supabase_repo/customer_pharmacies');
    const row = await getMyCustomerPharmacy(phone);
    return res.json(row);
  } catch (error) {
    console.error('get my customer pharmacy error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load pharmacy.' });
  }
});

// ── Customer beauty (الصحة والجمال — كل التخصصات من حساب الزبون) ───────────

router.post('/customer/beauty', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerBeauty } = require('../supabase_repo/customer_pharmacies');
    const row = await saveCustomerBeauty(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save customer beauty error:', error);
    const message = error?.message || 'Failed to save beauty listing.';
    const status = /Unauthorized|أدخل|اختر|حدّد|جدول/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/customer/beauty', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCustomerBeauty } = require('../supabase_repo/customer_pharmacies');
    const row = await saveCustomerBeauty(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('update customer beauty error:', error);
    const message = error?.message || 'Failed to update beauty listing.';
    const status = /Unauthorized|أدخل|اختر|حدّد|جدول/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/customer/my-beauty', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const sub =
      String(req.query.sub || req.query.subCategory || '').trim() || 'صيدلية';
    const { getMyCustomerBeauty } = require('../supabase_repo/customer_pharmacies');
    const row = await getMyCustomerBeauty(phone, sub);
    return res.json(row);
  } catch (error) {
    console.error('get my customer beauty error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load beauty listing.' });
  }
});

router.get('/customer/my-beauty-listings', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { listMyCustomerBeautyProfiles } = require('../supabase_repo/customer_pharmacies');
    const rows = await listMyCustomerBeautyProfiles(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list my customer beauty error:', error);
    return res
      .status(500)
      .json({ message: error?.message || 'Failed to load beauty listings.' });
  }
});

router.delete('/customer/beauty', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const sub = String(
      req.query?.sub ||
        req.query?.subCategory ||
        req.body?.sub ||
        req.body?.subCategory ||
        req.body?.service_sub_category ||
        '',
    ).trim();
    if (!sub) {
      return res.status(400).json({ message: 'Sub category is required.' });
    }
    const { deleteCustomerBeauty } = require('../supabase_repo/customer_pharmacies');
    const result = await deleteCustomerBeauty(phone, sub);
    return res.json(result);
  } catch (error) {
    console.error('delete customer beauty error:', error);
    const message = error?.message || 'Failed to delete beauty listing.';
    const status = /Unauthorized|اختر/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.use(require('./provider_wallet'));
router.use(require('./loyalty'));

module.exports = router;
