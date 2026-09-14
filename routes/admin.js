const express = require('express');
const router = express.Router();

// ممر أولوية الإدارة: أي طلب /db/admin/* يفعّل تنازل مسارات التطبيق الساخنة مؤقتاً.
router.use((req, res, next) => {
  try {
    const { beginAdminPriority } = require('../lib/db_circuit');
    beginAdminPriority();
  } catch (_) {}
  next();
});

function deferAdminPollIfCircuit(res, payload) {
  try {
    const { isDbCircuitOpen } = require('../lib/db_circuit');
    if (!isDbCircuitOpen()) return false;
    res.json(payload);
    return true;
  } catch (_) {
    return false;
  }
}

function isBusyAdminError(error) {
  return /aborted|AbortError|timeout|مهلة|مشغول|ETIMEDOUT|ECONNRESET/i.test(
    String(error?.message || error || ''),
  );
}

const {
  getAdminReports,
  getAllMerchants,
  getAllProfessionals,
  getAllCouriers,
  getAllDrivers,
  getAdminMerchantDetails,
  getAdminProfessionalDetails,
  toggleMerchantApprovalStatus,
  rejectMerchantApplication,
  toggleMerchantFreezeStatus,
  toggleCourierApprovalStatus,
  rejectCourierApplication,
  toggleDriverApprovalStatus,
  rejectDriverApplication,
  getAllAdminAccounts,
  adminDeleteAccount,
  adminSuspendAccount,
  updateAccountRole,
  getAppUpdatePolicy,
  saveAdminAppUpdatePolicy,
  getMaintenancePolicy,
  saveAdminMaintenancePolicy,
  getPendingProductsForAdmin,
  updateProductPlacement,
  updatePendingProductPlacement,
  getModerationPendingSummary,
  toggleProductApprovalStatus,
  mapAdminProductRow,
  getHomeCategoriesConfig,
  saveAdminHomeCategoriesConfig,
  getProfessionalCategoriesConfig,
  saveAdminProfessionalCategoriesConfig,
  getUserState,
  saveUserState,
  deleteUserState,
  preRegisterMerchantAccount,
  updateMerchantCategoryByAdmin,
  updateProfessionalCategoryByAdmin,
  updateMerchantProfileByAdmin,
  preRegisterCustomerAccount,
  preRegisterDriverAccount,
  preRegisterCourierAccount,
  preRegisterProfessionalAccount,
  preRegisterBeautyAccount,
  broadcastAdminUserMessage,
  getSupportThreadsForAdmin,
} = require('../supabase_repo');
const logger = require('../lib/logger');
const {
  requireAuthorizedPhone,
  requireOptionalAuthorizedPhone,
  requireAdminAccess,
  parseQueryValue,
} = require('./_middleware');

const { assertAdminPermission } = require('../supabase_repo');
const { getAdminRole, hasMinRole } = require('../supabase_repo/admin_roles');
const { recordAdminAudit, listAdminAuditLogs } = require('../lib/admin_audit');

async function auditAdminAction(actorPhone, payload) {
  await recordAdminAudit({ actorPhone, ...payload });
}

async function requireMinAdminRole(req, res, adminPhone, minRole) {
  const role = await getAdminRole(adminPhone);
  if (!role) {
    res.status(403).json({ message: 'Admin access required.' });
    return null;
  }
  if (!hasMinRole(role, minRole)) {
    res.status(403).json({ message: `Requires ${minRole} role or higher.` });
    return null;
  }
  return role;
}

// ── Reports ─────────────────────────────────────────────────────────────

