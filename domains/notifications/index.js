const { startPushScheduler } = require('../../push_scheduler');
const { startNotificationWorker } = require('../../services/notification_queue');
const { startTokenHealthScheduler } = require('../../services/token_health_scheduler');

module.exports = {
  id: 'notifications',
  mountPath: null,
  router: null,
  repository: {
    push: require('../../supabase_repo/push_notifications'),
    outbox: require('../../supabase_repo/notification_outbox'),
  },
  push: {
    events: require('../../push_events'),
    taxiEvents: require('../../push/taxi_push_events'),
    queue: require('../../services/notification_queue'),
  },
  startWorkers() {
    startNotificationWorker();
    // Auto-cancel / reminders are business logic — must run even if FCM is offline.
    startPushScheduler();
    // فحص التوكنات القديمة ورصد المتصلين بلا توكن — كل 12 ساعة.
    startTokenHealthScheduler();
  },
};