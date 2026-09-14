const {
  getDeviceTokensForPhone,
  removeDeviceTokens,
  getActiveCourierPhones,
  getActiveDriverPhones,
  recordPushInboxDelivered,
} = require('./supabase_repo');
const { resolvePhoneKey, phonesOverlap } = require('./supabase_repo/common');
const { enqueuePushNotification } = require('./services/notification_queue');
const { sendPushToTokensDirect } = require('./services/notification_delivery');

function looksLikeVoiceChatContent(raw) {
  const content = String(raw || '').trim();
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.status != null || parsed.durationSeconds != null) return false;
    const url = String(parsed.url || '').trim();
    if (!url) return false;
    return parsed.duration != null || /\.(m4a|aac|mp3|wav|ogg)(\?|$)/i.test(url);
  } catch (_) {
    return /\.(m4a|aac|mp3|wav|ogg)(\?|$)/i.test(content);
  }
}

function displayOrderNumber(meta) {
  const raw = String(meta?.payload?.orderNumber ?? meta?.row?.order_number ?? '').trim();
  if (raw && raw.length <= 14) return raw;
  const idSeed = String(meta?.id ?? '').split('-')[0];
  const seed = Number.parseInt(idSeed, 10);
  if (!Number.isFinite(seed)) return raw || 'طلبك';
  return `#${String(seed % 1000000).padStart(6, '0')}`;
}

function noteText(meta) {
  return {
    ar: String(meta?.payload?.noteAr ?? '').trim(),
    en: String(meta?.payload?.noteEn ?? '').trim(),
  };
}

function isCustomerCancelledBeforeApproval(meta) {
  const { ar, en } = noteText(meta);
  return (
    en.includes('Cancelled by customer before merchant') ||
    ar.includes('ألغى الطلب من الزبون قبل موافقة') ||
    en.includes('Cancelled by customer') ||
    ar.includes('ألغى الزبون الطلب')
  );
}

function isOrderRejected(meta) {
  if (meta.statusKey === 'rejected') return true;
  const { ar, en } = noteText(meta);
  return (
    en.includes('Rejected reason') ||
    ar.includes('سبب الرفض') ||
    String(meta?.payload?.statusEn ?? '').trim() === 'Rejected'
  );
}

function isTimeoutCancellation(meta) {
  const { ar, en } = noteText(meta);
  return en.toLowerCase().includes('timeout') || ar.includes('مهلة');
}

function isMerchantApprovedCancellation(meta) {
  const { ar, en } = noteText(meta);
  return (
    en.includes('Merchant approved cancellation') ||
    ar.includes('موافقة التاجر على إلغاء') ||
    ar.includes('تمت الموافقة على إلغاء')
  );
}

function isCustomerRejectedAdjustment(meta) {
  const { ar, en } = noteText(meta);
  return (
    ar.includes('رفض الزبون الطلب المعدّل') ||
    en.includes('Customer rejected adjusted order')
  );
}

function isCustomerApprovedAdjustment(meta) {
  const { ar, en } = noteText(meta);
  return (
    ar.includes('وافق الزبون على الطلب المعدّل') ||
    en.includes('Customer approved adjusted order')
  );
}

function isDeliveryPool(meta) {
  return (
    meta?.statusKey === 'delivering' &&
    meta?.deliveryStatusKey === 'waiting' &&
    !meta?.courierPhone
  );
}

function shouldTrackPushInbox(payload, options = {}) {
  if (options.skipInboxTracking) return false;
  const category = String(payload?.data?.category ?? '').trim();
  if (category === 'inbox_reminder') return false;
  const eventKey = String(payload?.data?.eventKey ?? '').trim();
  return !eventKey.includes(':unread_reminder');
}

