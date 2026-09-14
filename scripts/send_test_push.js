/**
 * إرسال إشعار اختبار FCM لرقم معيّن (أندرويد أو iOS).
 *
 * الاستخدام:
 *   railway run node scripts/send_test_push.js +9647XXXXXXXXX
 *   أو محلياً مع .env:
 *   node scripts/send_test_push.js +9647XXXXXXXXX
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDeviceTokensForPhone, removeDeviceTokens } = require('../supabase_repo');
const { sendPushToTokensDirect } = require('../services/notification_delivery');

async function main() {
  const phone = String(process.argv[2] || '').trim();
  if (!phone) {
    console.error('حدد رقم الهاتف. مثال:');
    console.error('  node scripts/send_test_push.js +9647744009992');
    process.exit(1);
  }

  console.log(`البحث عن توكنات FCM للرقم: ${phone}`);
  const rows = await getDeviceTokensForPhone(phone);
  const tokens = rows.map((r) => String(r.token || '').trim()).filter(Boolean);
  const platforms = [...new Set(rows.map((r) => String(r.platform || 'unknown')))];

  if (!tokens.length) {
    console.error('❌ لا يوجد توكن مسجّل لهذا الرقم.');
    console.error('افتح التطبيق بهذا الرقم، اسمح بالإشعارات، سجّل دخول، ثم أعد المحاولة.');
    process.exit(2);
  }

  console.log(`✅ توكنات: ${tokens.length} | المنصات: ${platforms.join(', ') || 'unknown'}`);

  const result = await sendPushToTokensDirect(tokens, {
    title: '🔔 اختبار إشعار طلب',
    body: 'إذا وصلك هذا الإشعار فـ FCM يعمل على جهازك.',
    data: {
      category: 'taxi',
      audience: 'driver',
      eventKey: 'taxi:pool_new',
      orderId: `test-${Date.now()}`,
      requestId: `test-${Date.now()}`,
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
    skipped: result.skipped || false,
    errors: (result.errors || []).slice(0, 5),
  });

  if (Number(result.sent) > 0) {
    console.log('🎉 تم الإرسال. تحقق من شريط الإشعارات على الجهاز.');
    process.exit(0);
  }

  console.error('❌ لم يُرسل أي إشعار. راجع Firebase / التوكنات.');
  process.exit(3);
}

main().catch((err) => {
  console.error('خطأ:', err?.message || err);
  process.exit(1);
});
