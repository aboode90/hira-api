const logger = require('../lib/logger');
const { expireStalePendingTaxiRequests } = require('../supabase_repo/taxi');
const {
  maybeExpireDueBazaarReturnTrips,
  remindDriversToCompleteTrips,
  runExpandingSearchWaves,
} = require('../domains/taxi/repository/taxi');
const { expireStaleOnlineDrivers } = require('../domains/taxi/repository/driver_locations');
const { runDeliveryExpandingSearchWaves } = require('../supabase_repo/orders');

const TAXI_SCHEDULER_INTERVAL_MS = 30 * 1000;
const COMPLETION_REMINDER_INTERVAL_MS = 5 * 60 * 1000; // فحص التذكير كل 5 دقائق
const STALE_DRIVER_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // كل 30 دقيقة
let running = false;
let staleDriverCleanupTimer = null;
let completionReminderTimer = null;

async function runTaxiSchedulerTick() {
  try {
    const expired = await expireStalePendingTaxiRequests();
    if (expired > 0) {
      logger.info(`Taxi scheduler: auto-cancelled ${expired} stale pending request(s)`);
    }
  } catch (error) {
    logger.error('Taxi scheduler tick failed:', error?.message || error);
  }

  try {
    const waves = await runExpandingSearchWaves();
    if (waves > 0) {
      logger.info(`Taxi scheduler: expanding-search waves notified for ${waves} request(s)`);
    }
  } catch (error) {
    logger.error('Taxi expanding-search waves failed:', error?.message || error);
  }

  try {
    const deliveryWaves = await runDeliveryExpandingSearchWaves();
    if (deliveryWaves > 0) {
      logger.info(
        `Taxi scheduler: delivery expanding-search waves notified for ${deliveryWaves} order(s)`,
      );
    }
  } catch (error) {
    logger.error('Delivery expanding-search waves failed:', error?.message || error);
  }

  try {
    await maybeExpireDueBazaarReturnTrips();
  } catch (error) {
    logger.error('Taxi scheduler bazaar expire failed:', error?.message || error);
  }
}

async function runStaleDriverCleanup() {
  try {
    await expireStaleOnlineDrivers();
    logger.info('Taxi scheduler: stale online drivers cleanup completed');
  } catch (error) {
    logger.error('Taxi scheduler stale driver cleanup failed:', error?.message || error);
  }
}

async function runCompletionReminder() {
  try {
    const sent = await remindDriversToCompleteTrips();
    if (sent > 0) {
      logger.info(`Taxi scheduler: sent ${sent} trip completion reminder(s)`);
    }
  } catch (error) {
    logger.error('Taxi scheduler completion reminder failed:', error?.message || error);
  }
}

function startTaxiScheduler() {
  if (running) return;
  running = true;
  void runTaxiSchedulerTick();
  setInterval(runTaxiSchedulerTick, TAXI_SCHEDULER_INTERVAL_MS);

  // تذكير الكباتن بإنهاء الرحلات القديمة (بعد 30 دقيقة) كل 5 دقائق
  void runCompletionReminder();
  completionReminderTimer = setInterval(
    runCompletionReminder,
    COMPLETION_REMINDER_INTERVAL_MS
  );

  // تنظيف السائقين الخاملين كل 30 دقيقة
  void runStaleDriverCleanup();
  staleDriverCleanupTimer = setInterval(runStaleDriverCleanup, STALE_DRIVER_CLEANUP_INTERVAL_MS);

  logger.info('Taxi scheduler started');
}

module.exports = { startTaxiScheduler, runTaxiSchedulerTick };
