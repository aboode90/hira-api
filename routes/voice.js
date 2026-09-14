const express = require('express');
const router = express.Router();
const { requireOptionalAuthorizedPhone } = require('./_middleware');
const {
  getVoiceConfig,
  buildRoomId,
  userIdFromPhone,
  buildRtcToken,
  buildCallSession,
} = require('../services/voice_provider');
const {
  createOutgoingCallLog,
  completeCallLog,
  getCallHistory,
  getCallLogStatus,
  markCallConnected,
  rejectCallLog,
  expireStaleRingingCallLogs,
} = require('../supabase_repo');
const { getMerchantProfile } = require('../supabase_repo/merchants');
const { merchantAcceptsCustomerCalls } = require('../services/merchant_working_hours');

/** أنواع المحادثات التي يكون الطرف الآخر فيها تاجراً فعلاً. */
const MERCHANT_HOURS_THREAD_TYPES = new Set(['order', 'store']);
const { notifyIncomingCall, notifyCallCancelled } = require('../push_events');
const { resolveReceiverPhone, assertCanAccessThread } = require('../supabase_repo/chat');
const {
  getPhoneVariants,
  assertSupabaseAdmin,
  resolvePhoneKey,
  phonesOverlap,
  canonicalPhone,
} = require('../supabase_repo/common');

const VOICE_EXPIRE_THROTTLE_MS = 45_000;
let lastVoiceExpireAt = 0;
let voiceExpireInFlight = null;

function isTransientUpstreamError(error) {
  return /upstream request timeout|timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    String(error?.message || error || '')
  );
}

async function maybeExpireStaleRingingCallLogs(options) {
  const now = Date.now();
  if (now - lastVoiceExpireAt < VOICE_EXPIRE_THROTTLE_MS) {
    return [];
  }
  if (voiceExpireInFlight) {
    return voiceExpireInFlight;
  }
  lastVoiceExpireAt = now;
  voiceExpireInFlight = expireStaleRingingCallLogs(options)
    .catch((error) => {
      console.warn('voice expire stale soft-fail:', error?.message || error);
      return [];
    })
    .finally(() => {
      voiceExpireInFlight = null;
    });
  return voiceExpireInFlight;
}

async function assertValidCallReceiver({
  threadType,
  threadId,
  callerPhone,
  receiverPhone,
}) {
  const caller = await resolvePhoneKey(callerPhone);
  const receiver = await resolvePhoneKey(receiverPhone);
  if (!receiver || phonesOverlap(caller, receiver)) {
    throw new Error('Invalid call receiver.');
  }

  const expected = await resolveReceiverPhone(threadType, threadId, caller, '');
  if (expected && phonesOverlap(expected, receiver)) return receiver;

  // اسمح بطرف آخر مشروع في نفس المحادثة (مثلاً تاجر يتصل بزبون متجر)
  // فقط إذا كان الطرفان شاركا فعلياً في خيط المحادثة.
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('chat_messages')
    .select('sender_phone, receiver_phone')
    .eq('thread_type', threadType)
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const knownPair = (data || []).some((row) => {
    const direct =
      phonesOverlap(row.sender_phone, caller) &&
      phonesOverlap(row.receiver_phone, receiver);
    const reverse =
      phonesOverlap(row.sender_phone, receiver) &&
      phonesOverlap(row.receiver_phone, caller);
    return direct || reverse;
  });
  if (!knownPair) {
    throw new Error('Unauthorized call receiver.');
  }
  return receiver;
}

router.get('/config', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const config = getVoiceConfig();
    return res.json({
      provider: config.provider,
      enabled: config.enabled,
      appId: config.enabled ? config.appId : 0,
      livekitUrl: config.livekitUrl || '',
      publiclyReachable: config.publiclyReachable !== false,
      privateHost: config.privateHost === true,
    });
  } catch (error) {
    console.error('voice config error:', error);
    return res.status(500).json({ message: 'Failed to load voice call config.' });
  }
});

