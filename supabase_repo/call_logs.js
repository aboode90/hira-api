const {
  assertSupabaseAdmin,
  resolvePhoneKey,
  phonesOverlap,
  getPhoneVariants,
} = require('./common');
const { appendCallChatEvent } = require('./chat');

function formatCallLog(row) {
  return {
    id: row.id,
    thread_type: row.thread_type,
    thread_id: row.thread_id,
    caller_phone: row.caller_phone,
    receiver_phone: row.receiver_phone,
    caller_name: row.caller_name,
    channel_name: row.channel_name,
    direction: row.direction,
    status: row.status,
    duration_seconds: row.duration_seconds ?? 0,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

function mapCallDbError(error) {
  const message = String(error?.message || error || '').trim();
  if (
    message.includes('voice_call_logs') &&
    (message.includes('does not exist') ||
      message.includes('schema cache') ||
      message.includes('Could not find'))
  ) {
    return 'جدول سجل المكالمات غير منشأ في Supabase. نفّذ ملف supabase/voice_call_logs.sql.';
  }
  return message || 'Failed to save call log.';
}

async function resolveRingingCallLog({
  callLogId,
  channelName,
  requestPhone,
  threadType,
  threadId,
}) {
  const phone = await resolvePhoneKey(requestPhone);
  const supabase = assertSupabaseAdmin();
  const id = String(callLogId || '').trim();
  const channel = String(channelName || '').trim();

  if (id) {
    const { data, error } = await supabase
      .from('voice_call_logs')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(mapCallDbError(error));
    if (
      data &&
      (phonesOverlap(phone, data.caller_phone) ||
        phonesOverlap(phone, data.receiver_phone))
    ) {
      return data;
    }
  }

  if (channel) {
    const { data: rows, error } = await supabase
      .from('voice_call_logs')
      .select('*')
      .eq('channel_name', channel)
      .eq('status', 'ringing')
      .order('started_at', { ascending: false })
      .limit(5);
    if (error) throw new Error(mapCallDbError(error));
    const match = (rows || []).find(
      (item) =>
        phonesOverlap(phone, item.receiver_phone) ||
        phonesOverlap(phone, item.caller_phone),
    );
    if (match) return match;
  }

  const type = String(threadType || '').trim();
  const tid = String(threadId || '').trim();
  if (type && tid) {
    const { data: rows, error } = await supabase
      .from('voice_call_logs')
      .select('*')
      .eq('thread_type', type)
      .eq('thread_id', tid)
      .eq('status', 'ringing')
      .order('started_at', { ascending: false })
      .limit(3);
    if (error) throw new Error(mapCallDbError(error));
    const match = (rows || []).find((item) => phonesOverlap(phone, item.receiver_phone));
    if (match) return match;
  }

  return null;
}

async function resolveActiveCallLog({
  callLogId,
  channelName,
  requestPhone,
  threadType,
  threadId,
}) {
  const ringing = await resolveRingingCallLog({
    callLogId,
    channelName,
    requestPhone,
    threadType,
    threadId,
  });
  if (ringing) return ringing;

  const phone = await resolvePhoneKey(requestPhone);
  const channel = String(channelName || '').trim();
  if (!channel) return null;

  const supabase = assertSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('voice_call_logs')
    .select('*')
    .eq('channel_name', channel)
    .in('status', ['connected', 'ringing'])
    .order('started_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(mapCallDbError(error));
  return (rows || []).find(
    (item) =>
      phonesOverlap(phone, item.receiver_phone) ||
      phonesOverlap(phone, item.caller_phone),
  ) || null;
}

async function rejectCallLog({
  callLogId,
  channelName,
  requestPhone,
  threadType,
  threadId,
}) {
  const phone = await resolvePhoneKey(requestPhone);
  const existing = await resolveRingingCallLog({
    callLogId,
    channelName,
    requestPhone,
    threadType,
    threadId,
  });
  if (!existing) return null;
  if (!phonesOverlap(phone, existing.receiver_phone)) {
    throw new Error('Only the receiver can reject this call.');
  }
  if (existing.status !== 'ringing') return formatCallLog(existing);

  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('voice_call_logs')
    .update({
      status: 'missed',
      duration_seconds: 0,
      ended_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .eq('status', 'ringing')
    .select()
    .maybeSingle();
  if (error) throw new Error(mapCallDbError(error));
  const saved = data ? formatCallLog(data) : null;
  if (data) {
    try {
      await appendCallChatEvent(data);
    } catch (eventError) {
      console.warn('call chat event:', eventError?.message || eventError);
    }
  }
  return saved;
}

async function createOutgoingCallLog({
  threadType,
  threadId,
  callerPhone,
  receiverPhone,
  callerName,
  channelName,
}) {
  const supabase = assertSupabaseAdmin();
  const payload = {
    thread_type: threadType,
    thread_id: threadId,
    caller_phone: await resolvePhoneKey(callerPhone),
    receiver_phone: await resolvePhoneKey(receiverPhone),
    caller_name: String(callerName || '').trim() || null,
    channel_name: String(channelName || '').trim() || null,
    direction: 'outgoing',
    status: 'ringing',
  };

  const { data, error } = await supabase
    .from('voice_call_logs')
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(mapCallDbError(error));
  return formatCallLog(data);
}

async function completeCallLog({
  callLogId,
  requestPhone,
  threadType,
  threadId,
  otherPartyPhone,
  direction,
  status,
  durationSeconds,
  channelName,
}) {
  const phone = await resolvePhoneKey(requestPhone);
  const supabase = assertSupabaseAdmin();
  const normalizedStatus = String(status || 'ended').trim();
  const duration = Math.max(0, Number.parseInt(String(durationSeconds ?? 0), 10) || 0);
  const endedAt = new Date().toISOString();

  let existing = null;
  if (callLogId) {
    const { data, error: readError } = await supabase
      .from('voice_call_logs')
      .select('*')
      .eq('id', callLogId)
      .maybeSingle();
    if (readError) throw new Error(mapCallDbError(readError));
    existing = data;
  } else {
    existing = await resolveActiveCallLog({
      callLogId,
      channelName,
      requestPhone: phone,
      threadType,
      threadId,
    });
  }

  if (existing) {
    const allowed =
      phonesOverlap(phone, existing.caller_phone) ||
      phonesOverlap(phone, existing.receiver_phone);
    if (!allowed) throw new Error('Unauthorized call log access.');
    if (
      existing.ended_at &&
      ['ended', 'missed', 'no_answer', 'failed'].includes(
        String(existing.status || ''),
      )
    ) {
      return formatCallLog(existing);
    }

    const { data, error } = await supabase
      .from('voice_call_logs')
      .update({
        status: normalizedStatus,
        duration_seconds: duration,
        ended_at: endedAt,
      })
      .eq('id', existing.id)
      .eq('status', existing.status)
      .is('ended_at', null)
      .select()
      .maybeSingle();
    if (error) throw new Error(mapCallDbError(error));
    if (!data) {
      const { data: latest, error: latestError } = await supabase
        .from('voice_call_logs')
        .select('*')
        .eq('id', existing.id)
        .maybeSingle();
      if (latestError) throw new Error(mapCallDbError(latestError));
      return latest ? formatCallLog(latest) : null;
    }
    const saved = formatCallLog(data);
    try {
      await appendCallChatEvent(data);
    } catch (eventError) {
      console.warn('call chat event:', eventError?.message || eventError);
    }
    return saved;
  }

  // لا تنشئ سجلاً من طلب complete؛ السجل يجب أن يُنشأ حصراً عند بدء المكالمة.
  // هذا يمنع تزوير سجلات بأرقام عشوائية عند غياب callLogId.
  throw new Error('Call log not found.');
}

async function expireStaleRingingCallLogs({ olderThanSeconds = 45 } = {}) {
  const seconds = Math.max(30, Number.parseInt(String(olderThanSeconds), 10) || 45);
  const cutoff = new Date(Date.now() - seconds * 1000).toISOString();
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('voice_call_logs')
    .update({
      status: 'no_answer',
      duration_seconds: 0,
      ended_at: new Date().toISOString(),
    })
    .eq('status', 'ringing')
    .lt('started_at', cutoff)
    .select();
  if (error) throw new Error(mapCallDbError(error));

  for (const row of data || []) {
    try {
      await appendCallChatEvent(row);
    } catch (eventError) {
      console.warn('expired call chat event:', eventError?.message || eventError);
    }
  }
  return (data || []).map(formatCallLog);
}

async function getCallLogStatus({ callLogId, requestPhone }) {
  const phone = await resolvePhoneKey(requestPhone);
  const supabase = assertSupabaseAdmin();
  const id = String(callLogId || '').trim();
  if (!id) throw new Error('callLogId is required.');

  const { data: existing, error } = await supabase
    .from('voice_call_logs')
    .select('id, status, started_at, caller_phone, receiver_phone, channel_name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(mapCallDbError(error));
  if (!existing) throw new Error('Call log not found.');

  const allowed =
    phonesOverlap(phone, existing.caller_phone) ||
    phonesOverlap(phone, existing.receiver_phone);
  if (!allowed) throw new Error('Unauthorized call log access.');

  return {
    id: existing.id,
    status: existing.status,
    started_at: existing.started_at,
    channel_name: existing.channel_name,
  };
}

async function markCallConnected({ callLogId, channelName, requestPhone }) {
  const phone = await resolvePhoneKey(requestPhone);
  const supabase = assertSupabaseAdmin();
  const id = String(callLogId || '').trim();
  const channel = String(channelName || '').trim();

  let query = supabase.from('voice_call_logs').select('*').eq('status', 'ringing');
  if (id) {
    query = query.eq('id', id);
  } else if (channel) {
    query = query.eq('channel_name', channel);
  } else {
    return null;
  }

  const { data: rows, error: readError } = await query
    .order('started_at', { ascending: false })
    .limit(5);
  if (readError) throw new Error(mapCallDbError(readError));

  const row = (rows || []).find((item) => phonesOverlap(phone, item.receiver_phone));
  if (!row) return null;

  const { data, error } = await supabase
    .from('voice_call_logs')
    .update({ status: 'connected' })
    .eq('id', row.id)
    .eq('status', 'ringing')
    .select()
    .maybeSingle();
  if (error) throw new Error(mapCallDbError(error));
  const saved = data ? formatCallLog(data) : null;
  if (data) {
    try {
      await appendCallChatEvent(data);
    } catch (eventError) {
      console.warn('call chat event:', eventError?.message || eventError);
    }
  }
  return saved;
}

async function getCallHistory(requestPhone, { threadType, threadId, limit = 30 } = {}) {
  const phone = await resolvePhoneKey(requestPhone);
  const variants = getPhoneVariants(phone);
  if (variants.length === 0) return [];

  const supabase = assertSupabaseAdmin();
  const max = Math.min(Math.max(Number.parseInt(String(limit || 30), 10) || 30, 1), 50);
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let sentQuery = supabase
    .from('voice_call_logs')
    .select('*')
    .in('caller_phone', variants)
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(max);

  let receivedQuery = supabase
    .from('voice_call_logs')
    .select('*')
    .in('receiver_phone', variants)
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(max);

  if (threadType && threadId) {
    const type = String(threadType).trim();
    const id = String(threadId).trim();
    sentQuery = sentQuery.eq('thread_type', type).eq('thread_id', id);
    receivedQuery = receivedQuery.eq('thread_type', type).eq('thread_id', id);
  }

  const [sentResult, receivedResult] = await Promise.all([sentQuery, receivedQuery]);
  const error = sentResult.error || receivedResult.error;
  if (error) throw new Error(mapCallDbError(error));

  const combined = [...(sentResult.data || []), ...(receivedResult.data || [])];
  combined.sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  const seen = new Set();
  const unique = [];
  for (const row of combined) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(formatCallLog(row));
    if (unique.length >= max) break;
  }
  return unique;
}

module.exports = {
  createOutgoingCallLog,
  completeCallLog,
  getCallLogStatus,
  markCallConnected,
  rejectCallLog,
  expireStaleRingingCallLogs,
  getCallHistory,
};