router.get('/admin/reports', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { getAdminReportsLite } = require('../supabase_repo/admin');
    const mode = String(req.query.mode || '').trim().toLowerCase();
    // الافتراضي full للاكتمال. lite فقط عند طلب صريح أو تحت ضغط الدائرة (داخل getAdminReports).
    const wantLite = mode === 'lite';
    const reports = wantLite
      ? await getAdminReportsLite(phone)
      : await getAdminReports(phone);
    return res.json(reports);
  } catch (error) {
    console.error('admin reports error:', error);
    try {
      const phone = req.authPhone || req.body?.phone || '';
      if (phone) {
        const { getAdminReportsLite } = require('../supabase_repo/admin');
        const lite = await getAdminReportsLite(phone);
        return res.json(lite);
      }
    } catch (_) {}
    let message = error?.message || 'Failed to load admin reports.';
    if (/aborted|AbortError|timeout|مشغول/i.test(String(message))) {
      message = 'الخادم مشغول أو بطيء حالياً. حدّث الصفحة وحاول مرة أخرى.';
    }
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Merchants ───────────────────────────────────────────────────────────

router.get('/admin/merchants', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const merchants = await getAllMerchants(phone);
    return res.json(merchants);
  } catch (error) {
    console.error('admin merchants error:', error);
    const message = error?.message || 'Failed to load merchants.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/professionals', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const professionals = await getAllProfessionals(phone);
    return res.json(professionals);
  } catch (error) {
    console.error('admin professionals error:', error);
    const message = error?.message || 'Failed to load professionals.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/professional-details', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const professionalPhone = String(parseQueryValue(req.query.professionalPhone) || '').trim();
    if (!professionalPhone) {
      return res.status(400).json({ message: 'professionalPhone is required.' });
    }
    const professionId = String(
      parseQueryValue(req.query.professionId) ||
        parseQueryValue(req.query.professionalCategoryId) ||
        '',
    ).trim();
    const details = await getAdminProfessionalDetails(phone, professionalPhone, {
      professionId,
    });
    return res.json(details);
  } catch (error) {
    console.error('admin professional-details error:', error);
    const message = error?.message || 'Failed to load professional details.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('required')
        ? 400
        : message.includes('not found')
          ? 404
          : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/couriers', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const couriers = await getAllCouriers(phone);
    return res.json(couriers);
  } catch (error) {
    console.error('admin couriers error:', error);
    const message = error?.message || 'Failed to load couriers.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/drivers', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const drivers = await getAllDrivers(phone);
    return res.json(drivers);
  } catch (error) {
    console.error('admin drivers error:', error);
    const message = error?.message || 'Failed to load drivers.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/taxi/trips', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    if (
      deferAdminPollIfCircuit(res, {
        items: [],
        total: 0,
        page: Number(req.query.page ?? 1) || 1,
        limit: Number(req.query.limit ?? 100) || 100,
        stats: { pending: 0, active: 0, completed: 0, cancelled: 0, completedFareTotal: 0 },
        deferred: true,
      })
    ) {
      return;
    }
    const adminOps = require('../supabase_repo/admin_ops');
    const trips = await adminOps.getAdminTaxiTripsFiltered(phone, {
      status: parseQueryValue(req.query.status),
      phone: parseQueryValue(req.query.phone),
      requestId: parseQueryValue(req.query.requestId),
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 100),
    });
    return res.json(trips);
  } catch (error) {
    console.error('admin taxi trips error:', error);
    if (isBusyAdminError(error)) {
      return res.json({
        items: [],
        total: 0,
        page: 1,
        limit: 25,
        stats: {},
        deferred: true,
      });
    }
    const message = error?.message || 'Failed to load taxi trips.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/taxi/captain-leaderboard', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const adminOps = require('../supabase_repo/admin_ops');
    const leaderboard = await adminOps.getAdminTaxiCaptainLeaderboard(phone, {
      period: String(req.query.period ?? '').trim(),
      days: Number(req.query.days ?? 30),
      limit: Number(req.query.limit ?? 30),
    });
    return res.json(leaderboard);
  } catch (error) {
    console.error('admin taxi captain leaderboard error:', error);
    const message = error?.message || 'Failed to load captain leaderboard.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/taxi/ratings', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const adminOps = require('../supabase_repo/admin_ops');
    const ratings = await adminOps.getAdminTaxiRatings(phone, {
      days: Number(req.query.days ?? 90),
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 25),
      minRating: parseQueryValue(req.query.minRating),
      maxRating: parseQueryValue(req.query.maxRating),
      phone: parseQueryValue(req.query.phone),
      needsReview: parseQueryValue(req.query.needsReview),
    });
    return res.json(ratings);
  } catch (error) {
    console.error('admin taxi ratings error:', error);
    const message = error?.message || 'Failed to load taxi ratings.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/taxi/complaints', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const taxiRepo = require('../supabase_repo/taxi');
    const complaints = await taxiRepo.getAdminTaxiComplaints(phone, {
      limit: Number(req.query.limit ?? 100),
    });
    return res.json(complaints);
  } catch (error) {
    console.error('admin taxi complaints error:', error);
    const message = error?.message || 'Failed to load taxi complaints.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.delete('/admin/driver', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    await assertAdminPermission(adminPhone, 'canDelete');
    const driverPhone = String(parseQueryValue(req.query.driverPhone) || '').trim();
    if (!driverPhone) {
      return res.status(400).json({ message: 'Driver phone is required.' });
    }
    const { deleteDriverAccount } = require('../supabase_repo');
    const result = await deleteDriverAccount(adminPhone, driverPhone);
    return res.json(result);
  } catch (error) {
    console.error('admin delete-driver error:', error);
    const message = error?.message || 'Failed to delete driver account.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/merchant-details', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const merchantPhone = String(parseQueryValue(req.query.merchantPhone) || '').trim();
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    const details = await getAdminMerchantDetails(phone, merchantPhone);
    return res.json(details);
  } catch (error) {
    console.error('admin merchant-details error:', error);
    const message = error?.message || 'Failed to load merchant details.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('required')
        ? 400
        : message.includes('not found')
          ? 404
          : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/merchant-profile', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    await assertAdminPermission(adminPhone, 'canApprove');
    const merchantPhone = String(req.body?.merchantPhone ?? req.body?.phone ?? '').trim();
    if (!merchantPhone) {
      return res.status(400).json({ message: 'رقم التاجر مطلوب.' });
    }
    const result = await updateMerchantProfileByAdmin(adminPhone, merchantPhone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('admin merchant-profile update error:', error);
    const message = error?.message || 'Failed to update merchant profile.';
    const status = message.includes('Admin access') ? 403 : 400;
    return res.status(status).json({ message });
  }
});

router.put('/admin/merchant-approval', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canApprove');
    const merchantPhone = String(req.body?.merchantPhone || '').trim();
    const isApproved = req.body?.isApproved === true;
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    const professionId = String(
      req.body?.professionId ??
        req.body?.professionalCategoryId ??
        req.body?.professional_category_id ??
        '',
    ).trim();
    const result = await toggleMerchantApprovalStatus(phone, merchantPhone, isApproved, {
      professionId,
    });
    await auditAdminAction(phone, {
      action: isApproved ? 'account.approve' : 'account.unapprove',
      entityType: 'merchant',
      entityId: merchantPhone,
      summaryAr: isApproved ? `الموافقة على تاجر ${merchantPhone}` : `سحب موافقة تاجر ${merchantPhone}`,
    });
    return res.json(result);
  } catch (error) {
    console.error('toggle merchant approval error:', error);
    const message = error?.message || 'Failed to toggle merchant approval.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found')
        ? 404
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/merchant-rejection', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canApprove');
    const merchantPhone = String(req.body?.merchantPhone || '').trim();
    const reasonKey = String(req.body?.reasonKey || '').trim();
    const rejectionMessageAr = String(
      req.body?.rejectionMessageAr || req.body?.message || ''
    ).trim();
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    if (!reasonKey && !rejectionMessageAr) {
      return res.status(400).json({ message: 'Rejection reason is required.' });
    }
    const result = await rejectMerchantApplication(
      phone,
      merchantPhone,
      reasonKey,
      rejectionMessageAr
    );
    await auditAdminAction(phone, {
      action: 'account.reject',
      entityType: 'merchant',
      entityId: merchantPhone,
      summaryAr: `رفض طلب تاجر ${merchantPhone}`,
      details: { reasonKey },
    });
    return res.json(result);
  } catch (error) {
    console.error('reject merchant error:', error);
    const message = error?.message || 'Failed to reject merchant application.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found') || message.includes('Invalid')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/merchant-bazaar', async (_req, res) => {
  return res.status(410).json({
    message: 'هذه الميزة لم تعد متاحة.',
    code: 'FEATURE_REMOVED',
  });
});

router.post('/admin/merchant-bazaar-sync', async (_req, res) => {
  return res.status(410).json({
    message: 'هذه الميزة لم تعد متاحة.',
    code: 'FEATURE_REMOVED',
  });
});

