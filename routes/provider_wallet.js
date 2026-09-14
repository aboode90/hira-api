const express = require('express');
const router = express.Router();
const {
  getProviderWallet,
  createWalletTopupRequest,
} = require('../supabase_repo/provider_wallet');
const { requireOptionalAuthorizedPhone } = require('./_middleware');

router.get('/provider-wallet', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const providerType = String(
      req.query.providerType ?? req.query.provider_type ?? 'merchant',
    ).trim();
    const wallet = await getProviderWallet(phone, providerType);
    return res.json(wallet);
  } catch (error) {
    console.error('get provider-wallet error:', error);
    return res.status(400).json({
      message: error?.message || 'تعذر تحميل المحفظة.',
      code: error?.code || undefined,
    });
  }
});

router.post('/provider-wallet/topup', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const providerType = String(
      req.body?.providerType ?? req.body?.provider_type ?? 'merchant',
    ).trim();
    const request = await createWalletTopupRequest(phone, providerType, req.body || {});
    return res.json({ success: true, request });
  } catch (error) {
    console.error('provider-wallet topup error:', error);
    return res.status(400).json({
      message: error?.message || 'تعذر إرسال طلب الشحن.',
    });
  }
});

module.exports = router;