router.get('/pending', async (req, res) => {
  try {
    const { shouldShedOptionalPolling } = require('../lib/db_circuit');
    if (shouldShedOptionalPolling()) {
      return res.json([]);
    }

    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;

    // لا ننتظر انتهاء انتهاء المكالمات القديمة على مسار الاستطلاع المتكرر.
    void maybeExpireStaleRingingCallLogs({ olderThanSeconds: 45 });

    const phoneKey = canonicalPhone(phone) || String(phone || '').trim();
    const variants = getPhoneVariants(phoneKey);
    if (!variants.length) return res.json([]);

    const supabase = assertSupabaseAdmin();
    const since = new Date(Date.now() - 120_000).toISOString();
    const { data, error } = await supabase
      .from('voice_call_logs')
      .select(
        'id, thread_type, thread_id, caller_phone, receiver_phone, caller_name, channel_name, status, started_at',
      )
      .in('receiver_phone', variants)
      .eq('status', 'ringing')
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(5);

    if (error) {
      if (isTransientUpstreamError(error)) {
        console.warn('voice pending soft-fail:', error.message);
        return res.json([]);
      }
      const status = String(error.message || '').includes('does not exist') ? 503 : 500;
      return res.status(status).json({ message: error.message });
    }

    return res.json((data || []).map((row) => ({
      id: row.id,
      thread_type: row.thread_type,
      thread_id: row.thread_id,
      caller_phone: row.caller_phone,
      receiver_phone: row.receiver_phone,
      caller_name: row.caller_name,
      channel_name: row.channel_name,
      status: row.status,
      started_at: row.started_at,
    })));
  } catch (error) {
    if (isTransientUpstreamError(error)) {
      console.warn('voice pending soft-fail:', error?.message || error);
      return res.json([]);
    }
    console.error('voice pending error:', error);
    return res.status(500).json({ message: error?.message || 'Failed to load pending calls.' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.query.threadType || '').trim();
    const threadId = String(req.query.threadId || '').trim();
    const limit = req.query.limit;
    if (threadType && threadId) {
      await assertCanAccessThread(threadType, threadId, phone);
    }
    const logs = await getCallHistory(phone, {
      threadType: threadType || undefined,
      threadId: threadId || undefined,
      limit,
    });
    return res.json(logs);
  } catch (error) {
    console.error('voice history error:', error);
    const status = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to load call history.' });
  }
});

router.get('/call/status', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const callLogId = String(req.query.callLogId || '').trim();
    if (!callLogId) {
      return res.status(400).json({ message: 'callLogId is required.' });
    }
    const expiredCalls = await expireStaleRingingCallLogs({ olderThanSeconds: 45 });
    for (const expired of expiredCalls) {
      if (!expired.receiver_phone) continue;
      notifyCallCancelled(expired.receiver_phone, {
        threadType: expired.thread_type,
        threadId: expired.thread_id,
        channelName: expired.channel_name,
        callLogId: expired.id,
      }).catch(() => {});
    }
    const status = await getCallLogStatus({ callLogId, requestPhone: phone });
    return res.json(status);
  } catch (error) {
    console.error('voice call status error:', error);
    const statusCode = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(statusCode).json({ message: error?.message || 'Failed to load call status.' });
  }
});

router.post('/call/reject', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.body?.threadType || '').trim();
    const threadId = String(req.body?.threadId || '').trim();
    if (threadType && threadId) {
      await assertCanAccessThread(threadType, threadId, phone);
    }
    const saved = await rejectCallLog({
      callLogId: req.body?.callLogId,
      channelName: req.body?.channelName,
      requestPhone: phone,
      threadType,
      threadId,
    });
    if (!saved) {
      return res.status(404).json({ message: 'لا توجد مكالمة قيد الرنين.' });
    }
    return res.json(saved);
  } catch (error) {
    console.error('voice call reject error:', error);
    const status = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to reject call.' });
  }
});