router.put('/admin/merchant-freeze', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const merchantPhone = String(req.body?.merchantPhone || '').trim();
    const isFrozen = req.body?.isFrozen === true;
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    const result = await toggleMerchantFreezeStatus(phone, merchantPhone, isFrozen);
    return res.json(result);
  } catch (error) {
    console.error('toggle freeze error:', error);
    const message = error?.message || 'Failed to toggle freeze status.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

const { getMerchantProducts, saveMerchantProduct, deleteMerchantProduct } = require('../supabase_repo/merchants');

router.get('/admin/moderation-pending-summary', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const { isDbCircuitOpen } = require('../lib/db_circuit');
    const { getCached } = require('../lib/response_cache');
    if (isDbCircuitOpen()) {
      const cached = await getCached('admin:moderation-pending-summary');
      if (cached?.value) {
        return res.json({ ...cached.value, cacheHit: true, degraded: true });
      }
      return res.json({
        total: 0,
        counts: {},
        signature: '',
        items: [],
        deferred: true,
        degraded: true,
        checkedAt: new Date().toISOString(),
      });
    }
    const summary = await getModerationPendingSummary(adminPhone);
    return res.json(summary);
  } catch (error) {
    console.error('admin moderation-pending-summary error:', error);
    if (/aborted|AbortError|timeout|مشغول/i.test(String(error?.message || ''))) {
      return res.json({
        total: 0,
        counts: {},
        signature: '',
        items: [],
        deferred: true,
        degraded: true,
        checkedAt: new Date().toISOString(),
      });
    }
    const message = error?.message || 'Failed to load moderation summary.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/pending-products', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const category = String(req.query?.category ?? '').trim();
    const rows = await getPendingProductsForAdmin(adminPhone, { category });
    return res.json(rows);
  } catch (error) {
    console.error('admin pending-products error:', error);
    const message = error?.message || 'Failed to load pending products.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/product-approval', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const merchantPhone = String(req.body?.merchantPhone ?? '').trim();
    const productId = String(req.body?.productId ?? req.body?.id ?? '').trim();
    const rawApproved = req.body?.isApproved ?? req.body?.is_approved;
    const isApproved =
      rawApproved === true || rawApproved === 'true' || rawApproved === 1 || rawApproved === '1';
    const rejectionMessageAr = String(
      req.body?.rejectionMessageAr ?? req.body?.rejection_message_ar ?? ''
    ).trim();
    if (!merchantPhone || !productId) {
      return res.status(400).json({ message: 'merchantPhone and productId are required.' });
    }
    const placement = {
      category: req.body?.category,
      subCategory: req.body?.subCategory ?? req.body?.sub_category,
      sectionId: req.body?.sectionId ?? req.body?.section_id,
      listingMode: req.body?.listingMode ?? req.body?.listing_mode,
    };
    const result = await toggleProductApprovalStatus(
      adminPhone,
      merchantPhone,
      productId,
      isApproved,
      rejectionMessageAr,
      placement,
    );
    await auditAdminAction(adminPhone, {
      action: isApproved ? 'product.approve' : 'product.reject',
      entityType: 'product',
      entityId: productId,
      summaryAr: isApproved ? `الموافقة على منتج ${productId}` : `رفض منتج ${productId}`,
      details: { merchantPhone },
    });
    return res.json(result);
  } catch (error) {
    console.error('admin product-approval error:', error);
    const message = error?.message || 'Failed to update product approval.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found')
        ? 404
        : message.includes('does not belong') || message.includes('required')
          ? 400
          : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/product-placement', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const merchantPhone = String(req.body?.merchantPhone ?? '').trim();
    const productId = String(req.body?.productId ?? req.body?.id ?? '').trim();
    if (!merchantPhone || !productId) {
      return res.status(400).json({ message: 'merchantPhone and productId are required.' });
    }
    const product = await updateProductPlacement(
      adminPhone,
      merchantPhone,
      productId,
      {
        category: req.body?.category,
        subCategory: req.body?.subCategory ?? req.body?.sub_category,
        sectionId: req.body?.sectionId ?? req.body?.section_id,
        listingMode: req.body?.listingMode ?? req.body?.listing_mode,
      },
    );
    return res.json({ success: true, product });
  } catch (error) {
    console.error('admin product-placement error:', error);
    const message = error?.message || 'Failed to update product placement.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found')
        ? 404
        : message.includes('does not belong') ||
            message.includes('required') ||
            message.includes('No placement')
          ? 400
          : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/merchant-products', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    
    const merchantPhone = String(req.query?.merchantPhone ?? '').trim();
    if (!merchantPhone) return res.status(400).json({ message: 'merchantPhone is required' });
    
    const rows = await getMerchantProducts(merchantPhone);
    return res.json(rows.map(mapAdminProductRow));
  } catch (error) {
    console.error('admin get merchant products error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to get products' });
  }
});

router.put('/admin/merchant-product', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    
    const merchantPhone = String(req.body?.merchantPhone ?? '').trim();
    if (!merchantPhone) return res.status(400).json({ message: 'merchantPhone is required' });
    
    const row = await saveMerchantProduct(merchantPhone, req.body || {}, { adminSave: true });
    return res.json(row);
  } catch (error) {
    console.error('admin save merchant product error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save product' });
  }
});

router.delete('/admin/merchant-product', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    
    const merchantPhone = String(req.query?.merchantPhone ?? '').trim();
    const id = String(req.query?.id ?? '').trim();
    if (!merchantPhone || !id) return res.status(400).json({ message: 'merchantPhone and id are required' });
    
    await deleteMerchantProduct(id, merchantPhone);
    return res.json({ success: true });
  } catch (error) {
    console.error('admin delete merchant product error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete product' });
  }
});