async function sendPushToPhone(phone, payload, options = {}) {
  let phoneKey = String(phone || '').trim();
  if (!phoneKey) return { sent: 0, failed: 0, invalidTokens: [], reason: 'no_phone' };

  try {
    phoneKey = await resolvePhoneKey(phoneKey);
  } catch (_) {
    // keep trimmed input when phone is not in DB yet
  }

  const rows = await getDeviceTokensForPhone(phoneKey);
  const tokens = rows.map((row) => row.token).filter(Boolean);
  if (!tokens.length) {
    const eventKey = String(payload?.data?.eventKey ?? '').trim();
    console.warn(
      `push: no device tokens for phone=${phoneKey}${eventKey ? ` event=${eventKey}` : ''}`
    );
    return { sent: 0, failed: 0, invalidTokens: [], reason: 'no_tokens' };
  }

  const showSystemBanner =
    options.showSystemBanner === true ||
    String(payload?.data?.category ?? '').trim() === 'account' ||
    String(payload?.data?.category ?? '').trim() === 'call' ||
    String(payload?.data?.category ?? '').trim() === 'taxi' ||
    String(payload?.data?.category ?? '').trim() === 'order' ||
    String(payload?.data?.category ?? '').trim() === 'delivery' ||
    String(payload?.data?.audience ?? '').trim() === 'merchant';

  if (options.immediate === true) {
    const result = await sendPushToTokensDirect(tokens, {
      title: payload?.title,
      body: payload?.body,
      data: payload?.data || {},
      showSystemBanner,
      dataOnly: options.dataOnly === true,
    });
    if (result.invalidTokens?.length) {
      await removeDeviceTokens(result.invalidTokens);
    }
    if (result?.sent > 0 && shouldTrackPushInbox(payload, options)) {
      try {
        await recordPushInboxDelivered(phoneKey);
      } catch (error) {
        console.error('push inbox track error:', error?.message || error);
      }
    }
    return { ...result, phoneKey, immediate: true };
  }

  const result = await enqueuePushNotification({
    tokens,
    title: payload?.title,
    body: payload?.body,
    data: payload?.data || {},
    targetPhone: phoneKey,
    audienceRole: String(payload?.data?.audience ?? 'customer').trim(),
    eventKey: String(payload?.data?.eventKey ?? '').trim(),
    showSystemBanner,
    skipInboxTracking: !shouldTrackPushInbox(payload, options),
  });
  if (result?.invalidTokens?.length) {
    await removeDeviceTokens(result.invalidTokens);
  }

  if (result?.sent > 0 && shouldTrackPushInbox(payload, options)) {
    try {
      await recordPushInboxDelivered(phoneKey);
    } catch (error) {
      console.error('push inbox track error:', error?.message || error);
    }
  }

  return { ...result, phoneKey };
}

async function notifyPhones(phones, payload) {
  const uniquePhones = [
    ...new Set((phones || []).map((item) => String(item || '').trim()).filter(Boolean)),
  ];
  await Promise.all(uniquePhones.map((phone) => sendPushToPhone(phone, payload)));
}

async function notifyActiveCouriers(payload, excludePhones = []) {
  const excluded = new Set(
    (excludePhones || []).map((item) => String(item || '').trim()).filter(Boolean)
  );
  const courierPhones = await getActiveCourierPhones();
  const targets = courierPhones.filter((phone) => !excluded.has(phone));
  await notifyPhones(targets, payload);
}

async function notifyActiveDrivers(payload, excludePhones = []) {
  const excluded = new Set(
    (excludePhones || []).map((item) => String(item || '').trim()).filter(Boolean)
  );
  const driverPhones = await getActiveDriverPhones();
  const targets = driverPhones.filter((phone) => !excluded.has(phone));
  await notifyPhones(targets, payload);
}


function buildPushPayload({ title, body, audience, orderId, eventKey, category = 'order' }) {
  return {
    title,
    body,
    data: {
      audience,
      orderId: orderId || '',
      eventKey: eventKey || '',
      category,
    },
  };
}

