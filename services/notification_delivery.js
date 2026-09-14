const admin = require('firebase-admin');
const {
  ANDROID_NOTIFICATION_CHANNEL_ID,
  ANDROID_TAXI_REQUEST_CHANNEL_ID,
  ANDROID_INCOMING_CALL_CHANNEL_ID,
  ANDROID_NOTIFICATION_SOUND,
  ANDROID_INCOMING_CALL_SOUND,
  IOS_NOTIFICATION_SOUND,
  IOS_INCOMING_CALL_SOUND,
  isPushConfigured,
  initFirebaseAdmin,
} = require('../push_notifications');

function normalizeData(data = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (key === 'showSystemBanner') continue;
    normalized[String(key)] = String(value);
  }
  return normalized;
}

const FCM_BATCH_SIZE = 500;

async function sendPushToTokensDirect(
  tokens,
  { title, body, data = {}, showSystemBanner = false, dataOnly = false } = {}
) {
  const uniqueTokens = [
    ...new Set((tokens || []).map((item) => String(item || '').trim()).filter(Boolean)),
  ];
  if (!uniqueTokens.length) {
    return { sent: 0, failed: 0, invalidTokens: [] };
  }
  if (!initFirebaseAdmin()) {
    return { sent: 0, failed: uniqueTokens.length, invalidTokens: [], skipped: true };
  }

  if (!uniqueTokens.length) return { sent: 0, failed: 0, invalidTokens: [] };

  const messaging = admin.messaging();
  const safeTitle = String(title || 'طلب').trim();
  const safeBody = String(body || '').trim();
  const category = String(data?.category ?? '').trim();
  const eventKey = String(data?.eventKey ?? '').trim();
  const audienceRole = String(data?.audience ?? '').trim();
  const orderId = String(data?.orderId ?? '').trim();
  const isIncomingCall =
    category === 'call' || eventKey === 'call:incoming';
  const isTaxiCustomerStatus =
    category === 'taxi' &&
    audienceRole !== 'driver' &&
    eventKey.startsWith('taxi:');
  // طلبات الكابتن + مراحل رحلة الزبون — قناة تكسي عالية الأهمية حتى يظهر إشعار خارجي.
  const isTaxiRequest =
    category === 'taxi' &&
    (eventKey === 'taxi:pool_new' ||
      eventKey === 'taxi:pool_returned' ||
      eventKey === 'taxi:test_push' ||
      audienceRole === 'driver' ||
      isTaxiCustomerStatus);
  const isDeliveryPool =
    category === 'delivery' &&
    (eventKey.includes(':pool_new') || eventKey.includes(':pool_returned'));
  // إشعارات الكابتن تذهب data-only على أندرويد (بلا إشعار نظام جاهز)
  // حتى يبني التطبيق إشعاره المحلي بأزرار قبول/رفض حتى في الخلفية.
  const isTaxiDriver = isTaxiRequest && audienceRole === 'driver';
  const wantsBanner = !dataOnly &&
    (showSystemBanner ||
      isIncomingCall ||
      isTaxiRequest ||
      ['courier', 'driver', 'delivery'].includes(audienceRole) ||
      category === 'order' ||
      category === 'delivery');

  function buildBatchMessage(batchTokens) {
    // TTL طويل حتى لا تموت الرسالة قبل التوصيل أثناء Doze/انقطاع مؤقت:
    // التكسي/التوصيل 10 دقائق، الباقي ساعة (كانت 180/45 ثانية فتقتل الرسائل).
    const ttlSeconds = isTaxiRequest || isDeliveryPool ? 600 : 3600;
    const apnsHeaders = {
      // APNs expects an absolute Unix timestamp, not a relative TTL.
      'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds),
    };
    if (orderId && !isTaxiRequest) {
      apnsHeaders['apns-collapse-id'] = orderId;
    }
    const apnsAps = {
      'content-available': 1,
    };

    if (wantsBanner) {
      apnsHeaders['apns-priority'] = '10';
      apnsHeaders['apns-push-type'] = 'alert';
      apnsAps.alert = { title: safeTitle, body: safeBody };
      apnsAps.sound = isIncomingCall ? IOS_INCOMING_CALL_SOUND : IOS_NOTIFICATION_SOUND;
      apnsAps.badge = 1;
      apnsAps.mutableContent = 1;
      if (isIncomingCall || isTaxiDriver) {
        apnsAps['interruption-level'] = 'time-sensitive';
      }
    } else {
      apnsHeaders['apns-priority'] = '5';
      apnsHeaders['apns-push-type'] = 'background';
    }

    const msg = {
      tokens: batchTokens,
      data: normalizeData({
        ...data,
        title: safeTitle,
        body: safeBody,
      }),
      android: {
        priority: 'high',
        ttl: isTaxiRequest || isDeliveryPool ? 600000 : 3600000,
      },
      apns: {
        headers: apnsHeaders,
        payload: {
          aps: apnsAps,
        },
      },
    };

    // إشعار نظام لأي رسالة يريدها بانر — بما فيها طلبات التكسي للكابتن.
    // سابقاً كانت طلبات التكسي data-only على أندرويد، فلم يظهر إشعار نظام
    // عندما يكون تطبيق الكابتن في الخلفية/مغلقاً (فيفوته الطلب).
    // التطبيق يبني إشعاره المحلي فقط عند غياب إشعار النظام (message.notification == null).
    if (wantsBanner) {
      msg.notification = { title: safeTitle, body: safeBody };
      msg.android.notification = {
        channelId: isIncomingCall
          ? ANDROID_INCOMING_CALL_CHANNEL_ID
          : isTaxiRequest
            ? ANDROID_TAXI_REQUEST_CHANNEL_ID
          : ANDROID_NOTIFICATION_CHANNEL_ID,
        sound: isIncomingCall ? ANDROID_INCOMING_CALL_SOUND : ANDROID_NOTIFICATION_SOUND,
        priority: isIncomingCall || isTaxiRequest ? 'max' : 'high',
        visibility: isIncomingCall || isTaxiRequest ? 'public' : 'private',
        defaultVibrateTimings: isIncomingCall || isTaxiRequest,
        notificationCount: isIncomingCall || isTaxiRequest ? 1 : undefined,
      };
      if (isTaxiCustomerStatus) {
        msg.android.notification.tag = `${eventKey}:${orderId || Date.now()}`;
      }
      if (isIncomingCall) {
        msg.android.collapseKey = 'hira_incoming_call';
        msg.android.ttl = 120000;
      }
      if (orderId && !isTaxiRequest) {
        msg.android.collapseKey = `order_${orderId}`;
      }
      // لا نستخدم collapseKey مشتركاً لطلبات التكسي حتى لا يُستبدل إشعار بآخر.
    }
    return msg;
  }

  let totalSent = 0;
  let totalFailed = 0;
  const allInvalidTokens = [];
  const errors = [];

  for (let i = 0; i < uniqueTokens.length; i += FCM_BATCH_SIZE) {
    const batch = uniqueTokens.slice(i, i + FCM_BATCH_SIZE);
    try {
      const response = await messaging.sendEachForMulticast(buildBatchMessage(batch));
      totalSent += response.successCount;
      totalFailed += response.failureCount;
      response.responses.forEach((item, index) => {
        if (item.success) return;
        const code = item.error?.code || '';
        const message = item.error?.message || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid')) {
          allInvalidTokens.push(batch[index]);
        }
        errors.push({ index, code, message });
      });
    } catch (batchError) {
      console.error('push: FCM batch send error:', batchError?.message || batchError);
      totalFailed += batch.length;
    }
  }

  return {
    sent: totalSent,
    failed: totalFailed,
    invalidTokens: allInvalidTokens,
    errors,
  };
}

module.exports = {
  sendPushToTokensDirect,
};