router.post('/admin/customer-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await preRegisterCustomerAccount(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('customer pre-register error:', error);
    const message = error?.message || 'Failed to pre-register customer.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('بالفعل') || message.includes('لا يمكن') || message.includes('مطلوب')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.post('/admin/merchant-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await preRegisterMerchantAccount(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('merchant pre-register error:', error);
    const message = error?.message || 'Failed to pre-register merchant.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('بالفعل') ||
          message.includes('لا يمكن') ||
          message.includes('مطلوب') ||
          message.includes('غير صالح')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/merchant-category', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await updateMerchantCategoryByAdmin(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('merchant category update error:', error);
    const message = error?.message || 'Failed to update merchant category.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('غير موجود') ||
          message.includes('مطلوب') ||
          message.includes('غير صالح')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/professional-category', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await updateProfessionalCategoryByAdmin(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('professional category update error:', error);
    const message = error?.message || 'Failed to update professional category.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('غير موجود') ||
          message.includes('ليس مهنياً') ||
          message.includes('مطلوب') ||
          message.includes('غير صالح')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.post('/admin/driver-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await preRegisterDriverAccount(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('driver pre-register error:', error);
    const message = error?.message || 'Failed to pre-register driver.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('بالفعل') ||
          message.includes('لا يمكن') ||
          message.includes('مطلوب') ||
          message.includes('غير صالح')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.post('/admin/professional-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await preRegisterProfessionalAccount(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('professional pre-register error:', error);
    const message = error?.message || 'Failed to pre-register professional.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('بالفعل') ||
          message.includes('لا يمكن') ||
          message.includes('مطلوب') ||
          message.includes('غير صالح') ||
          message.includes('تخصص')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.post('/admin/beauty-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await preRegisterBeautyAccount(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('beauty pre-register error:', error);
    const message = error?.message || 'Failed to pre-register.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('بالفعل') || message.includes('لا يمكن') || message.includes('مطلوب') || message.includes('تصنيف')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.post('/admin/doctor-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const body = {
      ...(req.body || {}),
      subCategoryId: 'أطباء وعيادات',
      subscriberPhone: req.body?.subscriberPhone ?? req.body?.phone,
    };
    const result = await preRegisterBeautyAccount(phone, body);
    return res.json(result);
  } catch (error) {
    console.error('doctor pre-register error:', error);
    const message = error?.message || 'Failed to pre-register doctor.';
    const status = message.includes('Admin access') ? 403 : 400;
    return res.status(status).json({ message });
  }
});

router.post('/admin/pharmacy-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const body = {
      ...(req.body || {}),
      subCategoryId: 'صيدلية',
      subscriberPhone: req.body?.subscriberPhone ?? req.body?.phone,
    };
    const result = await preRegisterBeautyAccount(phone, body);
    return res.json(result);
  } catch (error) {
    console.error('pharmacy pre-register error:', error);
    const message = error?.message || 'Failed to pre-register pharmacy.';
    const status = message.includes('Admin access') ? 403 : 400;
    return res.status(status).json({ message });
  }
});

router.post('/admin/lab-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const body = {
      ...(req.body || {}),
      subCategoryId: 'مختبرات طبية',
      subscriberPhone: req.body?.subscriberPhone ?? req.body?.phone,
    };
    const result = await preRegisterBeautyAccount(phone, body);
    return res.json(result);
  } catch (error) {
    console.error('lab pre-register error:', error);
    const message = error?.message || 'Failed to pre-register medical lab.';
    const status = message.includes('Admin access') ? 403 : 400;
    return res.status(status).json({ message });
  }
});

router.post('/admin/courier-pre-register', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canRegister');
    const result = await preRegisterCourierAccount(phone, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('courier pre-register error:', error);
    const message = error?.message || 'Failed to pre-register courier.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('بالفعل') ||
          message.includes('لا يمكن') ||
          message.includes('مطلوب')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

// ── Couriers/Drivers Approvals ──────────────────────────────────────────

router.put('/admin/courier-approval', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canApprove');
    const courierPhone = String(req.body?.courierPhone || '').trim();
    const isApproved = req.body?.isApproved === true;
    if (!courierPhone) {
      return res.status(400).json({ message: 'courierPhone is required.' });
    }
    const result = await toggleCourierApprovalStatus(phone, courierPhone, isApproved);
    await auditAdminAction(phone, {
      action: isApproved ? 'account.approve' : 'account.unapprove',
      entityType: 'courier',
      entityId: courierPhone,
      summaryAr: isApproved ? `الموافقة على مندوب ${courierPhone}` : `سحب موافقة مندوب ${courierPhone}`,
    });
    return res.json(result);
  } catch (error) {
    console.error('toggle courier approval error:', error);
    const message = error?.message || 'Failed to toggle courier approval.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found')
        ? 404
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/courier-rejection', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canApprove');
    const courierPhone = String(req.body?.courierPhone || '').trim();
    const reasonKey = String(req.body?.reasonKey || '').trim();
    const rejectionMessageAr = String(
      req.body?.rejectionMessageAr || req.body?.message || ''
    ).trim();
    if (!courierPhone) {
      return res.status(400).json({ message: 'courierPhone is required.' });
    }
    if (!reasonKey && !rejectionMessageAr) {
      return res.status(400).json({ message: 'Rejection reason is required.' });
    }
    const result = await rejectCourierApplication(
      phone,
      courierPhone,
      reasonKey,
      rejectionMessageAr
    );
    await auditAdminAction(phone, {
      action: 'account.reject',
      entityType: 'courier',
      entityId: courierPhone,
      summaryAr: `رفض طلب مندوب ${courierPhone}`,
      details: { reasonKey },
    });
    return res.json(result);
  } catch (error) {
    console.error('reject courier error:', error);
    const message = error?.message || 'Failed to reject courier application.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found') || message.includes('Invalid')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/driver-approval', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canApprove');
    const driverPhone = String(req.body?.driverPhone || '').trim();
    const isApproved = req.body?.isApproved === true;
    if (!driverPhone) {
      return res.status(400).json({ message: 'driverPhone is required.' });
    }
    const result = await toggleDriverApprovalStatus(phone, driverPhone, isApproved);
    await auditAdminAction(phone, {
      action: isApproved ? 'account.approve' : 'account.unapprove',
      entityType: 'driver',
      entityId: driverPhone,
      summaryAr: isApproved ? `الموافقة على سائق ${driverPhone}` : `سحب موافقة سائق ${driverPhone}`,
    });
    return res.json(result);
  } catch (error) {
    console.error('toggle driver approval error:', error);
    const message = error?.message || 'Failed to toggle driver approval.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found')
        ? 404
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/driver-rejection', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canApprove');
    const driverPhone = String(req.body?.driverPhone || '').trim();
    const reasonKey = String(req.body?.reasonKey || '').trim();
    const rejectionMessageAr = String(
      req.body?.rejectionMessageAr || req.body?.message || ''
    ).trim();
    if (!driverPhone) {
      return res.status(400).json({ message: 'driverPhone is required.' });
    }
    if (!reasonKey && !rejectionMessageAr) {
      return res.status(400).json({ message: 'Rejection reason is required.' });
    }
    const result = await rejectDriverApplication(
      phone,
      driverPhone,
      reasonKey,
      rejectionMessageAr
    );
    await auditAdminAction(phone, {
      action: 'account.reject',
      entityType: 'driver',
      entityId: driverPhone,
      summaryAr: `رفض طلب سائق ${driverPhone}`,
      details: { reasonKey },
    });
    return res.json(result);
  } catch (error) {
    console.error('reject driver error:', error);
    const message = error?.message || 'Failed to reject driver application.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found') || message.includes('required')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

// ── Accounts ────────────────────────────────────────────────────────────