async function onOrderSaved({ previousMeta, nextMeta, isNew }) {
  if (!nextMeta) return;

  const orderId = nextMeta.id;
  const orderNumber = displayOrderNumber(nextMeta);
  const previousStatus = previousMeta?.statusKey || '';
  const nextStatus = nextMeta.statusKey || '';
  const previousDelivery = previousMeta?.deliveryStatusKey || '';
  const nextDelivery = nextMeta.deliveryStatusKey || '';
  const previousCourier = previousMeta?.courierPhone || '';
  const nextCourier = nextMeta.courierPhone || '';
  const deliveryAssigneeRole = String(
    nextMeta.payload?.deliveryAssigneeRole ??
      previousMeta?.payload?.deliveryAssigneeRole ??
      'delivery'
  ).trim();
  const isDriverDelivery = deliveryAssigneeRole === 'driver';
  const assigneeAr = isDriverDelivery ? 'الكابتن' : 'المندوب';
  const assigneeAudience = isDriverDelivery ? 'driver' : 'courier';

  if (isNew && nextStatus === 'pending' && nextMeta.merchantPhone) {
    // إرسال فوري مثل إشعارات التكسي — لا يعتمد على طابور الإشعارات فقط.
    const result = await sendPushToPhone(
      nextMeta.merchantPhone,
      buildPushPayload({
        title: 'طلب جديد',
        body: `لديك طلب جديد ${orderNumber}`,
        audience: 'merchant',
        orderId,
        eventKey: `merchant:${orderId}:new`,
      }),
      { showSystemBanner: true, immediate: true }
    );
    console.log('merchant new-order push:', {
      orderId,
      merchantPhone: nextMeta.merchantPhone,
      sent: Number(result?.sent || 0),
      failed: Number(result?.failed || 0),
      reason: result?.reason || null,
    });
    return;
  }

  if (!previousMeta) return;

  if (previousStatus !== nextStatus) {
    if (nextStatus === 'cancel_requested' && nextMeta.merchantPhone) {
      await sendPushToPhone(
        nextMeta.merchantPhone,
        buildPushPayload({
          title: 'طلب إلغاء من الزبون',
          body: `الزبون يطلب إلغاء الطلب ${orderNumber}`,
          audience: 'merchant',
          orderId,
          eventKey: `merchant:${orderId}:cancel_requested`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    }

    if (nextStatus === 'return_pending' && previousStatus !== 'return_pending') {
      if (nextCourier) {
        await sendPushToPhone(
          nextCourier,
          buildPushPayload({
            title: 'ألغى الزبون الطلب',
            body: `أرجع الطلب ${orderNumber} للمتجر`,
            audience: assigneeAudience,
            orderId,
            eventKey: `${assigneeAudience}:${orderId}:return_pending`,
            category: 'delivery',
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
      if (nextMeta.merchantPhone) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: 'إرجاع طلب بعد إلغاء الزبون',
            body: `أكد استلام المنتج أو الطعام المُرجع للطلب ${orderNumber}`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:return_pending`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
      if (nextMeta.customerPhone) {
        await sendPushToPhone(
          nextMeta.customerPhone,
          buildPushPayload({
            title: 'تم إلغاء طلبك',
            body: `سيُرجع المنتج أو الطعام للمتجر — الطلب ${orderNumber}`,
            audience: 'customer',
            orderId,
            eventKey: `customer:${orderId}:return_pending`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    }

    if (
      nextStatus === 'cancelled' &&
      previousStatus !== 'cancelled' &&
      isCustomerCancelledBeforeApproval(nextMeta) &&
      nextMeta.merchantPhone
    ) {
      const beforeApproval = previousStatus === 'pending' ||
        previousStatus === 'adjustment_pending';
      await sendPushToPhone(
        nextMeta.merchantPhone,
        buildPushPayload({
          title: 'ألغى الزبون الطلب',
          body: beforeApproval
            ? `الزبون ألغى الطلب ${orderNumber} قبل القبول`
            : `الزبون ألغى الطلب ${orderNumber}`,
          audience: 'merchant',
          orderId,
          eventKey: `merchant:${orderId}:customer_cancelled`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    }

    if (nextStatus === 'adjustment_pending' && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'تعديل على طلبك',
          body: `التاجر عدّل الطلب ${orderNumber} — راجع ووافق أو ألغِ`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:adjustment_pending`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    } else if (nextStatus === 'accepted' && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'تم قبول طلبك',
          body: `الطلب ${orderNumber} قيد التجهيز`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:accepted`,
        }),
        { showSystemBanner: true, immediate: true }
      );
      if (
        previousStatus === 'adjustment_pending' &&
        nextMeta.merchantPhone
      ) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: 'وافق الزبون على التعديل',
            body: `الطلب ${orderNumber} قيد التجهيز`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:adjustment_accepted`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    } else if (nextStatus === 'preparing' && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'طلبك قيد التحضير',
          body: `المتجر يجهّز طلبك ${orderNumber}`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:preparing`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    } else if (
      previousStatus === 'cancel_requested' &&
      nextStatus !== 'cancel_requested' &&
      nextStatus !== 'cancelled' &&
      nextMeta.customerPhone
    ) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'رفض التاجر إلغاء الطلب',
          body: `سيستمر تنفيذ طلبك ${orderNumber}`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:cancel_rejected`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    } else if (
      previousStatus === 'cancel_requested' &&
      nextStatus === 'cancelled' &&
      isMerchantApprovedCancellation(nextMeta) &&
      nextMeta.customerPhone
    ) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'تم إلغاء طلبك',
          body: `وافق التاجر على إلغاء الطلب ${orderNumber}`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:cancel_approved`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    } else if (
      previousStatus === 'return_pending' &&
      nextStatus === 'cancelled' &&
      nextMeta.customerPhone
    ) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'استلم التاجر الإرجاع',
          body: `تم تأكيد استلام المنتج المُرجع للطلب ${orderNumber}`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:returned`,
        }),
        { showSystemBanner: true, immediate: true }
      );
      if (previousCourier) {
        await sendPushToPhone(
          previousCourier,
          buildPushPayload({
            title: 'استلم التاجر الإرجاع',
            body: `تم تأكيد إرجاع الطلب ${orderNumber}`,
            audience: assigneeAudience,
            orderId,
            eventKey: `${assigneeAudience}:${orderId}:returned`,
            category: 'delivery',
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    } else if (nextStatus === 'cancelled' && nextMeta.customerPhone) {
      if (isTimeoutCancellation(nextMeta)) {
        await sendPushToPhone(
          nextMeta.customerPhone,
          buildPushPayload({
            title: 'انتهت مهلة الطلب',
            body: `لم يرد التاجر خلال 20 دقيقة وأُلغي الطلب ${orderNumber}`,
            audience: 'customer',
            orderId,
            eventKey: `customer:${orderId}:timeout`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      } else if (isOrderRejected(nextMeta)) {
        const { ar } = noteText(nextMeta);
        await sendPushToPhone(
          nextMeta.customerPhone,
          buildPushPayload({
            title: 'تم رفض طلبك',
            body: ar || `التاجر رفض الطلب ${orderNumber}`,
            audience: 'customer',
            orderId,
            eventKey: `customer:${orderId}:rejected`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      } else if (
        previousStatus === 'adjustment_pending' &&
        isCustomerRejectedAdjustment(nextMeta) &&
        nextMeta.merchantPhone
      ) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: 'رفض الزبون التعديل',
            body: `ألغى الزبون الطلب ${orderNumber} بعد التعديل`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:adjustment_rejected`,
          }),
          { showSystemBanner: true, immediate: true }
        );
        if (nextMeta.customerPhone) {
          await sendPushToPhone(
            nextMeta.customerPhone,
            buildPushPayload({
              title: 'تم إلغاء الطلب',
              body: `ألغيت الطلب المعدّل ${orderNumber}`,
              audience: 'customer',
              orderId,
              eventKey: `customer:${orderId}:adjustment_rejected`,
            }),
            { showSystemBanner: true, immediate: true }
          );
        }
      } else if (!isMerchantApprovedCancellation(nextMeta)) {
        await sendPushToPhone(
          nextMeta.customerPhone,
          buildPushPayload({
            title: 'تم إلغاء الطلب',
            body: `الطلب ${orderNumber} أُلغي`,
            audience: 'customer',
            orderId,
            eventKey: `customer:${orderId}:cancelled`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    } else if (nextStatus === 'delivering' && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'طلبك جاهز للتوصيل',
          body: `الطلب ${orderNumber} في انتظار مندوب التوصيل`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:delivering`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    } else if (
      nextStatus === 'completed' &&
      nextMeta.customerPhone &&
      nextDelivery !== 'delivered'
    ) {
      // عند التسليم (delivery_status_key = delivered) يرسل فرع التوصيل
      // إشعار التسليم للزبون والتاجر — نتخطى فرع completed حتى لا تصل
      // إشعاران متتاليان ("تم التسليم" ثم "تم إكمال الطلب").
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'تم إكمال الطلب',
          body: `الطلب ${orderNumber} اكتمل بنجاح`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:completed`,
        }),
        { showSystemBanner: true, immediate: true }
      );

      if (nextMeta.merchantPhone) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: 'اكتمل الطلب',
            body: `الطلب ${orderNumber} اكتمل`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:completed`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    }

    if (
      nextStatus === 'cancelled' &&
      previousStatus !== 'cancelled' &&
      previousStatus !== 'return_pending' &&
      previousCourier
    ) {
      await sendPushToPhone(
        previousCourier,
        buildPushPayload({
          title: 'تم إلغاء الطلب',
          body: `الطلب ${orderNumber} أُلغي بعد تعيينك`,
          audience: assigneeAudience,
          orderId,
          eventKey: `${assigneeAudience}:${orderId}:cancelled`,
          category: 'delivery',
        }),
        { showSystemBanner: true, immediate: true }
      );
    }
  }

  if (previousDelivery !== nextDelivery) {
    if (nextDelivery === 'accepted') {
      if (nextMeta.customerPhone) {
        await sendPushToPhone(
          nextMeta.customerPhone,
          buildPushPayload({
            title: `${assigneeAr} في الطريق`,
            body: `تم تعيين ${assigneeAr} لطلب ${orderNumber}`,
            audience: 'customer',
            orderId,
            eventKey: `customer:${orderId}:courier_accepted`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }

      // التاجر يستلم إشعاره بدوره الخاص (merchant) حتى لا يفتح تبويب الزبون.
      if (nextMeta.merchantPhone) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: `${assigneeAr} في الطريق`,
            body: `تم تعيين ${assigneeAr} لطلب ${orderNumber}`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:courier_accepted`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }

      if (nextCourier) {
        await sendPushToPhone(
          nextCourier,
          buildPushPayload({
            title: 'تم قبول طلب التوصيل',
            body: `أنت ${assigneeAr} المعيّن لطلب ${orderNumber}`,
            audience: assigneeAudience,
            orderId,
            eventKey: `${assigneeAudience}:${orderId}:accepted`,
            category: 'delivery',
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    } else if (nextDelivery === 'picked_up' && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'تم استلام الطلب',
          body: `${assigneeAr} استلم طلبك ${orderNumber} من المتجر`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:picked_up`,
        }),
        { showSystemBanner: true, immediate: true }
      );

      if (nextMeta.merchantPhone) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: `استلم ${assigneeAr} الطلب`,
            body: `${assigneeAr} استلم الطلب ${orderNumber} من متجرك`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:picked_up`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    } else if (nextDelivery === 'on_way' && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: `${assigneeAr} في الطريق إليك`,
          body: `طلبك ${orderNumber} في الطريق`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:on_way`,
        }),
        { showSystemBanner: true, immediate: true }
      );
    } else if (nextDelivery === 'delivered') {
      if (nextMeta.customerPhone) {
        await sendPushToPhone(
          nextMeta.customerPhone,
          buildPushPayload({
            title: 'تم التسليم',
            body: `تم تسليم طلبك ${orderNumber}`,
            audience: 'customer',
            orderId,
            eventKey: `customer:${orderId}:delivered`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }

      if (nextMeta.merchantPhone) {
        await sendPushToPhone(
          nextMeta.merchantPhone,
          buildPushPayload({
            title: 'تم تسليم الطلب',
            body: `تم تسليم الطلب ${orderNumber} للزبون`,
            audience: 'merchant',
            orderId,
            eventKey: `merchant:${orderId}:delivered`,
          }),
          { showSystemBanner: true, immediate: true }
        );
      }
    }
  }

  const enteredPool = isDeliveryPool(nextMeta) && !isDeliveryPool(previousMeta);
  if (enteredPool) {
    try {
      const { notifyDeliveryPoolExpandingWave } = require('./supabase_repo/orders');
      await notifyDeliveryPoolExpandingWave(nextMeta, { force: true });
    } catch (error) {
      console.error('delivery pool expanding notify error:', error?.message || error);
    }
    if (previousCourier && nextMeta.customerPhone) {
      await sendPushToPhone(
        nextMeta.customerPhone,
        buildPushPayload({
          title: 'جاري البحث عن مندوب آخر',
          body: `الطلب ${orderNumber} أُعيد إلى قائمة التوصيل وسنجد من يوصله.`,
          audience: 'customer',
          orderId,
          eventKey: `customer:${orderId}:pool_returned`,
          category: 'delivery',
        }),
        { showSystemBanner: true, immediate: true }
      );
    }
  }

  const courierSwitched =
    Boolean(nextCourier) &&
    Boolean(previousCourier) &&
    !phonesOverlap(previousCourier, nextCourier);

  if (courierSwitched && nextDelivery !== 'waiting') {
    const alreadyNotifiedNew =
      previousDelivery !== nextDelivery && nextDelivery === 'accepted';
    if (!alreadyNotifiedNew) {
      await sendPushToPhone(
        nextCourier,
        buildPushPayload({
          title: 'تم تعيينك لتوصيل طلب',
          body: `الإدارة عيّنتك لتوصيل الطلب ${orderNumber}`,
          audience: assigneeAudience,
          orderId,
          eventKey: `${assigneeAudience}:${orderId}:admin_assigned`,
          category: 'delivery',
        }),
        { showSystemBanner: true, immediate: true }
      );
    }
    await sendPushToPhone(
      previousCourier,
      buildPushPayload({
        title: 'تم تحويل الطلب لمندوب آخر',
        body: `الطلب ${orderNumber} لم يعد معيّناً لك`,
        audience: 'courier',
        orderId,
        eventKey: `courier:${orderId}:admin_reassigned`,
        category: 'delivery',
      }),
      { showSystemBanner: true, immediate: true }
    );
  }

  const returnedToPool =
    isDeliveryPool(nextMeta) &&
    isDeliveryPool(previousMeta) &&
    previousCourier &&
    !nextCourier;
  if (returnedToPool) {
    const rejectedPhones = nextMeta.payload?.rejectedByCouriers || [];
    await Promise.all([
      notifyActiveCouriers(
        buildPushPayload({
          title: 'طلب عاد لقائمة التوصيل',
          body: `الطلب ${orderNumber} متاح مجدداً للمندوبين`,
          audience: 'courier',
          orderId,
          eventKey: `courier:${orderId}:pool_returned`,
          category: 'delivery',
        }),
        rejectedPhones
      ),
      notifyActiveDrivers(
        buildPushPayload({
          title: 'طلب توصيل متاح مجدداً',
          body: `الطلب ${orderNumber} متاح للكباتن`,
          audience: 'driver',
          orderId,
          eventKey: `driver:${orderId}:pool_returned`,
          category: 'delivery',
        }),
        rejectedPhones
      ),
    ]);
  }
}


async function onCourierRejected(courierPhone, message, reasonKey = '') {
  const phone = String(courierPhone || '').trim();
  const body = String(message || '').trim();
  if (!phone || !body) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'طلب المندوب يحتاج تعديلاً',
      body,
      audience: 'courier',
      orderId: '',
      eventKey: `courier:${phone}:rejected:${reasonKey || 'general'}`,
      category: 'account',
    })
  );
}

async function onCourierApproved(courierPhone) {
  const phone = String(courierPhone || '').trim();
  if (!phone) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'تم تفعيل حساب المندوب',
      body: 'وافقت الإدارة على طلبك. يمكنك الآن استقبال طلبات التوصيل.',
      audience: 'courier',
      orderId: '',
      eventKey: `courier:${phone}:approved`,
      category: 'account',
    })
  );
}

async function onMerchantRejected(merchantPhone, message, reasonKey = '') {
  const phone = String(merchantPhone || '').trim();
  const body = String(message || '').trim();
  if (!phone || !body) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'طلب التاجر يحتاج تعديلاً',
      body,
      audience: 'merchant',
      orderId: '',
      eventKey: `merchant:${phone}:rejected:${reasonKey || 'general'}`,
      category: 'account',
    })
  );
}

async function onMerchantApproved(merchantPhone) {
  const phone = String(merchantPhone || '').trim();
  if (!phone) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'تم تفعيل حساب التاجر',
      body: 'وافقت الإدارة على طلبك. يمكنك الآن إدارة متجرك واستقبال الطلبات.',
      audience: 'merchant',
      orderId: '',
      eventKey: `merchant:${phone}:approved`,
      category: 'account',
    })
  );
}

async function onDriverRejected(driverPhone, message, reasonKey = '') {
  const phone = String(driverPhone || '').trim();
  const body = String(message || '').trim();
  if (!phone || !body) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'طلب التكسي يحتاج تعديلاً',
      body,
      audience: 'driver',
      orderId: '',
      eventKey: `driver:${phone}:rejected:${reasonKey || 'general'}`,
      category: 'account',
    })
  );
}

