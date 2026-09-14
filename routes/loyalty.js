const express = require('express');
const router = express.Router();
const loyalty = require('../services/loyalty/loyalty_service');
const { requireOptionalAuthorizedPhone } = require('./_middleware');

router.get('/loyalty/profile', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    return res.json(loyalty.getProfile(phone));
  } catch (error) {
    console.error('loyalty profile error:', error);
    return res.status(500).json({
      message: error?.message || 'تعذر تحميل ملف الولاء.',
    });
  }
});

router.get('/loyalty/coupons', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    return res.json(loyalty.listCustomerCoupons(phone));
  } catch (error) {
    console.error('loyalty coupons error:', error);
    return res.status(500).json({
      message: error?.message || 'تعذر تحميل الكوبونات.',
    });
  }
});

router.post('/loyalty/coupons/validate', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const code = String(req.body?.code || req.body?.promoCode || '').trim();
    const subtotalIqd = Number(req.body?.subtotalIqd ?? req.body?.subtotal ?? 0);
    const scope = String(req.body?.scope || 'marketplace').trim();
    const result = loyalty.validateCouponForCheckout(phone, code, subtotalIqd, scope);
    return res.json(result);
  } catch (error) {
    console.error('loyalty validate coupon error:', error);
    return res.status(500).json({
      valid: false,
      messageAr: error?.message || 'تعذر التحقق من الكوبون.',
    });
  }
});

/** تطوير محلي — إسناد كوبون لمستخدم (يُستبدل بلوحة إدارة لاحقاً). */
router.post('/loyalty/dev/assign-coupon', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const row = loyalty.adminAssignCoupon(phone, req.body || {});
    return res.json({ success: true, coupon: row });
  } catch (error) {
    console.error('loyalty assign coupon error:', error);
    return res.status(400).json({
      message: error?.message || 'تعذر إسناد الكوبون.',
    });
  }
});

module.exports = router;