router.get('/admin/accounts', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const pageRaw = parseQueryValue(req.query.page);
    const limitRaw = parseQueryValue(req.query.limit);
    const q = String(parseQueryValue(req.query.q) || '').trim();
    const kind = String(parseQueryValue(req.query.kind) || 'all').trim();
    const hasPage = pageRaw !== '' && pageRaw != null;
    const hasLimit = limitRaw !== '' && limitRaw != null;
    const accounts = await getAllAdminAccounts(phone, {
      q,
      kind,
      page: hasPage ? Number(pageRaw) : undefined,
      limit: hasLimit ? Number(limitRaw) : undefined,
      paginated: hasPage || hasLimit,
    });
    return res.json(accounts);
  } catch (error) {
    console.error('admin accounts error:', error);
    const message = error?.message || 'Failed to load accounts.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.delete('/admin/account', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canDelete');
    const accountPhone = String(
      req.body?.accountPhone || req.query?.accountPhone || ''
    ).trim();
    if (!accountPhone) {
      return res.status(400).json({ message: 'accountPhone is required.' });
    }
    const result = await adminDeleteAccount(phone, accountPhone);
    return res.json(result);
  } catch (error) {
    console.error('admin account delete error:', error);
    const message = error?.message || 'Failed to delete account.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found') || message.includes('Cannot')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/account-suspend', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    await assertAdminPermission(phone, 'canSuspend');
    const accountPhone = String(req.body?.accountPhone || '').trim();
    const isSuspended = req.body?.isSuspended === true;
    if (!accountPhone) {
      return res.status(400).json({ message: 'accountPhone is required.' });
    }
    const result = await adminSuspendAccount(phone, accountPhone, isSuspended);
    return res.json(result);
  } catch (error) {
    console.error('admin account suspend error:', error);
    const message = error?.message || 'Failed to update account suspension.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found') || message.includes('Cannot')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/account-role', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const accountPhone = String(req.body?.accountPhone || '').trim();
    const newRole = String(req.body?.role || '').trim();
    if (!accountPhone) {
      return res.status(400).json({ message: 'accountPhone is required.' });
    }
    if (!newRole) {
      return res.status(400).json({ message: 'role is required.' });
    }
    const result = await updateAccountRole(phone, accountPhone, newRole);
    return res.json(result);
  } catch (error) {
    console.error('admin account-role error:', error);
    const message = error?.message || 'Failed to update account role.';
    const status = message.includes('Admin access')
      ? 403
      : message.includes('not found') || message.includes('required')
        ? 400
        : 500;
    return res.status(status).json({ message });
  }
});

// ── App Update Policy (admin) ───────────────────────────────────────────

router.get('/admin/app-update-policy', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const policy = await getAppUpdatePolicy();
    return res.json(policy);
  } catch (error) {
    console.error('admin app update policy read error:', error);
    const message = error?.message || 'Failed to load app update policy.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/app-update-policy', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const policy = await saveAdminAppUpdatePolicy(phone, {
      minBuildNumber: req.body?.minBuildNumber ?? req.body?.min_build_number,
      minVersionName: req.body?.minVersionName ?? req.body?.min_version_name,
      forceUpdateEnabled:
        req.body?.forceUpdateEnabled ?? req.body?.force_update_enabled,
      publishedLatestBuildNumber:
        req.body?.publishedLatestBuildNumber ?? req.body?.published_latest_build_number,
      publishedLatestVersionName:
        req.body?.publishedLatestVersionName ?? req.body?.published_latest_version_name,
      messageAr: req.body?.messageAr ?? req.body?.message_ar,
      optionalUpdateMessageAr:
        req.body?.optionalUpdateMessageAr ?? req.body?.optional_update_message_ar,
      androidStoreUrl: req.body?.androidStoreUrl ?? req.body?.android_store_url,
      iosStoreUrl: req.body?.iosStoreUrl ?? req.body?.ios_store_url,
    });
    return res.json({ success: true, policy });
  } catch (error) {
    console.error('admin app update policy save error:', error);
    const message = error?.message || 'Failed to save app update policy.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/app-update-policy/store-live', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    const { getLiveStoreVersionsForAdmin } = require('../supabase_repo/admin');
    const store = await getLiveStoreVersionsForAdmin();
    return res.json(store);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load live store versions.');
  }
});

router.post('/admin/app-update-policy/publish-from-store', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { publishAppUpdateFromStore } = require('../supabase_repo/admin');
    const result = await publishAppUpdateFromStore(phone, req.body || {});
    return res.json({ success: true, ...result });
  } catch (error) {
    return adminOpsError(res, error, 'Failed to publish store version.');
  }
});

// ── Maintenance mode (admin) ────────────────────────────────────────────

router.get('/admin/maintenance', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const policy = await getMaintenancePolicy();
    return res.json(policy);
  } catch (error) {
    console.error('admin maintenance read error:', error);
    const message = error?.message || 'Failed to load maintenance policy.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/maintenance', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await saveAdminMaintenancePolicy(phone, {
      enabled: req.body?.enabled,
      targetPlatform: req.body?.targetPlatform ?? req.body?.target_platform,
      messageAr: req.body?.messageAr ?? req.body?.message_ar,
      messageEn: req.body?.messageEn ?? req.body?.message_en,
      allowAdminBypass:
        req.body?.allowAdminBypass ?? req.body?.allow_admin_bypass,
    });
    const { notification, enabledChanged, ...policy } = result;
    return res.json({
      success: true,
      policy,
      enabledChanged: Boolean(enabledChanged),
      notification: notification || null,
    });
  } catch (error) {
    console.error('admin maintenance save error:', error);
    const message = error?.message || 'Failed to save maintenance policy.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Home Categories (admin) ─────────────────────────────────────────────

router.get('/admin/home-categories', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const config = await getHomeCategoriesConfig();
    return res.json(config);
  } catch (error) {
    console.error('admin home categories read error:', error);
    const message = error?.message || 'Failed to load home categories.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/home-categories', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const overrides = req.body?.overrides;
    if (!overrides || typeof overrides !== 'object') {
      return res.status(400).json({ message: 'overrides object is required.' });
    }
    const result = await saveAdminHomeCategoriesConfig(phone, overrides);
    return res.json(result);
  } catch (error) {
    console.error('save home categories error:', error);
    const message = error?.message || 'Failed to save home categories.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Professional Categories (admin) ─────────────────────────────────────

router.get('/admin/professional-categories', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const config = await getProfessionalCategoriesConfig();
    return res.json(config);
  } catch (error) {
    console.error('admin professional categories read error:', error);
    const message = error?.message || 'Failed to load professional categories.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/professional-categories', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const items = req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: 'items array is required.' });
    }
    const result = await saveAdminProfessionalCategoriesConfig(phone, items);
    return res.json(result);
  } catch (error) {
    console.error('save professional categories error:', error);
    const message = error?.message || 'Failed to save professional categories.';
    const status = message.includes('Admin access') ? 403 : 400;
    return res.status(status).json({ message });
  }
});

