const express = require('express');
const router = express.Router();
const {
  getMerchantIncomingOrders,
  updateIncomingOrderStatus,
} = require('../supabase_repo/orders');
const { getMerchantProducts } = require('../supabase_repo/merchants');
const {
  getChatInbox,
  getChatMessages,
  saveChatMessage,
} = require('../supabase_repo/chat');
const { requireOptionalAuthorizedPhone } = require('./_middleware');
const { loginKashierStaff, getOpenShift, openShift, closeShift, getKashierReports } = require('../supabase_repo/kashier_staff');
const {
  orderTouchesDepartment,
  allPosTicketsReady,
  departmentFromSubCategory,
} = require('../lib/pos_departments');

function readOrderMeta(row) {
  const payload =
    row?.order_payload && typeof row.order_payload === 'object' ? row.order_payload : {};
  const items = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.lineItems)
      ? payload.lineItems
      : [];
  return {
    id: String(row?.id || payload.id || ''),
    orderNumber: String(payload.orderNumber || ''),
    customerPhone: String(row?.phone || payload.customerPhone || ''),
    customerName: String(payload.customerNameAr || payload.customerNameEn || ''),
    statusKey: String(row?.status_key || payload.statusKey || 'pending'),
    deliveryStatusKey: String(row?.delivery_status_key || payload.deliveryStatusKey || ''),
    total: Number(payload.price || payload.total || 0),
    createdAt: String(row?.created_at || payload.createdAt || new Date().toISOString()),
    notes: String(payload.noteAr || payload.noteEn || ''),
    items: items.map((item) => ({
      productId: String(item.id || item.productId || ''),
      name: String(item.nameAr || item.name || item.nameEn || 'صنف'),
      quantity: Number(item.quantity || 1),
      unitPrice: Number(item.price || item.unitPrice || 0),
      posDepartment:
        String(item.posDepartment || item.pos_department || '').trim() ||
        departmentFromSubCategory(item.subCategory || item.sub_category),
    })),
    posTickets: payload.posTickets || {},
    posEnabled: payload.posEnabled === true,
    deliveryFeeIqd: Number(payload.deliveryFeeIqd || 0),
    itemsSubtotalIqd: Number(payload.itemsSubtotalIqd || payload.price || 0),
  };
}

function mapProductRow(row) {
  return {
    id: String(row.id || ''),
    nameAr: String(row.name_ar || row.nameAr || ''),
    barcode: String(row.barcode || ''),
    price: Number(row.price || 0),
    cost: Number(row.cost || row.cost_price || 0),
    stockQuantity: Number(row.stock_quantity ?? row.stockQuantity ?? 0),
    category: String(row.category || ''),
    subCategory: String(row.sub_category || row.subCategory || ''),
    image: String(row.image_url || row.imageUrl || row.image || '').trim(),
    isAvailable: row.is_available !== false && row.isAvailable !== false,
  };
}

function mapInboxThread(row, merchantPhone) {
  const customerPhone = String(
    row.other_party_phone || row.customerPhone || row.thread_id || '',
  ).trim();
  return {
    threadId: String(row.thread_id || customerPhone),
    customerPhone: customerPhone || String(row.thread_id || ''),
    customerName: String(row.thread_title || row.other_party_name || ''),
    lastMessage: String(row.last_message || row.content || ''),
    unreadCount: Number(row.unread_count || 0),
    updatedAt: String(row.updated_at || row.created_at || new Date().toISOString()),
    merchantPhone,
  };
}