async function onDriverApproved(driverPhone) {
  const phone = String(driverPhone || '').trim();
  if (!phone) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'تم تفعيل حساب التكسي',
      body: 'وافقت الإدارة على طلبك. يمكنك الآن استقبال طلبات الركوب.',
      audience: 'driver',
      orderId: '',
      eventKey: `driver:${phone}:approved`,
      category: 'account',
    })
  );
}

async function onMerchantFrozen(merchantPhone, isFrozen) {
  if (!isFrozen) return;
  const phone = String(merchantPhone || '').trim();
  if (!phone) return;

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'تم تجميد حسابك',
      body: 'حساب المتجر مجمّد ولا يستقبل طلبات جديدة. تواصل مع الإدارة.',
      audience: 'merchant',
      orderId: '',
      eventKey: `merchant:${phone}:frozen`,
      category: 'account',
    })
  );
}

async function onProductApproved(merchantPhone, productName = '') {
  const phone = String(merchantPhone || '').trim();
  if (!phone) return;
  const label = String(productName || 'محتواك').trim();

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: 'تمت الموافقة على المحتوى',
      body: `وافقت الإدارة على «${label}». أصبح ظاهراً للزبائن الآن.`,
      audience: 'merchant',
      orderId: '',
      eventKey: `product:${phone}:approved`,
      category: 'account',
    })
  );
}