// ── Admin Roles ─────────────────────────────────────────────────────────

router.get('/admin/roles', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;

    const { getAdminRole, getAdminRoleWithPermissions } = require('../supabase_repo');

    // مسار سريع: أرقام المنصة/ADMIN_PHONES بدون انتظار استعلامات ثقيلة.
    let role = null;
    try {
      role = await getAdminRole(phone);
    } catch (roleError) {
      logger.error('admin roles fast lookup error', {
        error: roleError?.message || roleError,
      });
    }

    if (!role) {
      return res.status(403).json({
        message: 'هذا الرقم غير مخوّل لدخول لوحة الإدارة.',
      });
    }

    let permissions = null;
    try {
      const roleData = await getAdminRoleWithPermissions(phone);
      permissions = roleData?.permissions ?? null;
      if (roleData?.role) role = roleData.role;
    } catch (_) {
      // الدور كافٍ لفتح اللوحة
    }

    // لا نؤخر فتح اللوحة بانتظار قائمة الحسابات (قد تعلق على DB بطيء).
    let accounts = [];
    const { isDbCircuitOpen } = require('../lib/db_circuit');
    if (!isDbCircuitOpen()) {
      try {
        const { listAdminAccounts } = require('../supabase_repo');
        accounts = await Promise.race([
          listAdminAccounts(phone),
          new Promise((resolve) => setTimeout(() => resolve([]), 2500)),
        ]);
        if (!Array.isArray(accounts)) accounts = [];
      } catch (listError) {
        logger.warn('admin roles accounts list skipped', {
          error: listError?.message || listError,
        });
        accounts = [];
      }
    }

    return res.json({
      role,
      permissions,
      accounts,
    });
  } catch (error) {
    const message = error?.message || 'Failed to load admin role.';
    logger.error('admin roles list error', { error: message });
    const status = String(message).includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/roles', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const targetPhone = String(req.body?.targetPhone || '').trim();
    const newRole = String(req.body?.role || '').trim();
    if (!targetPhone) {
      return res.status(400).json({ message: 'targetPhone is required.' });
    }
    const { setAdminRole } = require('../supabase_repo');
    const result = await setAdminRole(phone, targetPhone, newRole || null);
    return res.json(result);
  } catch (error) {
    logger.error('admin roles set error', { error: error.message });
    const status = error.message.includes('Admin access') || error.message.includes('Only super admins')
      ? 403
      : error.message.includes('Invalid role')
        ? 400
        : 500;
    return res.status(status).json({ message: error.message });
  }
});

// ── Admin Permissions ────────────────────────────────────────────────────

router.get('/admin/admins', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { listAllAdmins, getAdminPermissions } = require('../supabase_repo');
    const [admins, myPermissions] = await Promise.all([
      listAllAdmins(phone),
      getAdminPermissions(phone),
    ]);
    return res.json({ admins, myPermissions });
  } catch (error) {
    logger.error('admin list admins error', { error: error.message });
    const status = error.message.includes('Super admin') ? 403 : 500;
    return res.status(status).json({ message: error.message });
  }
});

router.post('/admin/admin-invite', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const targetPhone = String(req.body?.targetPhone || '').trim();
    const permissions = req.body?.permissions || {};
    if (!targetPhone) {
      return res.status(400).json({ message: 'رقم الهاتف مطلوب.' });
    }
    const { setAdminPermissions } = require('../supabase_repo');
    const role = String(req.body?.role || 'moderator').trim();
    const result = await setAdminPermissions(phone, targetPhone, permissions, role);
    return res.json(result);
  } catch (error) {
    logger.error('admin invite error', { error: error.message });
    const status = error.message.includes('Super admin') ? 403 : 500;
    return res.status(status).json({ message: error.message });
  }
});

router.put('/admin/admin-permissions', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const targetPhone = String(req.body?.targetPhone || '').trim();
    const permissions = req.body?.permissions || {};
    if (!targetPhone) {
      return res.status(400).json({ message: 'رقم الهاتف مطلوب.' });
    }
    const { setAdminPermissions } = require('../supabase_repo');
    const result = await setAdminPermissions(phone, targetPhone, permissions);
    return res.json(result);
  } catch (error) {
    logger.error('admin permissions update error', { error: error.message });
    const status = error.message.includes('Super admin') ? 403 : 500;
    return res.status(status).json({ message: error.message });
  }
});

router.delete('/admin/admin-remove', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const targetPhone = String(req.body?.targetPhone || req.query?.targetPhone || '').trim();
    if (!targetPhone) {
      return res.status(400).json({ message: 'رقم الهاتف مطلوب.' });
    }
    const { removeAdmin } = require('../supabase_repo');
    const result = await removeAdmin(phone, targetPhone);
    return res.json(result);
  } catch (error) {
    logger.error('admin remove error', { error: error.message });
    const status = error.message.includes('Super admin') || error.message.includes('protected')
      ? 403
      : 500;
    return res.status(status).json({ message: error.message });
  }
});

// ── User State ──────────────────────────────────────────────────────────

router.get('/user-state', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    const state = (await getUserState(phone)) || {};
    return res.json(state);
  } catch (error) {
    console.error('get user-state error:', error);
    const message = error?.message || 'Failed to load user state.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/user-state', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    const row = await saveUserState(phone, req.body?.state || {});
    return res.json(row);
  } catch (error) {
    console.error('save user-state error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to save user state.' });
  }
});

router.delete('/user-state', async (req, res) => {
  try {
    const phone = requireAuthorizedPhone(req, res);
    if (!phone) return;
    await deleteUserState(phone);
    return res.json({ success: true });
  } catch (error) {
    console.error('delete user-state error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete user state.' });
  }
});

/// إرسال رسالة للمستخدمين (إشعار داخلي + push خارجي)
async function handleAdminBroadcast(req, res) {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;

    const { title, body, audience, platform, storeUpdate } = req.body || {};
    const result = await broadcastAdminUserMessage(phone, {
      title,
      body,
      audience,
      platform,
      storeUpdate,
    });
    return res.json(result);
  } catch (error) {
    console.error('admin broadcast error:', error);
    const message = error?.message || 'Failed to broadcast message.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
}

router.post('/admin/messages/broadcast', handleAdminBroadcast);