router.post('/login', async (req, res) => {
  try {
    const result = await loginKashierStaff({
      merchantPhone: req.body?.merchantPhone || req.body?.phone,
      username: req.body?.username,
      pin: req.body?.pin,
    });
    return res.json(result);
  } catch (error) {
    console.error('kashier login error:', error);
    return res.status(401).json({ message: error?.message || 'تعذر تسجيل الدخول.' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    return res.json({
      merchantPhone: phone,
      staff: req.kashierStaff || null,
      socketUrl:
        String(process.env.SOCKET_BROADCAST_URL || process.env.SOCKET_URL || '')
          .trim() || 'https://socket.hirasite.com',
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Failed.' });
  }
});

function staffDepartment(req) {
  return String(req.kashierStaff?.department || req.query.department || '').trim();
}

function filterByDepartment(items, department, pick) {
  if (!department || department === 'both' || department === 'catalog' || department === 'manager') {
    return items;
  }
  return items.filter((item) => pick(item, department));
}

router.get('/ops/snapshot', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const [orders, products, inbox] = await Promise.all([
      getMerchantIncomingOrders(phone),
      getMerchantProducts(phone),
      getChatInbox(phone),
    ]);
    const mapped = orders.map(readOrderMeta);
    const lowStock = (products || []).filter((p) => Number(p.stock_quantity ?? 0) <= 5).length;
    const unreadChats = (inbox || []).reduce((sum, t) => sum + Number(t.unread_count || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    let todaySalesTotal = mapped
      .filter((o) => String(o.createdAt).startsWith(today) && o.statusKey === 'completed')
      .reduce((sum, o) => sum + Number(o.total || 0), 0);

    try {
      const { assertSupabaseAdmin } = require('../supabase_repo/common');
      const supabase = assertSupabaseAdmin();
      const { data: posSales } = await supabase
        .from('kashier_pos_sales')
        .select('total')
        .eq('merchant_phone', phone)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .lte('created_at', `${today}T23:59:59.999Z`);
      if (Array.isArray(posSales)) {
        todaySalesTotal += posSales.reduce((sum, row) => sum + Number(row.total || 0), 0);
      }
    } catch {
      /* table may not exist yet */
    }

    return res.json({
      pendingOrders: mapped.filter((o) => o.statusKey === 'pending').length,
      preparingOrders: mapped.filter((o) =>
        ['accepted', 'preparing'].includes(o.statusKey),
      ).length,
      awaitingCourier: mapped.filter(
        (o) => o.statusKey === 'delivering' && o.deliveryStatusKey === 'waiting',
      ).length,
      unreadChats,
      lowStockCount: lowStock,
      todaySalesTotal,
    });
  } catch (error) {
    console.error('kashier ops snapshot error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load ops snapshot.' });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const status = String(req.query.status || '').trim();
    const rows = await getMerchantIncomingOrders(phone);
    let mapped = rows.map(readOrderMeta);
    mapped = filterByDepartment(mapped, staffDepartment(req), (o, dept) =>
      orderTouchesDepartment(o, dept),
    );
    if (status) mapped = mapped.filter((o) => o.statusKey === status);
    return res.json(mapped.slice(0, 100));
  } catch (error) {
    console.error('kashier orders error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load orders.' });
  }
});

router.put('/orders/:id/status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.params.id || '').trim();
    const statusKey = String(req.body?.statusKey || '').trim();
    if (!orderId || !statusKey) {
      return res.status(400).json({ message: 'order id and statusKey are required.' });
    }

    const updates = {
      statusKey,
      noteAr: req.body?.note || req.body?.noteAr,
    };

    if (statusKey === 'delivering') {
      updates.deliveryStatusKey = 'waiting';
      updates.deliveryStatusAr = 'بانتظار مندوب';
      updates.deliveryStatusEn = 'Waiting for courier';
    }
    if (statusKey === 'accepted') {
      updates.statusAr = 'مقبول';
      updates.statusEn = 'Accepted';
    }
    if (statusKey === 'rejected') {
      updates.statusAr = 'مرفوض';
      updates.statusEn = 'Rejected';
    }

    const row = await updateIncomingOrderStatus(phone, orderId, updates);
    return res.json(readOrderMeta(row));
  } catch (error) {
    console.error('kashier order status error:', error);
    const status = String(error?.message || '').includes('not allowed') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to update order.' });
  }
});

