const express = require('express');
const router = express.Router();
const { getChatMessages, getChatInbox, saveChatMessage, markThreadAsRead, markAllThreadsAsRead, getUnreadCount, deleteChatThread, deleteChatMessage, toggleChatReaction, searchChatMessages, mapChatAccessError, isAdminChatPhone } = require('../supabase_repo');
const { requireOptionalAuthorizedPhone } = require('./_middleware');
const { notifyChatMessage, notifyAdminsSupportMessage } = require('../push_events');
const { broadcastChatMessage } = require('../lib/socket_broadcast');

function chatErrorStatus(message) {
  const text = String(message || '');
  if (text.includes('Unauthorized') || text.includes('غير مصرّح')) return 403;
  if (text.includes('أكمل ملفك الشخصي') || text.includes('قبل إرسال الرسائل')) {
    return 403;
  }
  if (
    text.includes('not found') ||
    text.includes('غير موجود')
  ) {
    return 404;
  }
  return 500;
}

function chatErrorMessage(error) {
  const raw = String(error?.message || error || '').trim();
  if (raw.includes('أكمل ملفك الشخصي')) return raw;
  return mapChatAccessError(error?.message) || 'تعذّر إكمال طلب المحادثة.';
}

router.get('/inbox/threads', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threads = await getChatInbox(phone);
    return res.json(threads);
  } catch (error) {
    console.error('get chat inbox error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

router.post('/inbox/read-all', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await markAllThreadsAsRead(phone);
    return res.json(result);
  } catch (error) {
    console.error('mark all read error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

router.get('/inbox/unread-count', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await getUnreadCount(phone);
    return res.json(result);
  } catch (error) {
    console.error('get unread count error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

router.post('/:threadType/:threadId/read', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.params.threadType || '').trim();
    const threadId = String(req.params.threadId || '').trim();
    if (!threadType || !threadId) {
      return res.status(400).json({ message: 'Thread type and id are required.' });
    }
    const result = await markThreadAsRead(
      threadType,
      threadId,
      phone,
      req.body?.otherPartyPhone ?? req.body?.other_party_phone,
    );
    // بث «قُرئ» لغرفة المحادثة فوراً حتى يرى المرسِل أن رسالته قُرئت.
    try {
      const { socketBroadcast } = require('../lib/socket_broadcast');
      void socketBroadcast({
        room: `${threadType}:${threadId}`,
        event: 'chat:read',
        payload: {
          threadType,
          threadId,
          readerPhone: phone,
          otherPartyPhone:
            req.body?.otherPartyPhone ?? req.body?.other_party_phone ?? null,
        },
      });
    } catch (error) {
      console.error('chat read broadcast error:', error?.message || error);
    }
    return res.json(result);
  } catch (error) {
    console.error('mark chat read error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

// POST /db/chat/:threadType/:threadId/typing - مؤشر «يكتب...» لحظياً
router.post('/:threadType/:threadId/typing', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.params.threadType || '').trim();
    const threadId = String(req.params.threadId || '').trim();
    if (!threadType || !threadId) {
      return res.status(400).json({ message: 'Thread type and id are required.' });
    }
    const isTyping = Boolean(req.body?.isTyping ?? req.body?.typing ?? false);
    try {
      const { socketBroadcast } = require('../lib/socket_broadcast');
      void socketBroadcast({
        room: `${threadType}:${threadId}`,
        event: 'chat:typing',
        payload: { threadType, threadId, phone, isTyping },
      });
    } catch (error) {
      console.error('chat typing broadcast error:', error?.message || error);
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('chat typing error:', error);
    return res.status(500).json({ message: 'Failed to send typing indicator.' });
  }
});

router.delete('/:threadType/:threadId', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.params.threadType || '').trim();
    const threadId = String(req.params.threadId || '').trim();
    if (!threadType || !threadId) {
      return res.status(400).json({ message: 'Thread type and id are required.' });
    }
    const otherPartyPhone =
      req.query?.otherPartyPhone ??
      req.query?.other_party_phone ??
      req.body?.otherPartyPhone ??
      req.body?.other_party_phone;
    const result = await deleteChatThread(threadType, threadId, phone, otherPartyPhone);
    return res.json(result);
  } catch (error) {
    console.error('delete chat thread error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

async function handleGet(req, res, threadType, threadId) {
  const phone = requireOptionalAuthorizedPhone(req, res);
  if (!phone) return;
  if (!threadType || !threadId) {
    return res.status(400).json({ message: 'Thread type and id are required.' });
  }
  const messages = await getChatMessages(threadType, threadId, phone, {
    limit: Number(req.query.limit) || undefined,
    offset: Number(req.query.offset) || undefined,
    after: String(req.query.after || '').trim() || undefined,
    before: String(req.query.before || '').trim() || undefined,
    otherPartyPhone:
      String(
        req.query?.otherPartyPhone ??
          req.query?.other_party_phone ??
          '',
      ).trim() || undefined,
  });
  return res.json(messages);
}

async function handlePost(req, res, threadType, threadId) {
  const phone = requireOptionalAuthorizedPhone(req, res);
  if (!phone) return;
  if (!threadType || !threadId) {
    return res.status(400).json({ message: 'Thread type and id are required.' });
  }
  const payload = { ...(req.body || {}) };
  payload.senderPhone = phone;
  payload.threadType = threadType;
  payload.threadId = threadId;
  payload.orderId = threadType === 'order' ? threadId : payload.orderId;

  const savedMessage = await saveChatMessage(payload);
  const receiverPhone = savedMessage.receiver_phone;
  if (receiverPhone) {
    notifyChatMessage(receiverPhone, {
      ...payload,
      ...savedMessage,
      senderName: payload.senderName || savedMessage.sender_name || null,
      threadType,
      threadId,
      orderId: threadType === 'order' ? threadId : '',
    }).catch((err) => console.error('chat push error:', err?.message || err));
  }
  if (threadType === 'support') {
    const senderIsAdmin = await isAdminChatPhone(phone);
    if (!senderIsAdmin) {
      notifyAdminsSupportMessage({
        ...payload,
        ...savedMessage,
        senderName: payload.senderName || savedMessage.sender_name || null,
        threadType,
        threadId,
      }).catch((err) => console.error('support admin push error:', err?.message || err));

      // إشعار لوحة الإدارة الويب فوراً (بالإضافة لـ FCM على الهاتف).
      try {
        const { socketBroadcast, adminOpsRoom } = require('../lib/socket_broadcast');
        const preview = String(
          savedMessage.content || payload.content || payload.text || '',
        ).trim();
        const senderName = String(
          payload.senderName || savedMessage.sender_name || 'مستخدم',
        ).trim();
        void socketBroadcast({
          room: adminOpsRoom(),
          event: 'live:ops',
          payload: {
            type: 'support_message',
            id: savedMessage.id || null,
            threadId,
            senderPhone: phone,
            senderName,
            preview: preview.substring(0, 120),
            title: `رسالة دعم من ${senderName}`,
            body: preview.substring(0, 100) || 'رسالة جديدة في محادثة الدعم',
          },
        });
      } catch (broadcastErr) {
        console.warn(
          'support admin live broadcast error:',
          broadcastErr?.message || broadcastErr,
        );
      }

      try {
        const { assertSupabaseAdmin } = require('../supabase_repo/common');
        const supabase = assertSupabaseAdmin();
        const senderName = String(
          payload.senderName || savedMessage.sender_name || 'مستخدم',
        ).trim();
        const preview = String(
          savedMessage.content || payload.content || payload.text || '',
        ).trim();
        await supabase.from('admin_notifications').insert({
          type: 'support_message',
          title: `رسالة دعم من ${senderName}`,
          body: preview.substring(0, 160) || 'رسالة جديدة في محادثة الدعم',
          data: {
            threadType: 'support',
            threadId,
            senderPhone: phone,
            messageId: savedMessage.id || null,
            href: `/admin/support-chat?phone=${encodeURIComponent(threadId)}`,
          },
        });
      } catch (inboxErr) {
        console.warn(
          'support admin inbox insert error:',
          inboxErr?.message || inboxErr,
        );
      }
    }
  }
  // best-effort: فشل البث اللحظي لا يمنع حفظ الرسالة ولا إشعار الطرف الآخر.
  try {
    broadcastChatMessage(threadType, threadId, savedMessage);
    // بث لغرفة المستخدم: يُحدّث صندوق الوارد وعدد غير المقروء فوراً.
    if (receiverPhone) {
      const { socketBroadcast, userRoom } = require('../lib/socket_broadcast');
      void socketBroadcast({
        room: userRoom(receiverPhone),
        event: 'chat:new_message',
        payload: {
          threadType,
          threadId,
          messageId: savedMessage.id || null,
        },
      });
    }
  } catch (error) {
    console.error('chat broadcast error:', error?.message || error);
  }
  return res.json(savedMessage);
}

router.get('/:threadType/:threadId', async (req, res) => {
  try {
    return await handleGet(req, res, req.params.threadType, req.params.threadId);
  } catch (error) {
    console.error('get chat error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

router.post('/:threadType/:threadId', async (req, res) => {
  try {
    return await handlePost(req, res, req.params.threadType, req.params.threadId);
  } catch (error) {
    console.error('save chat error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

// توافق قديم: /db/chat/:orderId
router.get('/:orderId', async (req, res) => {
  try {
    return await handleGet(req, res, 'order', req.params.orderId);
  } catch (error) {
    console.error('get chat legacy error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

router.post('/:orderId', async (req, res) => {
  try {
    return await handlePost(req, res, 'order', req.params.orderId);
  } catch (error) {
    console.error('save chat legacy error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

// DELETE /db/chat/:threadType/:threadId/messages/:messageId - حذف رسالتي
router.delete('/:threadType/:threadId/messages/:messageId', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await deleteChatMessage(
      req.params.threadType,
      req.params.threadId,
      req.params.messageId,
      phone,
    );
    try {
      const { socketBroadcast } = require('../lib/socket_broadcast');
      void socketBroadcast({
        room: `${req.params.threadType}:${req.params.threadId}`,
        event: 'chat:message_deleted',
        payload: {
          threadType: req.params.threadType,
          threadId: req.params.threadId,
          messageId: result.id,
        },
      });
    } catch (error) {
      console.error('chat delete broadcast error:', error?.message || error);
    }
    return res.json(result);
  } catch (error) {
    console.error('delete chat message error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

// POST /db/chat/:threadType/:threadId/reaction - تفاعل إيموجي
router.post('/:threadType/:threadId/reaction', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const result = await toggleChatReaction(
      req.params.threadType,
      req.params.threadId,
      String(req.body?.messageId || '').trim(),
      phone,
      String(req.body?.emoji || '').trim(),
    );
    try {
      const { socketBroadcast } = require('../lib/socket_broadcast');
      void socketBroadcast({
        room: `${req.params.threadType}:${req.params.threadId}`,
        event: 'chat:reaction',
        payload: {
          threadType: req.params.threadType,
          threadId: req.params.threadId,
          messageId: result.id,
          reactions: result.reactions,
          myEmoji: result.myEmoji,
        },
      });
    } catch (error) {
      console.error('chat reaction broadcast error:', error?.message || error);
    }
    return res.json(result);
  } catch (error) {
    console.error('chat reaction error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

// GET /db/chat/:threadType/:threadId/search?q= - بحث داخل المحادثة
router.get('/:threadType/:threadId/search', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const results = await searchChatMessages(
      req.params.threadType,
      req.params.threadId,
      phone,
      String(req.query.q || req.query.query || '').trim(),
    );
    return res.json(results);
  } catch (error) {
    console.error('chat search error:', error);
    const message = chatErrorMessage(error);
    return res.status(chatErrorStatus(message)).json({ message });
  }
});

module.exports = router;