router.get('/admin/support-threads', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    if (deferAdminPollIfCircuit(res, [])) return;
    const threads = await getSupportThreadsForAdmin(phone);
    return res.json(threads);
  } catch (error) {
    console.error('admin support threads error:', error);
    if (isBusyAdminError(error)) return res.json([]);
    const message = error?.message || 'Failed to load support threads.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.get('/admin/support-context/:phone', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const context = await adminOps.getSupportContextForAdmin(phone, req.params.phone);
    return res.json(context);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load support context.');
  }
});

/// إرسال إشعار يدوي من لوحة الأدمن (يتضمن حفظ داخل التطبيق + push)
router.post('/admin/push/send', handleAdminBroadcast);

/// إشعارات لوحة الأدمن — أدمن فقط
router.get('/admin/notifications', async (req, res) => {
  try {
    const phone = await requireAdminAccess(req, res);
    if (!phone) return;

    const { isDbCircuitOpen } = require('../lib/db_circuit');
    const { getCached, remember, setCacheHeader, DEFAULT_TTLS } = require('../lib/response_cache');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const unreadOnly = req.query.unreadOnly === 'true';
    const cacheKey = `admin:notifications:${phone}:${unreadOnly ? 'unread' : 'all'}:${limit}`;

    if (isDbCircuitOpen()) {
      const cached = await getCached(cacheKey);
      if (cached?.value) {
        setCacheHeader(res, true, cached.source);
        return res.json(cached.value);
      }
      return res.json([]);
    }

    const cached = await remember(cacheKey, DEFAULT_TTLS.adminNotifications, async () => {
      const { assertSupabaseAdmin } = require('../supabase_repo/common');
      const supabase = assertSupabaseAdmin();
      let query = supabase
        .from('admin_notifications')
        .select('id,title,body,message,is_read,created_at,type,link,href')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (unreadOnly) query = query.eq('is_read', false);
      const { data, error } = await query;
      if (error) {
        // أعمدة اختيارية قد تختلف — أعد بـ * عند الفشل.
        let fallback = supabase
          .from('admin_notifications')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit);
        if (unreadOnly) fallback = fallback.eq('is_read', false);
        const second = await fallback;
        if (second.error) throw new Error(second.error.message);
        return second.data || [];
      }
      return data || [];
    });
    setCacheHeader(res, cached.cacheHit, cached.cacheSource);
    return res.json(cached.value);
  } catch (error) {
    console.error('admin notifications fetch error:', error);
    if (/aborted|AbortError|timeout|مشغول/i.test(String(error?.message || ''))) {
      return res.json([]);
    }
    const message = error?.message || 'Failed to fetch notifications.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

router.put('/admin/notifications/read', async (req, res) => {
  try {
    const phone = await requireAdminAccess(req, res);
    if (!phone) return;

    const { assertSupabaseAdmin } = require('../supabase_repo/common');
    const supabase = assertSupabaseAdmin();
    const { ids } = req.body;

    if (Array.isArray(ids) && ids.length > 0) {
      await supabase.from('admin_notifications').update({ is_read: true }).in('id', ids);
    } else {
      await supabase.from('admin_notifications').update({ is_read: true }).eq('is_read', false);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('admin notifications mark read error:', error);
    const message = error?.message || 'Failed to mark notifications as read.';
    const status = message.includes('Admin access') ? 403 : 500;
    return res.status(status).json({ message });
  }
});

// ── Ops console: orders / taxi / live / search / tickets ───────────────

const adminOps = require('../supabase_repo/admin_ops');

function adminOpsError(res, error, fallback) {
  console.error(fallback, error);
  const message = error?.message || fallback;
  const status = /Admin access|غير مصرح|Unauthorized/i.test(message)
    ? 403
    : /not found|مطلوب|أدخل|حدد|لديك طلب|غير متاحة|اختر|لا يمكن|تعذّر|غير صالح/i.test(message)
      ? 400
      : 500;
  return res.status(status).json({ message });
}

router.get('/admin/orders', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    if (deferAdminPollIfCircuit(res, [])) return;
    const orders = await adminOps.getAdminOrders(phone, {
      status: parseQueryValue(req.query.status),
      deliveryStatus: parseQueryValue(req.query.deliveryStatus),
      phone: parseQueryValue(req.query.phone),
      orderNumber: parseQueryValue(req.query.orderNumber),
      merchantPhone: parseQueryValue(req.query.merchantPhone),
      limit: Number(req.query.limit ?? 80),
    });
    return res.json(orders);
  } catch (error) {
    if (isBusyAdminError(error)) return res.json([]);
    return adminOpsError(res, error, 'Failed to load admin orders.');
  }
});

router.get('/admin/orders/:id', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const order = await adminOps.getAdminOrderById(phone, req.params.id);
    return res.json(order);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load order.');
  }
});

router.put('/admin/orders/:id/status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const order = await adminOps.adminUpdateOrderStatus(phone, req.params.id, req.body || {});
    return res.json(order);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to update order status.');
  }
});

router.put('/admin/orders/:id/confirm-return', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const order = await adminOps.adminConfirmOrderReturn(phone, req.params.id);
    return res.json(order);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to confirm order return.');
  }
});

router.put('/admin/orders/:id/reassign-courier', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const order = await adminOps.adminReassignCourier(phone, req.params.id, req.body || {});
    return res.json(order);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to reassign courier.');
  }
});

router.put('/admin/orders/:id/cancel', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const order = await adminOps.adminCancelOrder(phone, req.params.id, req.body || {});
    return res.json(order);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to cancel order.');
  }
});

router.put('/admin/orders/:id/dispute', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const order = await adminOps.adminDisputeOrder(phone, req.params.id, req.body || {});
    return res.json(order);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to update dispute.');
  }
});

router.get('/admin/taxi/trips/:id', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.getAdminTaxiTripById(phone, req.params.id);
    return res.json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load taxi trip.');
  }
});

router.put('/admin/taxi/trips/:id/cancel', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.adminCancelTaxiTrip(phone, req.params.id, req.body || {});
    return res.json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to cancel taxi trip.');
  }
});

router.put('/admin/taxi/trips/:id/complete', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.adminCompleteTaxiTrip(phone, req.params.id);
    return res.json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to complete taxi trip.');
  }
});

router.post('/admin/taxi/trips/create', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.adminCreateTaxiTrip(phone, req.body || {});
    return res.status(201).json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to create taxi trip.');
  }
});

router.put('/admin/taxi/trips/:id/assign-captain', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.adminAssignTaxiCaptain(phone, req.params.id, req.body || {});
    return res.json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to assign taxi captain.');
  }
});

router.put('/admin/taxi/trips/:id/rematch', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.adminRematchTaxiTrip(phone, req.params.id, req.body || {});
    return res.json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to rematch taxi trip.');
  }
});

