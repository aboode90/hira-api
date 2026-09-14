const logger = require('../lib/logger');
const { purgeExpiredChatImages } = require('./chat_media_cleanup');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let running = false;

async function runChatCleanupTick() {
  if (running) return;
  running = true;
  try {
    let totalDeleted = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      const result = await purgeExpiredChatImages({ batchSize: 200 });
      if (result.skipped) break;
      totalDeleted += result.deleted || 0;
      if ((result.deleted || 0) < 200) break;
    }
    if (totalDeleted > 0) {
      logger.info(`Chat image cleanup removed ${totalDeleted} expired image(s).`);
    }
  } catch (error) {
    logger.warn('Chat image cleanup failed:', error?.message || error);
  } finally {
    running = false;
  }
}

function startChatScheduler() {
  setTimeout(() => {
    runChatCleanupTick().catch(() => {});
  }, 30_000);
  setInterval(runChatCleanupTick, CLEANUP_INTERVAL_MS);
  logger.info('Chat scheduler started (image TTL 48h).');
}

module.exports = {
  startChatScheduler,
  runChatCleanupTick,
};
