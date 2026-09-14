const express = require('express');
const router = express.Router();
const {
  getMerchantProfile,
  getMerchantProfileForClient,
  saveMerchantProfile,
  deleteMerchantProfile,
  getMerchantProducts,
  saveMerchantProduct,
  deleteMerchantProduct,
  listProfessionalProfiles,
  saveMerchantReview,
  getMerchantIncomingOrders,
  updateIncomingOrderStatus,
  getMerchantOffers,
  saveMerchantOffer,
  deleteMerchantOffer,
  getMerchantReviewsForMerchant,
  replyMerchantReview,
} = require('../supabase_repo');
const {
  requireAuthorizedPhone,
  requireOptionalAuthorizedPhone,
  parseQueryValue,
} = require('./_middleware');

// ── Merchant Profile ────────────────────────────────────────────────────

router.get('/merchant-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await getMerchantProfileForClient(phone);
    return res.json(row);
  } catch (error) {
    console.error('get merchant-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load merchant profile.' });
  }
});

router.put('/merchant-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveMerchantProfile(phone, req.body || {});
    const { serializeMerchantProfileForClient } = require('../services/image_refs');
    return res.json(serializeMerchantProfileForClient(row));
  } catch (error) {
    console.error('save merchant-profile error:', error);
    const message = error?.message || 'Failed to save merchant profile.';
    if (String(message).includes('PROFESSIONALS_CUSTOMER_ONLY')) {
      return res.status(403).json({
        message: 'نشر المهنيين متاح من حساب الزبون في قسم المهنيين فقط.',
        code: 'PROFESSIONALS_CUSTOMER_ONLY',
      });
    }
    if (String(message).includes('RESTAURANT_CUSTOMER_ONLY')) {
      return res.status(403).json({
        message:
          'تسجيل المطاعم والكوفيات يتم الآن من حساب الزبون في قسم المطاعم — سجّل منشأتك من هناك.',
        code: 'RESTAURANT_CUSTOMER_ONLY',
      });
    }
    return res.status(500).json({ message });
  }
});

router.delete('/merchant-profile', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    await deleteMerchantProfile(phone);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete merchant-profile error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete merchant profile.' });
  }
});

// ── Merchant Products ───────────────────────────────────────────────────

router.get('/merchant-products', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getMerchantProducts(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get merchant-products error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load merchant products.' });
  }
});

router.put('/merchant-product', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveMerchantProduct(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save merchant-product error:', error);
    const message = error?.message || 'Failed to save merchant product.';
    if (String(message).includes('OFFERS_CUSTOMER_ONLY')) {
      return res.status(403).json({
        message:
          'نشر العروض متاح من حساب الزبون في قسم العروض والخصومات فقط.',
        code: 'OFFERS_CUSTOMER_ONLY',
      });
    }
    if (String(message).includes('USED_CUSTOMER_ONLY')) {
      return res.status(403).json({
        message:
          'نشر المستعمل متاح من حساب الزبون في قسم المنتجات المستعملة فقط.',
        code: 'USED_CUSTOMER_ONLY',
      });
    }
    if (String(message).includes('REAL_ESTATE_CUSTOMER_ONLY')) {
      return res.status(403).json({
        message:
          'نشر العقارات متاح من حساب الزبون في قسم العقارات فقط.',
        code: 'REAL_ESTATE_CUSTOMER_ONLY',
      });
    }
    if (String(message).includes('PROFESSIONALS_CUSTOMER_ONLY')) {
      return res.status(403).json({
        message:
          'نشر المهنيين متاح من حساب الزبون في قسم المهنيين فقط.',
        code: 'PROFESSIONALS_CUSTOMER_ONLY',
      });
    }
    const status =
      message === 'FEATURE_REMOVED' || message === 'BAZAAR_CHANNEL_REMOVED'
        ? 410
        : message === 'SECTION_REQUIRED' || message === 'SECTION_NOT_FOUND'
          ? 400
          : error?.code === 'EDEN_PRINTING_FORBIDDEN' ||
              message.includes('غير مصرح بالنشر في مطبعة جنة عدن')
            ? 403
            : message.includes('Unauthorized')
              ? 403
              : 500;
    const arabicMessage =
      message === 'SECTION_REQUIRED'
        ? 'يجب اختيار قسم للمنتج قبل الحفظ.'
        : message === 'SECTION_NOT_FOUND'
          ? 'القسم المحدد غير موجود. حدّث الأقسام ثم أعد المحاولة.'
          : message === 'FEATURE_REMOVED' || message === 'BAZAAR_CHANNEL_REMOVED'
            ? 'هذه الميزة لم تعد متاحة.'
            : message;
    return res.status(status).json({
      message: arabicMessage,
      code: message,
    });
  }
});

router.delete('/merchant-product', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    const id = String(parseQueryValue(req.query.id) || '').trim();
    if (!phone) return;
    if (!id) {
      return res.status(400).json({ message: 'Product id is required.' });
    }
    await deleteMerchantProduct(id, phone);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete merchant-product error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete merchant product.' });
  }
});

// ── Professionals (public) ──────────────────────────────────────────────

router.get('/professionals', async (req, res) => {
  try {
    const professionId = String(parseQueryValue(req.query.professionId) || '').trim();
    const rows = await listProfessionalProfiles(professionId);
    return res.json(rows);
  } catch (error) {
    console.error('list professionals error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load professionals.' });
  }
});

// ── Merchant Offers ─────────────────────────────────────────────────────

router.get('/merchant-offers', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getMerchantOffers(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get merchant-offers error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load merchant offers.' });
  }
});