router.get('/admin/taxi/driver-cancellations', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    const cancellations = require('../supabase_repo/taxi_driver_cancellations');
    const result = await cancellations.listDriverCancellationsForAdmin({
      status: parseQueryValue(req.query.status),
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 25),
    });
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load driver cancellations.');
  }
});

router.put('/admin/taxi/driver-cancellations/:id/review', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    const cancellations = require('../supabase_repo/taxi_driver_cancellations');
    const decision = String(req.body?.decision || req.body?.status || '').trim();
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ message: 'decision must be approved or rejected.' });
    }
    const result = await cancellations.reviewDriverCancellation(
      phone,
      req.params.id,
      decision,
      req.body?.note,
    );
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to review driver cancellation.');
  }
});

router.get('/admin/delivery/assignee-cancellations', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    const cancellations = require('../supabase_repo/delivery_assignee_cancellations');
    const result = await cancellations.listAssigneeCancellationsForAdmin({
      status: parseQueryValue(req.query.status),
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 25),
    });
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load delivery assignee cancellations.');
  }
});

router.put('/admin/delivery/assignee-cancellations/:id/review', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const { assertAdminAccess } = require('../supabase_repo/users');
    await assertAdminAccess(phone);
    const cancellations = require('../supabase_repo/delivery_assignee_cancellations');
    const decision = String(req.body?.decision || req.body?.status || '').trim();
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ message: 'decision must be approved or rejected.' });
    }
    const result = await cancellations.reviewAssigneeCancellation(
      phone,
      req.params.id,
      decision,
      req.body?.note,
    );
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to review delivery assignee cancellation.');
  }
});

router.put('/admin/taxi/complaints/:id/resolve', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const trip = await adminOps.adminResolveTaxiComplaint(phone, req.params.id, req.body || {});
    return res.json(trip);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to resolve complaint.');
  }
});

router.get('/admin/live/overview', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const overview = await adminOps.getAdminLiveOverview(phone);
    return res.json(overview);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load live overview.');
  }
});

router.get('/admin/search', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await adminOps.adminUnifiedSearch(phone, parseQueryValue(req.query.q));
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to search.');
  }
});

router.get('/admin/support-tickets', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    if (deferAdminPollIfCircuit(res, [])) return;
    const tickets = await adminOps.listSupportTickets(phone, {
      status: parseQueryValue(req.query.status),
      limit: Number(req.query.limit ?? 50),
    });
    return res.json(tickets);
  } catch (error) {
    if (isBusyAdminError(error)) return res.json([]);
    return adminOpsError(res, error, 'Failed to load support tickets.');
  }
});

router.post('/admin/support-tickets', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const ticket = await adminOps.createSupportTicket(phone, req.body || {});
    return res.json(ticket);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to create ticket.');
  }
});

router.put('/admin/support-tickets/:id', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const ticket = await adminOps.updateSupportTicket(phone, req.params.id, req.body || {});
    return res.json(ticket);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to update ticket.');
  }
});

router.get('/admin/merchant-reviews', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await adminOps.listMerchantReviewsForAdmin(phone, {
      q: parseQueryValue(req.query.q),
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 25),
      merchantPhone: parseQueryValue(req.query.merchantPhone),
    });
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load merchant reviews.');
  }
});

router.delete('/admin/merchant-reviews/:id', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await adminOps.deleteMerchantReviewForAdmin(phone, req.params.id);
    return res.json(result);
  } catch (error) {
    return adminOpsError(res, error, 'Failed to delete review.');
  }
});

router.get('/admin/audit-logs', async (req, res) => {
  try {
    const phone = await requireAdminAccess(req, res);
    if (!phone) return;
    const logs = await listAdminAuditLogs({
      entityType: parseQueryValue(req.query.entityType),
      entityId: parseQueryValue(req.query.entityId),
      limit: Number(req.query.limit || 80),
    });
    return res.json({ items: logs });
  } catch (error) {
    return adminOpsError(res, error, 'Failed to load audit logs.');
  }
});

/// إضافة إشعار للأدمن
async function insertAdminNotification(type, title, body, data = {}) {
  try {
    const { assertSupabaseAdmin } = require('../supabase_repo/common');
    const supabase = assertSupabaseAdmin();
    await supabase.from('admin_notifications').insert({
      type,
      title,
      body,
      data: { ...data, timestamp: new Date().toISOString() },
    });
  } catch (e) {
    console.error('insertAdminNotification error:', e?.message || e);
  }
}

router.get('/admin/kashier/overview', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const merchantPhone = String(parseQueryValue(req.query.merchantPhone) || req.query.phone || '').trim();
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    const { getPosMerchantOverview } = require('../supabase_repo/kashier_staff');
    const overview = await getPosMerchantOverview(merchantPhone);
    return res.json(overview);
  } catch (error) {
    console.error('admin kashier overview error:', error);
    const status = String(error?.message || '').includes('Admin') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to load POS overview.' });
  }
});

router.get('/admin/kashier/stores', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const { listPosEnabledMerchants } = require('../supabase_repo/kashier_staff');
    const stores = await listPosEnabledMerchants({
      limit: Number(req.query.limit ?? 50),
    });
    return res.json({ items: stores });
  } catch (error) {
    console.error('admin kashier stores error:', error);
    const status = String(error?.message || '').includes('Admin') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to load POS stores.' });
  }
});

router.post('/admin/kashier/enable', async (req, res) => {
  try {
    const adminPhone = requireOptionalAuthorizedPhone(req, res);
    if (!adminPhone) return;
    const adminRole = await requireMinAdminRole(req, res, adminPhone, 'moderator');
    if (!adminRole) return;
    const merchantPhone = String(req.body?.merchantPhone || req.body?.phone || '').trim();
    if (!merchantPhone) {
      return res.status(400).json({ message: 'merchantPhone is required.' });
    }
    const { enablePosStore } = require('../supabase_repo/kashier_staff');
    const groceryPin = String(req.body?.groceryPin || '1234');
    const householdPin = String(req.body?.householdPin || '1234');
    const result = await enablePosStore(
      merchantPhone,
      req.body?.posConfig || {},
      [
        { username: 'grocery', pin: groceryPin, role: 'cashier', department: 'grocery', displayName: 'كاشير غذائية' },
        { username: 'household', pin: householdPin, role: 'cashier', department: 'household', displayName: 'كاشير منزلية' },
      ],
    );
    result.pins = { grocery: groceryPin, household: householdPin };
    return res.json(result);
  } catch (error) {
    console.error('admin kashier enable error:', error);
    const status = String(error?.message || '').includes('Admin') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to enable POS.' });
  }
});

module.exports = router;