router.post('/call/connect', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.body?.threadType || '').trim();
    const threadId = String(req.body?.threadId || '').trim();
    if (threadType && threadId) {
      await assertCanAccessThread(threadType, threadId, phone);
    }
    const saved = await markCallConnected({
      callLogId: req.body?.callLogId,
      channelName: req.body?.channelName,
      requestPhone: phone,
    });
    if (!saved) {
      return res.status(409).json({ message: 'المكالمة لم تعد قيد الرنين.' });
    }
    return res.json(saved);
  } catch (error) {
    console.error('voice call connect error:', error);
    const status = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to connect call.' });
  }
});

router.post('/call/complete', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;
    const threadType = String(req.body?.threadType || '').trim();
    const threadId = String(req.body?.threadId || '').trim();
    if (threadType && threadId) {
      await assertCanAccessThread(threadType, threadId, phone);
    }
    const saved = await completeCallLog({
      callLogId: req.body?.callLogId,
      requestPhone: phone,
      threadType: req.body?.threadType,
      threadId: req.body?.threadId,
      otherPartyPhone: req.body?.otherPartyPhone,
      direction: req.body?.direction,
      status: req.body?.status,
      durationSeconds: req.body?.durationSeconds,
      channelName: req.body?.channelName,
    });
    if (
      saved &&
      phonesOverlap(phone, saved.caller_phone) &&
      ['no_answer', 'failed'].includes(String(saved.status || '')) &&
      saved.receiver_phone
    ) {
      notifyCallCancelled(saved.receiver_phone, {
        threadType: saved.thread_type,
        threadId: saved.thread_id,
        channelName: saved.channel_name,
        callLogId: saved.id,
      }).catch((pushError) => {
        console.warn('call cancelled push:', pushError?.message || pushError);
      });
    }
    return res.json(saved);
  } catch (error) {
    console.error('voice call complete error:', error);
    const status = String(error?.message || '').includes('Unauthorized') ? 403 : 500;
    return res.status(status).json({ message: error?.message || 'Failed to complete call log.' });
  }
});

router.post('/token', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;

    const threadType = String(req.body?.threadType || 'order').trim();
    const threadId = String(req.body?.threadId || '').trim();
    if (!threadId) {
      return res.status(400).json({ message: 'threadId is required.' });
    }

    await assertCanAccessThread(threadType, threadId, phone);

    const roomId =
      String(req.body?.channelName || req.body?.roomId || '').trim() ||
      buildRoomId(threadType, threadId);
    const callLogId = String(req.body?.callLogId || '').trim();
    const userId = userIdFromPhone(phone);
    const session = buildRtcToken(roomId, userId);

    return res.json({
      ...session,
      threadType,
      threadId,
      callLogId: callLogId || null,
    });
  } catch (error) {
    console.error('voice token error:', error);
    const message = String(error?.message || 'Failed to create voice token.');
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('not configured')
        ? 503
        : 500;
    return res.status(status).json({ message });
  }
});

