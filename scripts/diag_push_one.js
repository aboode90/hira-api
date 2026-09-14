/**
 * تشخيص إرسال FCM لكل توكن على حدة.
 * railway run node scripts/diag_push_one.js 07855505865
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const admin = require('firebase-admin');
const { getDeviceTokensForPhone } = require('../supabase_repo');
const { initFirebaseAdmin } = require('../push_notifications');

async function main() {
  const phone = String(process.argv[2] || '').trim();
  if (!phone) {
    console.error('usage: node scripts/diag_push_one.js <phone>');
    process.exit(1);
  }
  if (!initFirebaseAdmin()) process.exit(1);

  const rows = await getDeviceTokensForPhone(phone);
  console.log(`phone=${phone} tokenRows=${rows.length}`);
  const messaging = admin.messaging();

  for (const row of rows) {
    const token = String(row.token || '').trim();
    const platform = String(row.platform || 'unknown');
    console.log('\n---');
    console.log(`platform=${platform}`);
    console.log(`updated_at=${row.updated_at}`);
    console.log(`tokenPrefix=${token.slice(0, 24)}... len=${token.length}`);

    try {
      const id = await messaging.send({
        token,
        notification: {
          title: 'اختبار طلب',
          body: `اختبار مباشر ${platform} ${new Date().toISOString()}`,
        },
        android: {
          priority: 'high',
          ttl: 3600000,
          notification: {
            channelId: 'hira_orders_v1',
            sound: 'default',
            priority: 'high',
            visibility: 'public',
          },
        },
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert',
          },
          payload: {
            aps: {
              alert: {
                title: 'اختبار طلب',
                body: `اختبار مباشر ${platform}`,
              },
              sound: 'default',
              badge: 1,
            },
          },
        },
        data: {
          category: 'admin',
          eventKey: 'admin:manual_push',
          title: 'اختبار طلب',
          body: 'اختبار',
        },
      });
      console.log(`RESULT=OK messageId=${id}`);
    } catch (error) {
      console.log(`RESULT=FAIL code=${error?.code || ''} message=${error?.message || error}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
