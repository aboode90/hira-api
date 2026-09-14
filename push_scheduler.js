const logger = require('./lib/logger');
const {
  listPendingOrders,
  listOrdersWithDeliveryStatus,
  readOrderMeta,
  saveCustomerOrder,
  listPushInboxStatesNeedingReminder,
  markPushInboxReminderSent,
  getDeviceTokensForPhone,
} = require('./supabase_repo');
const {
  sendPushToPhone,
  buildPushPayload,
  displayOrderNumber,
} = require('./push_events');

const PENDING_REMINDER_MS = 15 * 60 * 1000;
const PENDING_TIMEOUT_MS = 20 * 60 * 1000;
const RATING_REMINDER_MS = 30 * 60 * 1000;
const COURIER_PICKUP_REMINDER_MS = 20 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 60 * 1000;

let schedulerRunning = false;

function parseIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function orderCreatedAt(meta) {
  // created_at من Supabase دائماً UTC صحيح؛ payload.createdAt قد يكون بتوقيت
  // بغداد بدون offset فيُفسَّر خطأً على سيرفر UTC فيتأخر الإلغاء التلقائي.
  return (
    parseIso(meta.row?.created_at) ||
    parseIso(meta.payload?.createdAt) ||
    parseIso(meta.row?.updated_at)
  );
}

function courierAcceptedAt(meta) {
  return parseIso(meta.payload?.courierAcceptedAt);
}

function deliveredAt(meta) {
  return parseIso(meta.payload?.deliveredAt) || parseIso(meta.row?.updated_at);
}

async function processPendingOrderReminders(nowMs) {
  const rows = await listPendingOrders();
  for (const row of rows) {
    try {
      const meta = readOrderMeta(row);
      if (!meta.merchantPhone || !meta.customerPhone) continue;

      const createdAt = orderCreatedAt(meta);
      if (!createdAt) continue;

      const ageMs = nowMs - createdAt.getTime();
      const orderNumber = displayOrderNumber(meta);

      // Cancel first — must not depend on push delivery succeeding.
      if (ageMs >= PENDING_TIMEOUT_MS) {
        const nextOrder = {
          ...meta.payload,
          statusKey: 'cancelled',
          statusAr: 'ملغي تلقائيًا',
          statusEn: 'Auto cancelled',
          cancelledBy: 'system',
          cancelReasonKey: 'system_timeout',
          noteAr: 'انتهت مهلة قبول التاجر (20 دقيقة) وتم إلغاء الطلب تلقائيًا.',
          noteEn: 'Order cancelled automatically after 20 minutes timeout.',
          merchantDecisionAt: new Date(nowMs).toISOString(),
        };
        await saveCustomerOrder(meta.customerPhone, {
          order: nextOrder,
          merchant_phone: meta.merchantPhone,
        });
        logger.info('auto-cancelled pending order', {
          orderId: meta.id,
          orderNumber,
          merchantPhone: meta.merchantPhone,
          ageMinutes: Math.round(ageMs / 60000),
        });
        if (meta.merchantPhone) {
          try {
            await sendPushToPhone(
              meta.merchantPhone,
              buildPushPayload({
                title: 'أُلغي طلب الزبون',
                body: `أُلغي طلب ${orderNumber} لانتهاء مهلة القبول`,
                audience: 'merchant',
                orderId: meta.id,
                eventKey: `merchant:${meta.id}:timeout_cancelled`,
              }),
              { showSystemBanner: true, immediate: true }
            );
          } catch (pushError) {
            logger.warn('timeout-cancel merchant push failed', {
              orderId: meta.id,
              error: pushError?.message || String(pushError),
            });
          }
        }
        continue;
      }

      if (ageMs >= PENDING_REMINDER_MS && !meta.payload?.pushPendingReminderSentAt) {
        try {
          await sendPushToPhone(
            meta.merchantPhone,
            buildPushPayload({
              title: 'تذكير: طلب معلّق',
              body: `الطلب ${orderNumber} بانتظار موافقتك منذ 15 دقيقة`,
              audience: 'merchant',
              orderId: meta.id,
              eventKey: `merchant:${meta.id}:pending_reminder`,
            })
          );
        } catch (pushError) {
          logger.warn('pending order reminder push failed', {
            orderId: meta.id,
            error: pushError?.message || String(pushError),
          });
        }

        const nextOrder = {
          ...meta.payload,
          pushPendingReminderSentAt: new Date(nowMs).toISOString(),
        };
        await saveCustomerOrder(
          meta.customerPhone,
          {
            order: nextOrder,
            merchant_phone: meta.merchantPhone,
          },
          { skipPush: true }
        );
      }
    } catch (orderError) {
      logger.error('pending order reminder/cancel failed', {
        orderId: row?.id,
        error: orderError?.message || String(orderError),
      });
    }
  }
}

async function processRatingReminders(nowMs) {
  return;
}