router.post('/orders/:id/ticket-ready', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.params.id || '').trim();
    const department = String(req.body?.department || staffDepartment(req) || '').trim();
    if (!orderId || !department) {
      return res.status(400).json({ message: 'department is required.' });
    }
    const rows = await getMerchantIncomingOrders(phone);
    const found = rows.map(readOrderMeta).find((o) => o.id === orderId);
    if (!found) return res.status(404).json({ message: 'الطلب غير موجود.' });

    const tickets = { ...(found.posTickets || {}) };
    if (!Object.keys(tickets).length) {
      for (const item of found.items || []) {
        const itemDept = String(item.posDepartment || '').trim();
        if (itemDept && !tickets[itemDept]) tickets[itemDept] = { status: 'pending' };
      }
    }
    tickets[department] = {
      ...(tickets[department] || {}),
      status: 'ready',
      readyAt: new Date().toISOString(),
    };
    const nextOrder = {
      ...found,
      posTickets: tickets,
      posEnabled: true,
      statusKey: found.statusKey === 'pending' ? 'accepted' : found.statusKey,
    };
    const ready = allPosTicketsReady(nextOrder);
    const updates = {
      posTickets: tickets,
      statusKey: ready ? 'delivering' : (nextOrder.statusKey || 'accepted'),
      statusAr: ready ? 'جاهز للتوصيل' : 'قيد التجهيز',
      statusEn: ready ? 'Ready for Delivery' : 'Preparing',
    };
    if (ready) {
      updates.deliveryStatusKey = 'waiting';
      updates.deliveryStatusAr = 'بانتظار مندوب';
      updates.deliveryStatusEn = 'Waiting for courier';
    }
    const saved = await updateIncomingOrderStatus(phone, orderId, updates);
    return res.json({ ...readOrderMeta(saved), posTickets: tickets, readyForCourier: ready });
  } catch (error) {
    console.error('kashier ticket-ready error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to mark ticket ready.' });
  }
});

router.post('/orders/:id/settle-cod', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const orderId = String(req.params.id || '').trim();
    const row = await updateIncomingOrderStatus(phone, orderId, {
      statusKey: 'completed',
      statusAr: 'مكتمل',
      statusEn: 'Completed',
      codConfirmed: true,
    });
    return res.json(readOrderMeta(row));
  } catch (error) {
    console.error('kashier settle error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to settle order.' });
  }
});

router.get('/products', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = await getMerchantProducts(phone);
    let mapped = (rows || []).map(mapProductRow);
    mapped = filterByDepartment(mapped, staffDepartment(req), (p, dept) => {
      const itemDept = departmentFromSubCategory(p.subCategory);
      return !itemDept || itemDept === dept;
    });
    // Cashier catalog: no images by design
    if (q) {
      mapped = mapped.filter(
        (p) =>
          p.nameAr.toLowerCase().includes(q) ||
          p.barcode.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q),
      );
    }
    return res.json(mapped.slice(0, 500));
  } catch (error) {
    console.error('kashier products error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load products.' });
  }
});

router.put('/products', async (_req, res) => {
  return res.status(403).json({
    message: 'إضافة المنتجات تتم حصراً من تطبيق التاجر مع صورة لكل منتج.',
  });
});

router.post('/sales', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'items are required.' });
    }
    const total = Number(body.total || 0);
    const paymentMethod = String(body.paymentMethod || body.payment_method || 'cash').trim() || 'cash';
    const cashierName = String(body.cashierName || body.cashier_name || '').trim();
    const saleId = String(body.id || `sale-${Date.now()}`).trim();

    const { decrementStockForPosSale } = require('../supabase_repo/merchants');
    const stockResult = await decrementStockForPosSale(
      items.map((item) => ({
        productId: item.productId || item.id,
        quantity: item.quantity ?? item.qty,
      })),
    );

    const saleRow = {
      id: saleId,
      merchant_phone: phone,
      total,
      payment_method: paymentMethod,
      items: items.map((item) => ({
        productId: String(item.productId || item.id || ''),
        name: String(item.name || item.nameAr || 'صنف'),
        qty: Number(item.quantity ?? item.qty ?? 1),
        unitPrice: Number(item.unitPrice ?? item.price ?? 0),
      })),
      cashier_name: cashierName || req.kashierStaff?.displayName || null,
      department: staffDepartment(req) || body.department || null,
      created_at: new Date().toISOString(),
    };

    try {
      const { assertSupabaseAdmin } = require('../supabase_repo/common');
      const supabase = assertSupabaseAdmin();
      const { error } = await supabase.from('kashier_pos_sales').upsert(saleRow, { onConflict: 'id' });
      if (error && !/does not exist|relation/i.test(error.message || '')) {
        console.warn('kashier sale persist warning:', error.message);
      }
    } catch (persistErr) {
      console.warn('kashier sale persist skipped:', persistErr?.message || persistErr);
    }

    return res.json({
      id: saleId,
      total,
      paymentMethod,
      cashierName,
      createdAt: saleRow.created_at,
      items: saleRow.items,
      stock: stockResult,
    });
  } catch (error) {
    console.error('kashier create sale error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to create sale.' });
  }
});