async function onProductRejected(merchantPhone, message, productName = '') {
  const phone = String(merchantPhone || '').trim();
  const body = String(message || '').trim();
  if (!phone || !body) return;
  const label = String(productName || 'المحتوى').trim();

  await sendPushToPhone(
    phone,
    buildPushPayload({
      title: `رفض: ${label}`,
      body,
      audience: 'merchant',
      orderId: '',
      eventKey: `product:${phone}:rejected`,
      category: 'account',
    })
  );
}

async function notifyChatMessage(receiverPhone, customerMessage) {
  const messageType = String(
    customerMessage?.messageType || customerMessage?.message_type || 'text',
  ).trim();
  const rawContent = String(customerMessage?.content || customerMessage?.text || '').trim();
  let body = rawContent.substring(0, 100);
  if (messageType === 'sticker') {
    body = 'أرسل ملصقاً';
  } else if (messageType === 'call') {
    body = 'مكالمة صوتية';
  } else if (messageType === 'image') {
    body = 'أرسل صورة';
  } else if (messageType === 'voice' || looksLikeVoiceChatContent(rawContent)) {
    body = '🎤 رسالة صوتية';
  }
  const customerName = String(customerMessage?.senderName || customerMessage?.customerName || customerMessage?.sender_name || 'مستخدم').trim();
  const threadType = String(customerMessage?.threadType || customerMessage?.thread_type || 'order').trim();
  const threadId = String(customerMessage?.threadId || customerMessage?.thread_id || customerMessage?.orderId || '').trim();

  await sendPushToPhone(
    receiverPhone,
    {
      title: `رسالة جديدة من ${customerName}`,
      body: body || 'وصلتك رسالة جديدة داخل التطبيق',
      data: {
        eventKey: 'chat:new',
        threadType,
        threadId,
        senderName: customerName,
        senderPhone: String(
          customerMessage?.senderPhone || customerMessage?.sender_phone || ''
        ).trim(),
        orderId: threadType === 'order' ? threadId : '',
        category: 'chat',
      },
    },
    // فوري مباشرة — لا يمر عبر طابور الإشعارات حتى لا تتعطل رسائل الشات
    // إذا تأخر/توقف عامل BullMQ. (كانت عبر الطابور سابقاً.)
    { showSystemBanner: true, immediate: true }
  );
}

