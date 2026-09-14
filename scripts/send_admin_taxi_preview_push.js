/**
 * معاينة إشعار طلب الادمن كما يظهر للكابتن.
 *   railway run -- node scripts/send_admin_taxi_preview_push.js 07744009992
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDeviceTokensForPhone, removeDeviceTokens } = require('../supabase_repo');
const { sendPushToTokensDirect } = require('../services/notification_delivery');

async function main() {
  const phone = String(process.argv[2] || '07744009992').trim();
  const rows = await getDeviceTokensForPhone(phone);
  const tokens = rows.map((r) => String(r.token || '').trim()).filter(Boolean);
  if (!tokens.length) {
    console.error('لا يوجد توكن لهذا الرقم.');
    process.exit(2);
  }

  const requestId = `preview-admin-${Date.now()}`;
  const title = '🚕 طلب تكسي · الادمن — ذهاب فقط';
  const body = 'الادمن — افتح التطبيق لعرض التفاصيل.';

  console.log('إرسال معاينة إشعار الادمن إلى', phone);
  console.log('العنوان:', title);
  console.log('النص:', body);

  const result = await sendPushToTokensDirect(tokens, {
    title,
    body,
    data: {
      category: 'taxi',
      audience: 'driver',
      eventKey: 'taxi:pool_new',
      orderId: requestId,
      requestId,
      isAdminCustomer: '1',
      taxiType: 'economic',
      title,
      body,
    },
    showSystemBanner: true,
  });

  if (result.invalidTokens?.length) {
    await removeDeviceTokens(result.invalidTokens);
  }

  console.log('النتيجة:', {
    sent: result.sent,
    failed: result.failed,
    invalidTokens: result.invalidTokens?.length || 0,
  });
  process.exit(Number(result.sent) > 0 ? 0 : 3);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
