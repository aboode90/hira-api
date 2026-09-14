const admin = require('firebase-admin');

const ANDROID_NOTIFICATION_CHANNEL_ID = 'hira_orders_v1';
// قناة منفصلة لطلبات التكسي (يجب أن تطابق Flutter NotificationSound.taxiRequestChannelId).
const ANDROID_TAXI_REQUEST_CHANNEL_ID = 'hira_taxi_requests_v1';
const ANDROID_INCOMING_CALL_CHANNEL_ID = 'hira_incoming_calls_v1';
// 'default' يجعل أندرويد يستخدم صوت إشعارات النظام الافتراضي بدل صوت مخصص.
const ANDROID_NOTIFICATION_SOUND = 'default';
const ANDROID_INCOMING_CALL_SOUND = 'hira_incoming_call';
const IOS_NOTIFICATION_SOUND = 'hira_notify.wav';
const IOS_INCOMING_CALL_SOUND = 'hira_incoming_call.wav';

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return true;

  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) {
    console.error('push: FIREBASE_SERVICE_ACCOUNT_JSON env var is empty or not set. Push notifications disabled.');
    return false;
  }

  try {
    const credentials = JSON.parse(raw);
    if (!credentials?.project_id) {
      console.error('push: FIREBASE_SERVICE_ACCOUNT_JSON missing project_id.');
      return false;
    }
    if (!credentials?.client_email) {
      console.error('push: FIREBASE_SERVICE_ACCOUNT_JSON missing client_email.');
      return false;
    }
    if (!credentials?.private_key) {
      console.error('push: FIREBASE_SERVICE_ACCOUNT_JSON missing private_key.');
      return false;
    }
    admin.initializeApp({
      credential: admin.credential.cert(credentials),
    });
    initialized = true;
    console.log('push: Firebase Admin initialized successfully.', credentials.project_id);
    return true;
  } catch (error) {
    console.error('push: failed to initialize Firebase Admin:', error?.message || error);
    return false;
  }
}

function isPushConfigured() {
  return initFirebaseAdmin();
}

function normalizeData(data = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    normalized[String(key)] = String(value);
  }
  return normalized;
}

async function sendPushToTokens(
  tokens,
  { title, body, data = {}, showSystemBanner = false } = {}
) {
  const uniqueTokens = [...new Set((tokens || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!uniqueTokens.length) {
    return { sent: 0, failed: 0, invalidTokens: [] };
  }
  if (!initFirebaseAdmin()) {
    return { sent: 0, failed: uniqueTokens.length, invalidTokens: [], skipped: true };
  }

  const messaging = admin.messaging();
  const safeTitle = String(title || 'طلب').trim();
  const safeBody = String(body || '').trim();
  const message = {
    tokens: uniqueTokens,
    data: normalizeData({
      ...data,
      title: safeTitle,
      body: safeBody,
    }),
    android: {
      priority: 'high',
      ttl: 45000,
    },
    apns: {
      headers: {
        'apns-priority': showSystemBanner && safeBody ? '10' : '5',
        'apns-push-type': showSystemBanner && safeBody ? 'alert' : 'background',
      },
      payload: {
        aps: {
          'content-available': 1,
        },
      },
    },
  };

  // إشعار النظام يُضاف فقط لبعض الإشعارات المهمة (مثل تغيير الحساب).
  // باقي الإشعارات ترسل data-only، والتطبيق يعرضها بنفسه
  // عبر flutter_local_notifications بشكل صحيح مع العنوان والمحتوى.
  // لا تضع badge/sound بدون alert: آيفون يظهر شارة حمراء بلا إشعار قابل للفتح.
  if (showSystemBanner && safeBody) {
    message.notification = {
      title: safeTitle,
      body: safeBody,
    };
    message.android = {
      ...message.android,
      notification: {
        channelId: ANDROID_NOTIFICATION_CHANNEL_ID,
        sound: ANDROID_NOTIFICATION_SOUND,
      },
    };
    message.apns.payload.aps.alert = { title: safeTitle, body: safeBody };
    message.apns.payload.aps.sound = IOS_NOTIFICATION_SOUND;
    message.apns.payload.aps.badge = 1;
  }

  const response = await messaging.sendEachForMulticast(message);

  const invalidTokens = [];
  response.responses.forEach((item, index) => {
    if (item.success) return;
    const code = item.error?.code || '';
    if (
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    ) {
      invalidTokens.push(uniqueTokens[index]);
    }
  });

  return {
    sent: response.successCount,
    failed: response.failureCount,
    invalidTokens,
  };
}

module.exports = {
  isPushConfigured,
  initFirebaseAdmin,
  sendPushToTokens,
  ANDROID_NOTIFICATION_CHANNEL_ID,
  ANDROID_TAXI_REQUEST_CHANNEL_ID,
  ANDROID_INCOMING_CALL_CHANNEL_ID,
  ANDROID_NOTIFICATION_SOUND,
  ANDROID_INCOMING_CALL_SOUND,
  IOS_NOTIFICATION_SOUND,
  IOS_INCOMING_CALL_SOUND,
};