async function notifyAdminsSupportMessage(customerMessage) {
  const { PLATFORM_ADMIN_PHONES } = require('./supabase_repo/common');
  const envPhones = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const adminPhones = [
    ...new Set([...envPhones, ...PLATFORM_ADMIN_PHONES].map((item) => String(item || '').trim()).filter(Boolean)),
  ];
  if (!adminPhones.length) return;

  const messageType = String(
    customerMessage?.messageType || customerMessage?.message_type || 'text',
  ).trim();
  const rawContent = String(customerMessage?.content || customerMessage?.text || '').trim();
  let body = rawContent.substring(0, 100);
  if (messageType === 'sticker') {
    body = 'أرسل ملصقاً';
  } else if (messageType === 'call') {
    body = 'مكالمة صوتية';
  } else if (messageType === 'image') {
    body = 'أرسل صورة';
  } else if (messageType === 'voice' || looksLikeVoiceChatContent(rawContent)) {
    body = '🎤 رسالة صوتية';
  }
  const customerName = String(
    customerMessage?.senderName || customerMessage?.sender_name || 'مستخدم',
  ).trim();
  const threadId = String(
    customerMessage?.threadId || customerMessage?.thread_id || '',
  ).trim();

  await notifyPhones(adminPhones, {
    title: `رسالة دعم من ${customerName}`,
    body: body || 'رسالة جديدة في محادثة الدعم',
    data: {
      eventKey: 'support:new',
      threadType: 'support',
      threadId,
      senderName: customerName,
      senderPhone: String(
        customerMessage?.senderPhone || customerMessage?.sender_phone || threadId,
      ).trim(),
      category: 'chat',
      audience: 'admin',
    },
  });
}

