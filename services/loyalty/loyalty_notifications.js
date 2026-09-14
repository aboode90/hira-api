const { randomUUID } = require('crypto');
const { nowIso } = require('../../supabase_repo/common');

/**
 * إشعار داخلي + Push عند منح نقاط ترقية (لا تُستخدم كخصم).
 */
async function notifyLoyaltyPointsAwarded({
  phone,
  points,
  type,
  referenceId,
  levelUp = false,
  newLevel,
  lifetimePoints,
}) {
  const phoneKey = String(phone || '').trim();
  if (!phoneKey || !points) return;

  const typeLabel = type === 'taxi' ? 'رحلة التاكسي' : 'الطلب';
  const title = 'نقاط ترقية — حيرة';
  let body = `تم إضافة ${points} نقطة لحسابك بسبب إكمال ${typeLabel}.`;
  if (levelUp && newLevel) {
    body += ` مبروك! وصلت للمستوى ${newLevel}.`;
  }
  if (lifetimePoints != null) {
    body += ` رصيد نقاطك: ${lifetimePoints}.`;
  }

  const eventKey = `loyalty:points:${referenceId || randomUUID()}`;

  try {
    const { insertUserNotificationsBulk } = require('../../supabase_repo/user_notifications');
    await insertUserNotificationsBulk([
      {
        phone: phoneKey,
        title,
        body,
        audience: 'customer',
        category: 'loyalty',
        event_key: eventKey,
        is_read: false,
        created_at: nowIso(),
      },
    ]);
  } catch (error) {
    console.warn(
      'loyalty in-app notification skipped:',
      error?.message || error,
    );
  }

  try {
    const { sendPushToPhone, buildPushPayload } = require('../../push_events');
    await sendPushToPhone(
      phoneKey,
      buildPushPayload({
        title,
        body,
        audience: 'customer',
        eventKey,
        category: 'loyalty',
      }),
      { showSystemBanner: true, immediate: true },
    );
  } catch (error) {
    console.warn('loyalty push notification skipped:', error?.message || error);
  }
}

module.exports = {
  notifyLoyaltyPointsAwarded,
};
