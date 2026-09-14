const express = require('express');
const router = express.Router();
const {
  createSalaryCashoutRequest,
  listCustomerSalaryCashoutRequests,
  listOutletPendingRequests,
  listOutletActiveRequests,
  outletDecideRequest,
  listCourierPoolRequests,
  listCourierAssignedRequests,
  courierAcceptRequest,
  courierUpdateRequestStatus,
  cancelCustomerRequest,
} = require('../supabase_repo/salary_cashout');
const { requireOptionalAuthorizedPhone } = require('./_middleware');

router.post('/requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await createSalaryCashoutRequest(phone, req.body || {});
    return res.json({ success: true, request });
  } catch (error) {
    console.error('salary cashout create error:', error);
    return res.status(400).json({ message: error.message || 'فشل إنشاء الطلب.' });
  }
});

router.get('/my-requests', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requests = await listCustomerSalaryCashoutRequests(phone);
    return res.json({ requests });
  } catch (error) {
    console.error('salary cashout my-requests error:', error);
    return res.status(500).json({ message: error.message || 'فشل التحميل.' });
  }
});

router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await cancelCustomerRequest(phone, req.params.id);
    return res.json({ success: true, request });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'فشل الإلغاء.' });
  }
});

router.get('/outlet/pending', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requests = await listOutletPendingRequests(phone);
    return res.json({ requests });
  } catch (error) {
    const status = String(error.message || '').includes('منفذ') ? 403 : 500;
    return res.status(status).json({ message: error.message || 'فشل التحميل.' });
  }
});

router.get('/outlet/active', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requests = await listOutletActiveRequests(phone);
    return res.json({ requests });
  } catch (error) {
    const status = String(error.message || '').includes('منفذ') ? 403 : 500;
    return res.status(status).json({ message: error.message || 'فشل التحميل.' });
  }
});

router.post('/outlet/requests/:id/accept', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await outletDecideRequest(phone, req.params.id, {
      accept: true,
      note: req.body?.note,
    });
    return res.json({ success: true, request });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'فشل القبول.' });
  }
});

router.post('/outlet/requests/:id/reject', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await outletDecideRequest(phone, req.params.id, {
      accept: false,
      note: req.body?.note,
    });
    return res.json({ success: true, request });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'فشل الرفض.' });
  }
});

router.get('/courier/pool', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requests = await listCourierPoolRequests(phone);
    return res.json({ requests });
  } catch (error) {
    const status = String(error.message || '').includes('مندوب') ? 403 : 500;
    return res.status(status).json({ message: error.message || 'فشل التحميل.' });
  }
});

router.get('/courier/assigned', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const requests = await listCourierAssignedRequests(phone);
    return res.json({ requests });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'فشل التحميل.' });
  }
});

router.post('/courier/requests/:id/accept', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await courierAcceptRequest(phone, req.params.id);
    return res.json({ success: true, request });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'فشل القبول.' });
  }
});

router.post('/courier/requests/:id/status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const request = await courierUpdateRequestStatus(
      phone,
      req.params.id,
      req.body?.statusKey ?? req.body?.status_key,
    );
    return res.json({ success: true, request });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'فشل التحديث.' });
  }
});

module.exports = router;
