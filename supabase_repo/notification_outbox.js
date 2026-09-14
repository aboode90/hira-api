const { v4: uuidv4 } = require('uuid');
const { assertSupabaseAdmin, nowIso } = require('./common');

async function insertOutboxRow(row) {
  const supabase = assertSupabaseAdmin();
  const payload = {
    id: row.id || uuidv4(),
    event_key: String(row.event_key || row.eventKey || '').trim(),
    audience_role: String(row.audience_role || row.audienceRole || 'customer').trim(),
    target_phone: row.target_phone || row.targetPhone || null,
    fcm_tokens: Array.isArray(row.fcm_tokens || row.fcmTokens)
      ? row.fcm_tokens || row.fcmTokens
      : [],
    title: String(row.title || 'طلب').trim(),
    body: String(row.body || '').trim(),
    data: row.data && typeof row.data === 'object' ? row.data : {},
    status: 'pending',
    attempts: 0,
    scheduled_at: row.scheduled_at || row.scheduledAt || nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { data, error } = await supabase
    .from('notification_outbox')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function claimPendingOutboxBatch(limit = 25) {
  const supabase = assertSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from('notification_outbox')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', nowIso())
    .order('scheduled_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  if (!rows?.length) return [];

  const ids = rows.map((row) => row.id);
  const { error: updateError } = await supabase
    .from('notification_outbox')
    .update({ status: 'processing', updated_at: nowIso() })
    .eq('status', 'pending')
    .in('id', ids);
  if (updateError) throw new Error(updateError.message);
  return rows;
}

async function markOutboxSent(id) {
  const supabase = assertSupabaseAdmin();
  await supabase
    .from('notification_outbox')
    .update({
      status: 'sent',
      sent_at: nowIso(),
      updated_at: nowIso(),
      last_error: null,
    })
    .eq('id', id);
}

async function markOutboxFailed(id, message, attempts) {
  const supabase = assertSupabaseAdmin();
  const nextAttempts = Number(attempts || 0) + 1;
  const retry = nextAttempts < 5;
  await supabase
    .from('notification_outbox')
    .update({
      status: retry ? 'pending' : 'failed',
      attempts: nextAttempts,
      last_error: String(message || '').slice(0, 500),
      scheduled_at: retry
        ? new Date(Date.now() + Math.min(nextAttempts * 30_000, 300_000)).toISOString()
        : nowIso(),
      updated_at: nowIso(),
    })
    .eq('id', id);
}

module.exports = {
  insertOutboxRow,
  claimPendingOutboxBatch,
  markOutboxSent,
  markOutboxFailed,
};
