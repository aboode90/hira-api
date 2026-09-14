const express = require('express');
const router = express.Router();
const {
  getDeliveryPoolOrders,
  getCourierAssignedOrders,
  acceptDeliveryOrder,
  rejectDeliveryOrder,
  updateCourierDeliveryStatus,
} = require('../supabase_repo');
const {
  assigneeCancelDeliveryOrder,
} = require('../supabase_repo/delivery_assignee_cancellations');
const {
  requireOptionalAuthorizedPhone,
} = require('./_middleware');

router.get('/delivery-pool', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getDeliveryPoolOrders(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get delivery-pool error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load delivery pool.' });
  }
});

router.get('/courier-orders', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const rows = await getCourierAssignedOrders(phone);
    return res.json(rows);
  } catch (error) {
    console.error('get courier-orders error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load courier orders.' });
  }
});

router.put('/delivery-order/accept', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.body?.orderId || req.body?.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Order id is required.' });
    }
    const row = await acceptDeliveryOrder(phone, orderId, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('accept delivery-order error:', error);
    const message = error?.message || 'Failed to accept delivery order.';
    const status =
      message.includes('not available') || message.includes('طلب توصيل نشط')
        ? 409
        : message.includes('not eligible')
          ? 403
          : 500;
    return res.status(status).json({ message });
  }
});

router.put('/delivery-order/reject', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.body?.orderId || req.body?.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Order id is required.' });
    }
    const row = await rejectDeliveryOrder(phone, orderId);
    return res.json(row);
  } catch (error) {
    console.error('reject delivery-order error:', error);
    const message = error?.message || 'Failed to reject delivery order.';
    const status = message.includes('not available')
      ? 409
      : message.includes('not eligible')
        ? 403
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/delivery-order/cancel', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.body?.orderId || req.body?.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Order id is required.' });
    }
    const reason = String(req.body?.reason || req.body?.cancelReason || '').trim();
    const result = await assigneeCancelDeliveryOrder(phone, orderId, reason);
    return res.json(result.order ?? result);
  } catch (error) {
    console.error('cancel delivery-order error:', error);
    const message = error?.message || 'Failed to cancel assigned delivery.';
    const status =
      error?.statusCode ||
      (message.includes('not assigned')
        ? 403
        : message.includes('Cannot cancel') || message.includes('سبب')
          ? 409
          : 500);
    return res.status(status).json({ message, code: error?.code || null });
  }
});

router.put('/delivery-order/status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.body?.orderId || req.body?.id || '').trim();
    if (!orderId) {
      return res.status(400).json({ message: 'Order id is required.' });
    }
    const row = await updateCourierDeliveryStatus(phone, orderId, {
      deliveryStatusKey: req.body?.deliveryStatusKey,
      deliveryStatusAr: req.body?.deliveryStatusAr,
      deliveryStatusEn: req.body?.deliveryStatusEn,
    });
    return res.json(row);
  } catch (error) {
    console.error('update delivery-order status error:', error);
    const message = error?.message || 'Failed to update delivery status.';
    const status = message.includes('not assigned') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// POST /db/rate-courier - تقييم الزبون للمندوب بعد التسليم
router.post('/rate-courier', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { rateCourier } = require('../supabase_repo');
    const courierPhone = String(req.body?.courierPhone || '').trim();
    const stars = req.body?.rating ?? req.body?.stars;
    const comment = req.body?.comment;
    if (!courierPhone) {
      return res.status(400).json({ message: 'Courier phone is required.' });
    }
    const result = await rateCourier(phone, courierPhone, stars, comment);
    return res.json(result);
  } catch (error) {
    console.error('rate-courier error:', error);
    const message = error?.message || 'Failed to rate courier.';
    const status = /must be between|is required/.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.post('/courier-location', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { saveCourierLiveLocation } = require('../supabase_repo/operator_profiles');
    const result = await saveCourierLiveLocation(phone, req.body?.lat ?? req.body?.latitude, req.body?.lng ?? req.body?.longitude);
    return res.json(result);
  } catch (error) {
    console.error('courier-location error:', error);
    const message = error?.message || 'Failed to save courier location.';
    const status = /required/i.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/courier/merchant-links', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      listCourierMerchantLinks,
    } = require('../supabase_repo/merchant_couriers');
    const rows = await listCourierMerchantLinks(phone);
    return res.json(rows);
  } catch (error) {
    console.error('list courier merchant-links error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to load merchant links.',
    });
  }
});

router.post('/courier/merchant-links/request', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const {
      requestMerchantLinkByCourier,
    } = require('../supabase_repo/merchant_couriers');
    const row = await requestMerchantLinkByCourier(phone, req.body || {});
    return res.json(row);
  } catch (error) {
    console.error('request courier merchant-link error:', error);
    return res.status(400).json({
      message: error?.message || 'Failed to request merchant link.',
    });
  }
});

module.exports = router;