router.get('/sales', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const day = String(req.query.date || new Date().toISOString().slice(0, 10)).trim();
    try {
      const { assertSupabaseAdmin } = require('../supabase_repo/common');
      const supabase = assertSupabaseAdmin();
      const start = `${day}T00:00:00.000Z`;
      const end = `${day}T23:59:59.999Z`;
      const { data, error } = await supabase
        .from('kashier_pos_sales')
        .select('*')
        .eq('merchant_phone', phone)
        .gte('created_at', start)
        .lte('created_at', end)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return res.json(
        (data || []).map((row) => ({
          id: String(row.id),
          total: Number(row.total || 0),
          paymentMethod: String(row.payment_method || 'cash'),
          cashierName: String(row.cashier_name || ''),
          items: Array.isArray(row.items) ? row.items : [],
          createdAt: String(row.created_at || ''),
        })),
      );
    } catch (err) {
      if (/does not exist|relation/i.test(String(err?.message || ''))) {
        return res.json([]);
      }
      throw err;
    }
  } catch (error) {
    console.error('kashier list sales error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load sales.' });
  }
});

router.get('/chat/threads', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const inbox = await getChatInbox(phone);
    const storeThreads = (inbox || [])
      .filter((t) => String(t.thread_type || t.threadType || '') === 'store' || !t.thread_type)
      .map((t) => mapInboxThread(t, phone));
    return res.json(storeThreads.slice(0, 100));
  } catch (error) {
    console.error('kashier chat threads error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load chats.' });
  }
});

router.get('/chat/:customerPhone/messages', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const customerPhone = String(req.params.customerPhone || '').trim();
    if (!customerPhone) {
      return res.status(400).json({ message: 'customerPhone is required.' });
    }
    // Store thread id is merchant phone; customer is the other party
    const rows = await getChatMessages('store', phone, phone, {
      otherPartyPhone: customerPhone,
      limit: 100,
    });
    const messages = (rows || []).map((m) => ({
      id: String(m.id),
      threadId: String(m.thread_id || phone),
      senderPhone: String(m.sender_phone || ''),
      content: String(m.content || ''),
      createdAt: String(m.created_at || ''),
      fromCustomer: String(m.sender_phone || '') !== String(phone),
    }));
    return res.json(messages);
  } catch (error) {
    console.error('kashier chat messages error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load messages.' });
  }
});

router.post('/chat/:customerPhone/messages', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const customerPhone = String(req.params.customerPhone || '').trim();
    const content = String(req.body?.content || '').trim();
    if (!customerPhone || !content) {
      return res.status(400).json({ message: 'customerPhone and content are required.' });
    }
    const saved = await saveChatMessage({
      threadType: 'store',
      threadId: phone,
      senderPhone: phone,
      receiverPhone: customerPhone,
      content,
      senderName: req.body?.senderName || 'المتجر',
    });
    return res.json({
      id: String(saved.id),
      threadId: String(saved.thread_id || phone),
      senderPhone: String(saved.sender_phone || phone),
      content: String(saved.content || content),
      createdAt: String(saved.created_at || new Date().toISOString()),
      fromCustomer: false,
    });
  } catch (error) {
    console.error('kashier chat send error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to send message.' });
  }
});

router.get('/shift', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const shift = await getOpenShift(phone, staffDepartment(req));
    return res.json(shift || null);
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Failed to load shift.' });
  }
});

router.post('/shift/open', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const shift = await openShift({
      merchantPhone: phone,
      staffId: req.kashierStaff?.staffId || null,
      department: staffDepartment(req),
      cashierName: req.kashierStaff?.displayName || '',
      openingCash: req.body?.openingCash,
    });
    return res.json(shift);
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Failed to open system.' });
  }
});

router.post('/shift/close', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const shift = await closeShift({
      merchantPhone: phone,
      department: staffDepartment(req),
      closingCash: req.body?.closingCash,
      notes: req.body?.notes,
    });
    return res.json(shift);
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Failed to close shift.' });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const reports = await getKashierReports(phone, staffDepartment(req));
    return res.json(reports);
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Failed to load reports.' });
  }
});

module.exports = router;
