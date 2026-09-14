const {
  insertOutboxRow,
  claimPendingOutboxBatch,
  markOutboxSent,
  markOutboxFailed,
} = require('../supabase_repo/notification_outbox');
const { sendPushToTokensDirect } = require('./notification_delivery');
const { removeDeviceTokens } = require('../supabase_repo');
const { assertSupabaseAdmin, nowIso } = require('../supabase_repo/common');

let bullQueue = null;
let bullWorker = null;

async function claimOutboxRow(id) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('notification_outbox')
    .update({ status: 'processing', updated_at: nowIso() })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .single();
  if (error) return null;
  return data || null;
}

function isQueueEnabled() {
  return Boolean(String(process.env.REDIS_URL || '').trim());
}

function getRedisConnection() {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) return null;
  return { url };
}

async function initBullMq() {
  if (!isQueueEnabled() || bullQueue) return bullQueue;
  const { Queue, Worker } = require('bullmq');
  const connection = getRedisConnection();
  bullQueue = new Queue('notification_outbox', { connection });

  bullWorker = new Worker(
    'notification_outbox',
    async (job) => {
      const outboxId = job?.data?.outboxId;
      if (outboxId) {
        const row = await claimOutboxRow(outboxId);
        if (row) await deliverOutboxRow(row);
        return;
      }
      await processOutboxBatch();
    },
    {
      connection,
      limiter: {
        max: Number.parseInt(process.env.NOTIFICATION_RATE_MAX || '500', 10),
        duration: 60_000,
      },
    }
  );

  bullWorker.on('failed', (job, error) => {
    console.error('notification worker failed:', job?.id, error?.message || error);
  });

  await bullQueue.add(
    'poll',
    {},
    {
      repeat: { every: 5_000 },
      removeOnComplete: true,
      removeOnFail: 50,
    }
  );

  return bullQueue;
}

async function enqueuePushNotification({
  tokens,
  title,
  body,
  data = {},
  targetPhone = null,
  audienceRole = 'customer',
  eventKey = '',
  showSystemBanner = false,
  skipInboxTracking = false,
}) {
  const uniqueTokens = [
    ...new Set((tokens || []).map((item) => String(item || '').trim()).filter(Boolean)),
  ];
  if (!uniqueTokens.length) {
    return { queued: false, reason: 'no_tokens' };
  }

  const row = await insertOutboxRow({
    event_key: eventKey,
    audience_role: audienceRole,
    target_phone: targetPhone,
    fcm_tokens: uniqueTokens,
    title,
    body,
    data: {
      ...data,
      showSystemBanner: showSystemBanner ? 'true' : 'false',
      skipInboxTracking: skipInboxTracking ? 'true' : 'false',
    },
  });

  if (isQueueEnabled()) {
    await initBullMq();
    await bullQueue.add('deliver', { outboxId: row.id }, { removeOnComplete: true });
    return { queued: true, outboxId: row.id, via: 'bullmq', sent: 0, failed: 0, invalidTokens: [] };
  }

  return deliverOutboxRow(row);
}

async function deliverOutboxRow(row) {
  const tokens = Array.isArray(row.fcm_tokens) ? row.fcm_tokens : [];
  const showSystemBanner = row.data?.showSystemBanner === 'true';
  try {
    const result = await sendPushToTokensDirect(tokens, {
      title: row.title,
      body: row.body,
      data: row.data || {},
      showSystemBanner,
    });
    if (result.invalidTokens?.length) {
      await removeDeviceTokens(result.invalidTokens);
    }
    if (result.sent > 0) {
      await markOutboxSent(row.id);
    } else {
      await markOutboxFailed(row.id, 'no_tokens_delivered', row.attempts);
    }
    return { ...result, queued: true, outboxId: row.id, via: 'inline' };
  } catch (error) {
    await markOutboxFailed(row.id, error?.message || String(error), row.attempts);
    throw error;
  }
}

async function processOutboxBatch() {
  const rows = await claimPendingOutboxBatch(25);
  for (const row of rows) {
    try {
      await deliverOutboxRow(row);
    } catch (error) {
      console.error('outbox deliver error:', row.id, error?.message || error);
    }
  }
  return rows.length;
}

function startNotificationWorker() {
  if (isQueueEnabled()) {
    initBullMq().catch((error) => {
      console.error('notification queue init error:', error?.message || error);
    });
    return;
  }
  const intervalMs = Number.parseInt(process.env.NOTIFICATION_POLL_MS || '5000', 10);
  setInterval(() => {
    processOutboxBatch().catch((error) => {
      console.error('notification poll error:', error?.message || error);
    });
  }, intervalMs);
}

module.exports = {
  enqueuePushNotification,
  processOutboxBatch,
  startNotificationWorker,
  isQueueEnabled,
};