router.put('/merchant-offer', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveMerchantOffer(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('save merchant-offer error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save merchant offer.' });
  }
});

router.delete('/merchant-offer', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const offerId = String(req.body?.id || req.query?.id || '').trim();
    if (!offerId) {
      return res.status(400).json({ message: 'Offer id is required.' });
    }
    await deleteMerchantOffer(phone, offerId);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete merchant-offer error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete merchant offer.' });
  }
});

router.get('/merchant-reviews', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getMerchantReviewsForMerchant(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get merchant-reviews error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load merchant reviews.' });
  }
});

router.put('/merchant-review/reply', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const reviewId = String(req.body?.reviewId || req.body?.id || '').trim();
    if (!reviewId) {
      return res.status(400).json({ message: 'Review id is required.' });
    }
    const row = await replyMerchantReview(phone, reviewId, req.body?.reply || '');
    if (row?.customerPhone && row?.id) {
      try {
        const { notifyCustomerReviewReplied } = require('../push_events');
        await notifyCustomerReviewReplied(row.customerPhone, row.id);
      } catch (pushError) {
        console.error('notifyCustomerReviewReplied error:', pushError?.message || pushError);
      }
    }
    return res.json(row);
  } catch (error) {
    console.error('reply merchant-review error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to reply to review.' });
  }
});

// ── Merchant Review (customer submit) ───────────────────────────────────

router.post('/merchant-review', async (req, res) => {
  try {
    // التقييم يُنسب دائماً لرقم الجلسة — لا يُقبل انتحال customerPhone من الـ body
    const sessionPhone = requireAuthorizedPhone(req, res, { allowMissing: true });
    if (!sessionPhone) return;

    const merchantPhone = String(req.body?.merchantPhone || '').trim();
    const orderId = String(req.body?.orderId || '').trim();
    const stars = req.body?.stars;
    const customerName = req.body?.customerName;
    const comment = req.body?.comment;
    const spoofedCustomer = String(req.body?.customerPhone || '').trim();

    if (spoofedCustomer) {
      const { phonesOverlap } = require('../supabase_repo/common');
      if (!phonesOverlap(sessionPhone, spoofedCustomer)) {
        return res.status(403).json({
          message: 'You are not allowed to submit a review as another customer.',
        });
      }
    }

    if (!merchantPhone || !orderId || !stars) {
      return res.status(400).json({ message: 'Missing required review fields.' });
    }
    const result = await saveMerchantReview({
      merchantPhone,
      customerPhone: sessionPhone,
      customerName,
      orderId,
      stars,
      comment,
    });
    return res.json(result);
  } catch (error) {
    console.error('merchant-review error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save review.' });
  }
});

// ── Merchant Incoming Orders ────────────────────────────────────────────

router.get('/merchant-incoming-orders', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getMerchantIncomingOrders(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get merchant-incoming-orders error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load merchant orders.' });
  }
});

router.put('/incoming-order-status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.body?.orderId || req.body?.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Order id is required.' });
    }
    const row = await updateIncomingOrderStatus(phone, orderId, {
      statusKey: req.body?.statusKey,
      statusAr: req.body?.statusAr,
      statusEn: req.body?.statusEn,
      noteAr: req.body?.noteAr,
      noteEn: req.body?.noteEn,
      deliveryStatusKey: req.body?.deliveryStatusKey,
      deliveryStatusAr: req.body?.deliveryStatusAr,
      deliveryStatusEn: req.body?.deliveryStatusEn,
      lineItems: req.body?.lineItems,
      price: req.body?.price,
      itemsCount: req.body?.itemsCount,
      itemsNameAr: req.body?.itemsNameAr,
      itemsNameEn: req.body?.itemsNameEn,
      originalPrice: req.body?.originalPrice,
      itemsSubtotalIqd: req.body?.itemsSubtotalIqd,
      deliveryFeeIqd: req.body?.deliveryFeeIqd,
      promoDiscountIqd: req.body?.promoDiscountIqd,
      merchantDecisionAt: req.body?.merchantDecisionAt,
      isPriceLocked: req.body?.isPriceLocked,
    });
    return res.json(row);
  } catch (error) {
    console.error('update incoming-order-status error:', error);
    const status = String(error?.message || '').includes('not allowed') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to update order status.' });
  }
});

// ── Merchant private courier fleet ──────────────────────────────────────

router.get('/merchant-couriers', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listMerchantCouriers,
    } = require('../supabase_repo/merchant_couriers');
    const status = parseQueryValue(req.query?.status);
    const rows = await listMerchantCouriers(phone, { status: status || undefined });
    return res.json(rows);
  } catch (error) {
    console.error('list merchant-couriers error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to list merchant couriers.' });
  }
});

router.post('/merchant-couriers/invite', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      inviteCourierByMerchant,
    } = require('../supabase_repo/merchant_couriers');
    const row = await inviteCourierByMerchant(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('invite merchant-courier error:', error);
    return res.status(400).json({ message: error?.message || 'Failed to invite courier.' });
  }
});

router.put('/merchant-couriers/status', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const courierPhone = String(
      req.body?.courierPhone || req.body?.phone || '',
    ).trim();
    const status = String(req.body?.status || '').trim();
    if (!courierPhone || !status) {
      return res.status(400).json({ message: 'courierPhone and status are required.' });
    }
    const {
      setMerchantCourierStatus,
    } = require('../supabase_repo/merchant_couriers');
    const row = await setMerchantCourierStatus(phone, courierPhone, status);
    return res.json(row);
  } catch (error) {
    console.error('set merchant-courier status error:', error);
    return res.status(400).json({ message: error?.message || 'Failed to update courier link.' });
  }
});

module.exports = router;