async function notifyIncomingCall(receiverPhone, callInfo) {
  const callerName = String(callInfo?.callerName || 'مستخدم').trim();
  const threadType = String(callInfo?.threadType || 'order').trim();
  const threadId = String(callInfo?.threadId || '').trim();
  const channelName = String(callInfo?.channelName || '').trim();
  const callerPhone = String(callInfo?.callerPhone || '').trim();
  const callLogId = String(callInfo?.callLogId || '').trim();

  const payload = {
    title: `مكالمة واردة من ${callerName}`,
    body: 'اضغط للرد على المكالمة داخل التطبيق',
    data: {
      eventKey: 'call:incoming',
      threadType,
      threadId,
      channelName,
      callerName,
      callerPhone,
      callLogId,
      orderId: threadType === 'order' ? threadId : '',
      category: 'call',
    },
  };

  const phoneKey = await resolvePhoneKey(receiverPhone);
  const rows = await getDeviceTokensForPhone(phoneKey);
  if (!rows.length) {
    return { sent: 0, failed: 0, invalidTokens: [], reason: 'no_tokens' };
  }

  const androidTokens = [];
  const iosTokens = [];
  const unknownTokens = [];
  for (const row of rows) {
    const token = String(row?.token || '').trim();
    if (!token) continue;
    const platform = String(row?.platform || '').trim().toLowerCase();
    if (platform === 'android') androidTokens.push(token);
    else if (platform === 'ios' || platform === 'iphone') iosTokens.push(token);
    else unknownTokens.push(token);
  }

  const results = await Promise.all([
    // Android data-only: التطبيق ينشئ إشعاراً محلياً قابلاً للإلغاء وFull Screen.
    sendPushToTokensDirect(androidTokens, {
      ...payload,
      dataOnly: true,
    }),
    // iOS يحتاج alert push لضمان الظهور في الخلفية/الإغلاق.
    sendPushToTokensDirect(iosTokens, {
      ...payload,
      showSystemBanner: true,
    }),
    sendPushToTokensDirect(unknownTokens, {
      ...payload,
      showSystemBanner: true,
    }),
  ]);

  const invalidTokens = results.flatMap((item) => item.invalidTokens || []);
  if (invalidTokens.length) {
    await removeDeviceTokens(invalidTokens);
  }
  return {
    sent: results.reduce((sum, item) => sum + Number(item.sent || 0), 0),
    failed: results.reduce((sum, item) => sum + Number(item.failed || 0), 0),
    invalidTokens,
    phoneKey,
    immediate: true,
  };
}

