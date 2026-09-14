const { v4: uuidv4 } = require('uuid');
const {
  selectMany,
  saveRow,
  nowIso,
  assertSupabaseAdmin,
} = require('./common');

async function listMediaAssets(ownerType, ownerId, role) {
  const filters = [
    { method: 'eq', column: 'owner_type', value: String(ownerType || '').trim() },
    { method: 'eq', column: 'owner_id', value: String(ownerId || '').trim() },
  ];
  if (role) {
    filters.push({ method: 'eq', column: 'role', value: String(role).trim() });
  }
  return selectMany('media_assets', filters, { column: 'variant', ascending: true }, 20);
}

async function saveMediaAssetRow(row) {
  return saveRow(
    'media_assets',
    {
      ...row,
      updated_at: nowIso(),
    },
    'id'
  );
}

async function upsertMediaVariant({
  assetId,
  ownerType,
  ownerId,
  role,
  variant,
  url,
  width,
  height,
  bytes,
}) {
  const supabase = assertSupabaseAdmin();
  const payload = {
    id: assetId || uuidv4(),
    owner_type: ownerType,
    owner_id: ownerId,
    role,
    variant,
    url,
    width: width ?? null,
    height: height ?? null,
    bytes: bytes ?? null,
    updated_at: nowIso(),
  };
  const { data, error } = await supabase
    .from('media_assets')
    .upsert(payload, { onConflict: 'owner_type,owner_id,role,variant' })
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function groupAssetsByRole(rows = []) {
  const grouped = {};
  for (const row of rows || []) {
    const role = String(row.role || 'gallery').trim();
    if (!grouped[role]) grouped[role] = {};
    grouped[role][String(row.variant || 'original').trim()] = row.url;
  }
  return grouped;
}

function pickVariantUrl(group, preferred = '256') {
  if (!group || typeof group !== 'object') return '';
  return (
    group[preferred] ||
    group['256'] ||
    group.thumbnail ||
    group['512'] ||
    group.original ||
    ''
  );
}

module.exports = {
  listMediaAssets,
  saveMediaAssetRow,
  upsertMediaVariant,
  groupAssetsByRole,
  pickVariantUrl,
};