router.post('/call', async (req, res) => {
  try {
    const phone = requireOptionalAuthorizedPhone(req, res);
    if (!phone) return;

    // إيقاف المكالمات الداخلية مؤقتاً (يُدار من الإعدادات بدون تحديث التطبيق)
    const { getVoiceCallsEnabled } = require('../services/app_config_service');
    if (!(await getVoiceCallsEnabled())) {
      return res.status(403).json({ message: 'المكالمات الداخلية غير متاحة حالياً. استخدم المحادثة أو الاتصال العادي.' });
    }

    const threadType = String(req.body?.threadType || 'order').trim();
    const threadId = String(req.body?.threadId || '').trim();
    let receiverPhone = String(req.body?.receiverPhone || '').trim();
    let callerName = String(req.body?.callerName || 'مستخدم').trim();
    const weakCallerName =
      !callerName ||
      ['مستخدم', 'سائق', 'السائق', 'متصل', 'كابتن', 'الكابتن'].includes(callerName);
    if (weakCallerName) {
      try {
        if (threadType === 'taxi') {
          const { selectSingle } = require('../supabase_repo/common');
          const { readTaxiMeta } = require('../supabase_repo/taxi');
          const row = await selectSingle('taxi_requests', 'id', threadId);
          const meta = row ? readTaxiMeta(row) : {};
          const driverPhone = meta.driverPhone || row?.driver_phone || '';
          if (driverPhone && phonesOverlap(phone, driverPhone)) {
            const { getDriverProfile } = require('../supabase_repo/operator_profiles');
            const profile = await getDriverProfile(phone);
            const driverName = String(
              profile?.name || meta.driverName || row?.driver_name || ''
            ).trim();
            if (driverName) {
              callerName = driverName.startsWith('كابتن')
                ? driverName
                : `كابتن ${driverName}`;
            }
          }
        }
        if (
          !callerName ||
          ['مستخدم', 'سائق', 'السائق', 'متصل', 'كابتن', 'الكابتن'].includes(callerName)
        ) {
          const { getAppUser } = require('../supabase_repo/users');
          const user = await getAppUser(phone);
          const fullName = String(user?.full_name || user?.fullName || '').trim();
          if (fullName) callerName = fullName;
        }
      } catch (_) {}
    }

    if (!threadId) {
      return res.status(400).json({ message: 'threadId is required.' });
    }

    await assertCanAccessThread(threadType, threadId, phone);

    if (!receiverPhone) {
      const resolved = await resolveReceiverPhone(threadType, threadId, phone, '');
      receiverPhone = String(resolved || '').trim();
    }
    if (!receiverPhone) {
      return res.status(400).json({ message: 'receiverPhone is required.' });
    }

    receiverPhone = await assertValidCallReceiver({
      threadType,
      threadId,
      callerPhone: phone,
      receiverPhone,
    });

    // ساعات الدوام تخصّ المتاجر فقط. رقم الكابتن قد يكون مسجّلاً كتاجر أيضاً،
    // فلا يجوز أن يحجب متجره المغلق مكالمة رحلة تكسي أو محادثة دعم.
    if (MERCHANT_HOURS_THREAD_TYPES.has(threadType)) {
      const merchantProfile = await getMerchantProfile(receiverPhone);
      if (merchantProfile) {
        const callCheck = merchantAcceptsCustomerCalls(merchantProfile);
        if (!callCheck.allowed) {
          return res.status(403).json({ message: callCheck.messageAr });
        }
      }
    }

    const session = buildCallSession(threadType, threadId, phone);

    let callLog;
    try {
      callLog = await createOutgoingCallLog({
        threadType,
        threadId,
        callerPhone: phone,
        receiverPhone,
        callerName,
        channelName: session.channelName,
      });
    } catch (logError) {
      const reason = String(logError?.message || logError || 'call_log_failed');
      console.error('call log create error:', reason);
      throw new Error(`Call logging unavailable: ${reason}`);
    }

    let pushResult = { sent: 0, reason: 'not_sent' };
    try {
      pushResult = await notifyIncomingCall(receiverPhone, {
        threadType,
        threadId,
        channelName: session.channelName,
        callerName,
        callerPhone: phone,
        callLogId: callLog?.id || null,
      });
      if (!pushResult?.sent) {
        console.warn(
          'incoming call push not delivered:',
          receiverPhone,
          pushResult?.reason || 'unknown'
        );
      }
    } catch (err) {
      console.error('incoming call push error:', err?.message || err);
      pushResult = { sent: 0, reason: err?.message || 'push_error' };
    }

    return res.json({
      ...session,
      receiverPhone,
      callerName,
      callLogId: callLog.id,
      callLogCreated: true,
      callLogError: null,
      pushDelivered: (pushResult?.sent || 0) > 0,
      pushReason: pushResult?.sent ? null : pushResult?.reason || 'no_tokens',
      pushTokenCount: pushResult?.sent || 0,
    });
  } catch (error) {
    console.error('voice call error:', error);
    const message = String(error?.message || 'Failed to start call.');
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('Invalid call receiver')
        ? 400
      : message.includes('Call logging unavailable')
        ? 503
      : message.includes('not configured')
        ? 503
        : 500;
    return res.status(status).json({ message });
  }
});

module.exports = router;
