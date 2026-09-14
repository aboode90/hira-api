const { assertSupabaseAdmin } = require('../supabase_repo/common');
const { deleteR2ObjectsByUrl } = require('./r2_storage');

const CHAT_IMAGE_TTL_MS = 48 * 60 * 60 * 1000;

async function deleteChatImageByUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return;

  await deleteR2ObjectsByUrl(trimmed);

  const supabase = assertSupabaseAdmin();
  const folderKey = trimmed.split('/chat/')[1]?.split('/')[0];
  if (folderKey) {
    await supabase.from('media_assets').delete().ilike('url', `%/chat/${folderKey}/%`);
  }
  await supabase.from('media_assets').delete().eq('url', trimmed);
}

async function purgeExpiredChatImages({ batchSize = 200 } = {}) {
  const supabase = assertSupabaseAdmin();
  const cutoff = new Date(Date.now() - CHAT_IMAGE_TTL_MS).toISOString();

  const { data: rows, error } = await supabase
    .from('chat_messages')
    .select('id, content, message_type, created_at')
    .eq('message_type', 'image')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    if (/does not exist/i.test(error.message || '')) {
      return { deleted: 0, skipped: true };
    }
    throw new Error(error.message);
  }

  const list = rows || [];
  if (list.length === 0) return { deleted: 0 };

  for (const row of list) {
    try {
      await deleteChatImageByUrl(row.content);
    } catch (cleanupError) {
      console.warn('chat image asset cleanup:', cleanupError?.message || cleanupError);
    }
  }

  const ids = list.map((row) => row.id);
  const { error: deleteError } = await supabase.from('chat_messages').delete().in('id', ids);
  if (deleteError) throw new Error(deleteError.message);

  return { deleted: ids.length };
}

module.exports = {
  CHAT_IMAGE_TTL_MS,
  deleteChatImageByUrl,
  purgeExpiredChatImages,
};