async function notifyCallCancelled(receiverPhone, callInfo) {
  const threadType = String(callInfo?.threadType || 'order').trim();
  const threadId = String(callInfo?.threadId || '').trim();
  const channelName = String(callInfo?.channelName || '').trim();
  const callLogId = String(callInfo?.callLogId || '').trim();

  return sendPushToPhone(
    receiverPhone,
    {
      title: 'انتهت المكالمة',
      body: 'ألغى المتصل المكالمة',
      data: {
        eventKey: 'call:cancelled',
        threadType,
        threadId,
        channelName,
        callLogId,
        orderId: threadType === 'order' ? threadId : '',
        category: 'call',
      },
    },
    {
      immediate: true,
      skipInboxTracking: true,
      dataOnly: true,
    },
  );
}

async function notifyMerchantNewReview(merchantPhone, orderId, stars) {
  if (!merchantPhone) return;
  await sendPushToPhone(merchantPhone, buildPushPayload({
    title: 'تقييم جديد',
    body: `وصل تقييم جديد على طلبك (${stars} نجوم)`,
    audience: 'merchant',
    orderId,
    eventKey: `merchant:${orderId}:new_review`,
  }), { showSystemBanner: true, immediate: true });
}

async function notifyCustomerReviewReplied(customerPhone, orderId) {
  if (!customerPhone) return;
  await sendPushToPhone(customerPhone, buildPushPayload({
    title: 'رد على تقييمك',
    body: 'ردّ التاجر على تقييمك',
    audience: 'customer',
    orderId,
    eventKey: `customer:${orderId}:review_replied`,
  }), { showSystemBanner: true, immediate: true });
}

async function notifyAdminsTaxiComplaint(requestId) {
  const { PLATFORM_ADMIN_PHONES } = require('./supabase_repo/common');
  const envPhones = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const adminPhones = [
    ...new Set([...envPhones, ...PLATFORM_ADMIN_PHONES].map((item) => String(item || '').trim()).filter(Boolean)),
  ];
  if (!adminPhones.length) return;

  await notifyPhones(adminPhones, {
    title: 'شكوى جديدة',
    body: `وصلت شكوى جديدة على الرحلة ${String(requestId || '').trim() || ''}`,
    data: {
      eventKey: 'admin:taxi_complaint',
      orderId: String(requestId || '').trim(),
      requestId: String(requestId || '').trim(),
      category: 'taxi',
      audience: 'admin',
    },
  });
}

module.exports = {
  onOrderSaved,
  onCourierApproved,
  onCourierRejected,
  onMerchantApproved,
  onMerchantRejected,
  onProductApproved,
  onProductRejected,
  onDriverApproved,
  onDriverRejected,
  onMerchantFrozen,
  sendPushToPhone,
  notifyChatMessage,
  notifyAdminsSupportMessage,
  notifyAdminsTaxiComplaint,
  notifyIncomingCall,
  notifyCallCancelled,
  notifyActiveCouriers,
  notifyActiveDrivers,
  buildPushPayload,
  displayOrderNumber,
  notifyMerchantNewReview,
  notifyCustomerReviewReplied,
};
