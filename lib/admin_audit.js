'use strict';

const { randomUUID } = require('crypto');
const { assertSupabaseAdmin, nowIso } = require('../supabase_repo/common');

const FALLBACK_KEY = 'admin_audit_logs';
const FALLBACK_LIMIT = 400;
const TABLE_MISSING = /does not exist|schema cache|could not find the table/i;

function buildEntry({
  actorPhone,
  action,
  entityType,
  entityId,
  summaryAr,
  details,
}) {
  return {
    id: randomUUID(),
    actor_phone: String(actorPhone || '').trim() || null,
    action: String(action || 'unknown').trim(),
    entity_type: String(entityType || 'unknown').trim(),
    entity_id: String(entityId || '').trim() || null,
    summary_ar: String(summaryAr || '').trim() || null,
    details: details && typeof details === 'object' ? details : {},
    created_at: nowIso(),
  };
}

async function appendFallback(entry) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('app_configs')
    .select('value')
    .eq('key', FALLBACK_KEY)
    .maybeSingle();
  if (error && !TABLE_MISSING.test(error.message || '')) {
    console.warn('admin audit fallback read:', error.message || error);
  }
  const items = Array.isArray(data?.value?.items) ? data.value.items : [];
  items.unshift(entry);
  const { error: writeError } = await supabase.from('app_configs').upsert(
    {
      key: FALLBACK_KEY,
      value: { items: items.slice(0, FALLBACK_LIMIT) },
      label: 'سجل تدقيق الإدارة',
      updated_at: nowIso(),
    },
    { onConflict: 'key' },
  );
  if (writeError) {
    console.warn('admin audit fallback write:', writeError.message || writeError);
  }
}

async function recordAdminAudit(payload) {
  try {
    const entry = buildEntry(payload || {});
    const supabase = assertSupabaseAdmin();
    const { error } = await supabase.from('admin_audit_logs').insert(entry);
    if (!error) return entry;
    if (!TABLE_MISSING.test(error.message || '')) {
      console.warn('admin audit insert:', error.message || error);
    }
    await appendFallback(entry);
    return entry;
  } catch (error) {
    console.warn('admin audit failed:', error?.message || error);
    return null;
  }
}

function mapRow(row) {
  return {
    id: row.id,
    actorPhone: row.actor_phone || row.actorPhone || '',
    action: row.action || '',
    entityType: row.entity_type || row.entityType || '',
    entityId: row.entity_id || row.entityId || '',
    summaryAr: row.summary_ar || row.summaryAr || '',
    details: row.details && typeof row.details === 'object' ? row.details : {},
    createdAt: row.created_at || row.createdAt || null,
  };
}

async function listAdminAuditLogs(query = {}) {
  const entityType = String(query.entityType || '').trim();
  const entityId = String(query.entityId || '').trim();
  const limit = Math.min(Math.max(Number(query.limit) || 80, 1), 200);
  const supabase = assertSupabaseAdmin();

  try {
    let request = supabase
      .from('admin_audit_logs')
      .select('id, actor_phone, action, entity_type, entity_id, summary_ar, details, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (entityType) request = request.eq('entity_type', entityType);
    if (entityId) request = request.eq('entity_id', entityId);
    const { data, error } = await request;
    if (!error) {
      return (data || []).map(mapRow);
    }
    if (!TABLE_MISSING.test(error.message || '')) {
      throw new Error(error.message);
    }
  } catch (error) {
    if (!TABLE_MISSING.test(error.message || '')) {
      throw error;
    }
  }

  const { data } = await supabase
    .from('app_configs')
    .select('value')
    .eq('key', FALLBACK_KEY)
    .maybeSingle();
  let items = Array.isArray(data?.value?.items) ? data.value.items : [];
  if (entityType) {
    items = items.filter((row) => String(row.entity_type || '') === entityType);
  }
  if (entityId) {
    items = items.filter((row) => String(row.entity_id || '') === entityId);
  }
  return items.slice(0, limit).map(mapRow);
}

module.exports = {
  recordAdminAudit,
  listAdminAuditLogs,
};