async function processCourierPickupReminders(nowMs) {
  const rows = await listOrdersWithDeliveryStatus('accepted');
  for (const row of rows) {
    try {
      const meta = readOrderMeta(row);
      if (!meta.courierPhone) continue;
      if (meta.payload?.pushCourierPickupReminderSentAt) continue;

      const acceptedAt = courierAcceptedAt(meta) || parseIso(meta.row?.updated_at);
      if (!acceptedAt) continue;
      if (nowMs - acceptedAt.getTime() < COURIER_PICKUP_REMINDER_MS) continue;

      const orderNumber = displayOrderNumber(meta);
      try {
        await sendPushToPhone(
          meta.courierPhone,
          buildPushPayload({
            title: 'تذكير: استلم الطلب',
            body: `الطلب ${orderNumber} بانتظار الاستلام من المتجر`,
            audience: 'courier',
            orderId: meta.id,
            eventKey: `courier:${meta.id}:pickup_reminder`,
          })
        );
      } catch (pushError) {
        logger.warn('courier pickup reminder push failed', {
          orderId: meta.id,
          error: pushError?.message || String(pushError),
        });
      }

      const nextOrder = {
        ...meta.payload,
        pushCourierPickupReminderSentAt: new Date(nowMs).toISOString(),
      };
      await saveCustomerOrder(
        meta.customerPhone,
        {
          order: nextOrder,
          merchant_phone: meta.merchantPhone || null,
          courier_phone: meta.courierPhone,
        },
        { skipPush: true }
      );
    } catch (orderError) {
      logger.error('courier pickup reminder failed', {
        orderId: row?.id,
        error: orderError?.message || String(orderError),
      });
    }
  }
}

async function processUnreadInboxReminders() {
  const rows = await listPushInboxStatesNeedingReminder();
  for (const row of rows) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;

    const tokens = await getDeviceTokensForPhone(phone);
    if (!tokens.length) continue;

    const unreadCount = Number(row.unread_count || 0);
    const body =
      unreadCount <= 1
        ? 'لديك إشعار جديد لم تقرأه في طلب'
        : `لديك ${unreadCount} إشعارات لم تقرأها في طلب`;

    await sendPushToPhone(
      phone,
      buildPushPayload({
        title: 'تذكير: إشعارات طلب',
        body,
        audience: 'user',
        orderId: '',
        eventKey: `inbox:${phone}:unread_reminder`,
        category: 'inbox_reminder',
      }),
      { skipInboxTracking: true }
    );

    await markPushInboxReminderSent(phone);
  }
}

async function processExpiredOffers() {
  try {
    const { assertSupabaseAdmin, hasColumn, nowIso } = require('./supabase_repo/common');
    if (!(await hasColumn('merchant_products', 'available_until'))) return;

    const supabase = assertSupabaseAdmin();
    const now = nowIso();
    let deletedAny = false;

    // حذف نهائي لعروض category=offers المنتهية
    const { data, error } = await supabase
      .from('merchant_products')
      .delete()
      .eq('category', 'offers')
      .lt('available_until', now)
      .select('id');

    if (error) {
      logger.warn('expire offers products failed', { error: error.message });
    } else if (Array.isArray(data) && data.length) {
      deletedAny = true;
      logger.info('expired offer products deleted', { count: data.length });
    }

    // حذف إعلانات المستعمل للزبائن المنتهية فقط (لا تمس إعلانات التجار القديمة)
    const { data: usedExpired, error: usedError } = await supabase
      .from('merchant_products')
      .delete()
      .eq('category', 'used')
      .eq('listing_mode', 'customer_used')
      .lt('available_until', now)
      .select('id');

    if (usedError) {
      logger.warn('expire used products failed', { error: usedError.message });
    } else if (Array.isArray(usedExpired) && usedExpired.length) {
      deletedAny = true;
      logger.info('expired customer used products deleted', {
        count: usedExpired.length,
      });
    }

    if (deletedAny) {
      try {
        const { invalidateCache, invalidateCachePrefix } = require('./lib/response_cache');
        await invalidateCachePrefix('marketplace:catalog-products:');
        invalidateCache('marketplace:offer-catalog-products');
      } catch (_) {
        // ignore
      }
    }

    if (await hasColumn('merchant_offers', 'end_date')) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: offers, error: offerError } = await supabase
        .from('merchant_offers')
        .update({ is_active: false })
        .eq('is_active', true)
        .lt('end_date', today)
        .select('id');
      if (offerError) {
        logger.warn('expire merchant_offers failed', { error: offerError.message });
      } else if (Array.isArray(offers) && offers.length) {
        logger.info('expired merchant_offers deactivated', { count: offers.length });
      }
    }
  } catch (error) {
    logger.error('processExpiredOffers error', { error: error?.message || String(error) });
  }
}

async function runPushSchedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const nowMs = Date.now();
    await processPendingOrderReminders(nowMs);
    await processRatingReminders(nowMs);
    await processCourierPickupReminders(nowMs);
    await processUnreadInboxReminders();
    await processExpiredOffers();
  } catch (error) {
    logger.error('push scheduler error', { error: error.message });
  } finally {
    schedulerRunning = false;
  }
}

function startPushScheduler() {
  logger.info('order timeout scheduler started', {
    pendingReminderMinutes: PENDING_REMINDER_MS / 60000,
    pendingTimeoutMinutes: PENDING_TIMEOUT_MS / 60000,
    intervalSeconds: SCHEDULER_INTERVAL_MS / 1000,
  });
  setTimeout(() => {
    runPushSchedulerTick();
  }, 15 * 1000);
  setInterval(runPushSchedulerTick, SCHEDULER_INTERVAL_MS);
}

module.exports = {
  startPushScheduler,
  runPushSchedulerTick,
};
