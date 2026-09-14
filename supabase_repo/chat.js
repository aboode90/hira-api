const {
  assertSupabaseAdmin,
  selectSingle,
  selectSingleByPhone,
  selectMany,
  resolvePhoneKey,
  getPhoneVariants,
  phonesOverlap,
  canonicalPhone,
  normalizeObject,
  isUuid,
  PLATFORM_ADMIN_PHONES,
} = require('./common');

function phoneIdentityKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  const canonical = canonicalPhone(phone);
  if (canonical) return canonical;
  return String(phone || '').trim();
}
const { readTaxiMeta } = require('./taxi');
const { deleteChatImageByUrl, purgeExpiredChatImages } = require('../services/chat_media_cleanup');
const { assertAdminAccess } = require('./users');

const SUPPORT_PLATFORM_PHONE = '+9647830889994';

async function isAdminChatPhone(phone) {
  try {
    await assertAdminAccess(phone);
    return true;
  } catch (_) {
    return false;
  }
}

async function getPrimaryAdminReceiverPhone() {
  const envPhones = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = [...envPhones, ...PLATFORM_ADMIN_PHONES];
  for (const candidate of candidates) {
    const trimmed = String(candidate || '').trim();
    if (!trimmed) continue;
    try {
      return await resolvePhoneKey(trimmed);
    } catch (_) {
      return trimmed;
    }
  }
  return SUPPORT_PLATFORM_PHONE;
}

function formatMessage(row) {
  return {
    id: row.id,
    thread_type: row.thread_type,
    thread_id: row.thread_id,
    order_id: row.thread_type === 'order' ? row.thread_id : null,
    sender_phone: row.sender_phone,
    receiver_phone: row.receiver_phone,
    sender_name: row.sender_name,
    message_type: row.message_type || 'text',
    content: row.content,
    created_at: row.created_at,
    read_at: row.read_at || null,
    reply_to: row.reply_to || null,
    reactions: row.reactions || null,
    deleted_at: row.deleted_at || null,
    deleted_by: row.deleted_by || null,
  };
}

function shortThreadId(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length <= 8) return trimmed;
  return trimmed.slice(-8);
}

/** Store thread id: phone | phone|serviceId | phone|serviceId|subEncoded */
function parseStoreThreadId(threadId) {
  const raw = String(threadId || '').trim();
  if (!raw) return { phone: '', serviceId: '', serviceSub: '' };
  const parts = raw.split('|');
  const phone = String(parts[0] || '').trim();
  const serviceId = String(parts[1] || '').trim();
  let serviceSub = '';
  if (parts.length >= 3) {
    try {
      serviceSub = decodeURIComponent(parts.slice(2).join('|')).trim();
    } catch (_) {
      serviceSub = parts.slice(2).join('|').trim();
    }
  }
  return { phone: phone || raw, serviceId, serviceSub };
}

function storeMerchantPhoneFromThreadId(threadId) {
  return parseStoreThreadId(threadId).phone;
}

function storeServiceContextLabelAr(serviceId, serviceSub) {
  const id = String(serviceId || '').trim();
  const sub = String(serviceSub || '').trim();
  if (sub === 'صيدلية' || id === 'pharmacy') return 'من قسم الصيدليات';
  if (sub === 'مختبرات طبية' || id === 'lab') return 'من قسم المختبرات الطبية';
  if (sub === 'أطباء وعيادات') return 'من قسم الأطباء والعيادات';
  if (sub === 'صالون رجالي' || sub === 'صالون نسائي') return 'من قسم الصالونات';
  switch (id) {
    case 'restaurant':
      return 'من قسم المطاعم';
    case 'product':
    case 'global_shopping':
    case 'bazar_ghaith':
      return 'من قسم المتاجر';
    case 'beauty':
      return 'من قسم الصحة والجمال';
    case 'professionals':
      return 'من قسم المهنيين';
    case 'cars':
      return 'من قسم السيارات';
    case 'cars_request':
      return 'من قسم طلب السيارات';
    case 'real_estate':
      return 'من قسم العقارات';
    case 'tourism':
      return 'من قسم السياحة';
    case 'offers':
      return 'من قسم العروض';
    case 'used':
      return 'من قسم المستعمل';
    default:
      return id ? 'محادثة قسم' : 'محادثة متجر';
  }
}

function isStoreMerchantActor(actorPhone, threadId) {
  return phonesOverlap(actorPhone, storeMerchantPhoneFromThreadId(threadId));
}

function orderDisplayNumber(row) {
  const payload = normalizeObject(row?.payload ?? row?.order_payload);
  const explicit =
    payload.orderNumber ||
    payload.order_number ||
    row?.order_number ||
    row?.orderNumber;
  if (explicit) return String(explicit).trim();
  return shortThreadId(row?.id || '');
}

const PLACEHOLDER_SENDER_NAMES = new Set([
  '',
  'مستخدم',
  'زبون',
  'عميل',
  'تاجر',
  'مندوب التوصيل',
  'كابتن طلب',
  'سائق',
  'السائق',
  'سائق طلب',
  'الكابتن',
  'كابتن',
  'متصل',
  'user',
  'customer',
]);

function isPlaceholderPartyName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return true;
  return (
    PLACEHOLDER_SENDER_NAMES.has(cleaned) ||
    PLACEHOLDER_SENDER_NAMES.has(cleaned.toLowerCase())
  );
}

function formatCaptainDisplayName(rawName) {
  const cleaned = String(rawName || '')
    .trim()
    .replace(/^(الكابتن|كابتن|السائق|سائق)\s*/u, '')
    .trim();
  if (!cleaned || isPlaceholderPartyName(cleaned)) return 'كابتن';
  return `كابتن ${cleaned}`;
}

async function resolveDriverDisplayName(driverPhone, meta = {}) {
  const fromMeta = String(
    meta.driverName || meta.driver_name || meta.assignedDriverName || ''
  ).trim();
  if (fromMeta && !isPlaceholderPartyName(fromMeta)) {
    return formatCaptainDisplayName(fromMeta);
  }

  const phone = String(driverPhone || '').trim();
  if (phone) {
    try {
      const { getDriverProfile } = require('./operator_profiles');
      const profile = await getDriverProfile(phone);
      const fromProfile = String(profile?.name || profile?.display_name || '').trim();
      if (fromProfile && !isPlaceholderPartyName(fromProfile)) {
        return formatCaptainDisplayName(fromProfile);
      }
    } catch (_) {}

    const user = await selectSingleByPhone('app_users', phone);
    const fromUser = String(user?.full_name || '').trim();
    if (fromUser && !isPlaceholderPartyName(fromUser)) {
      return formatCaptainDisplayName(fromUser);
    }
  }

  return 'كابتن';
}

async function resolveOtherPartyName(threadType, threadId, otherPartyPhone, fallbackName) {
  const name = String(fallbackName || '').trim();
  if (name && !isPlaceholderPartyName(name)) return name;

  const phone = String(otherPartyPhone || '').trim();
  if (!phone) return name || null;

  if (threadType === 'taxi') {
    const row = threadId
      ? await selectSingle('taxi_requests', 'id', threadId)
      : null;
    const meta = row ? readTaxiMeta(row) : {};
    const driverPhone = meta.driverPhone || row?.driver_phone || '';
    if (driverPhone && phonesOverlap(phone, driverPhone)) {
      return resolveDriverDisplayName(phone, {
        ...meta,
        driverName: meta.driverName || row?.driver_name || '',
      });
    }
  }

  const merchant = await selectSingleByPhone('merchant_profiles', phone);
  if (merchant?.store_name) return String(merchant.store_name).trim();

  const user = await selectSingleByPhone('app_users', phone);
  if (user?.full_name) return String(user.full_name).trim();

  if (threadType === 'store') {
    return merchant?.store_name ? String(merchant.store_name).trim() : 'متجر';
  }

  return name || null;
}

async function buildThreadContext(threadType, threadId, myPhone, otherPartyPhone, fallbackName) {
  const trimmedId = String(threadId || '').trim();
  let contextLabel = 'محادثة داخل التطبيق';
  let threadTitle = null;

  switch (threadType) {
    case 'order': {
      const row = await selectSingle('customer_orders', 'id', trimmedId);
      const orderNo = row ? orderDisplayNumber(row) : shortThreadId(trimmedId);
      contextLabel = row ? `طلب #${orderNo}` : `طلب #${shortThreadId(trimmedId)}`;
      const payload = normalizeObject(row?.order_payload ?? row?.payload);
      const customerPhone =
        row?.customer_phone || payload.customerPhone || payload.customer_phone || '';
      const merchantPhone =
        row?.merchant_phone || payload.merchantPhone || payload.merchant_phone || '';
      if (phonesOverlap(myPhone, customerPhone)) {
        const merchant = merchantPhone
          ? await selectSingleByPhone('merchant_profiles', merchantPhone)
          : null;
        threadTitle = merchant?.store_name
          ? String(merchant.store_name).trim()
          : 'التاجر';
      } else {
        const customer = customerPhone
          ? await selectSingleByPhone('app_users', customerPhone)
          : null;
        threadTitle = customer?.full_name
          ? String(customer.full_name).trim()
          : 'الزبون';
      }
      break;
    }
    case 'taxi': {
      contextLabel = `رحلة تكسي #${shortThreadId(trimmedId)}`;
      const row = await selectSingle('taxi_requests', 'id', trimmedId);
      const meta = row ? readTaxiMeta(row) : {};
      const customerPhone = meta.customerPhone || row?.customer_phone || '';
      const driverPhone = meta.driverPhone || row?.driver_phone || '';
      if (phonesOverlap(myPhone, customerPhone)) {
        threadTitle = await resolveDriverDisplayName(
          driverPhone || otherPartyPhone,
          {
            ...meta,
            driverName: meta.driverName || row?.driver_name || '',
          }
        );
      } else if (phonesOverlap(myPhone, driverPhone)) {
        const customer = customerPhone
          ? await selectSingleByPhone('app_users', customerPhone)
          : null;
        threadTitle = customer?.full_name
          ? String(customer.full_name).trim()
          : 'الزبون';
      } else {
        threadTitle = 'رحلة تكسي';
      }
      break;
    }
    case 'store': {
      const { phone: merchantPhone, serviceId, serviceSub } =
        parseStoreThreadId(trimmedId);
      const merchant = await selectSingleByPhone('merchant_profiles', merchantPhone);
      const storeName = merchant?.store_name
        ? String(merchant.store_name).trim()
        : 'متجر';
      const sectionLabel = storeServiceContextLabelAr(serviceId, serviceSub);
      contextLabel = sectionLabel;
      if (isStoreMerchantActor(myPhone, trimmedId)) {
        const customer = otherPartyPhone
          ? await selectSingleByPhone('app_users', otherPartyPhone)
          : null;
        threadTitle =
          (customer?.full_name && String(customer.full_name).trim()) ||
          String(fallbackName || '').trim() ||
          String(otherPartyPhone || '').trim() ||
          'زبون';
      } else {
        threadTitle = storeName;
      }
      break;
    }
    case 'support': {
      contextLabel = 'دعم العملاء';
      if (await isAdminChatPhone(myPhone)) {
        const user = await selectSingleByPhone('app_users', trimmedId);
        const merchant = user ? null : await selectSingleByPhone('merchant_profiles', trimmedId);
        threadTitle =
          (user?.full_name && String(user.full_name).trim()) ||
          (merchant?.store_name && String(merchant.store_name).trim()) ||
          trimmedId;
      } else {
        threadTitle = 'دعم طلب';
      }
      break;
    }
    default:
      break;
  }

  const resolvedName = await resolveOtherPartyName(
    threadType,
    trimmedId,
    otherPartyPhone,
    threadTitle || fallbackName
  );

  return {
    context_label: contextLabel,
    thread_title: resolvedName || threadTitle || fallbackName || null,
    other_party_name: resolvedName || fallbackName || null,
  };
}

function formatLastMessagePreview(row) {
  const type = String(row.message_type || 'text').trim();
  if (type === 'call') {
    try {
      const parsed = JSON.parse(String(row.content || '{}'));
      const status = String(parsed.status || 'ended').trim();
      if (status === 'missed' || status === 'no_answer') return 'مكالمة فائتة';
      if (status === 'failed') return 'مكالمة · فشل الاتصال';
      const duration = Number.parseInt(String(parsed.durationSeconds ?? 0), 10) || 0;
      if (duration > 0) {
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;
        const clock =
          minutes > 0
            ? `${minutes}:${String(seconds).padStart(2, '0')}`
            : `${seconds} ث`;
        return `مكالمة صوتية · ${clock}`;
      }
      return 'مكالمة صوتية';
    } catch (_) {
      return 'مكالمة صوتية';
    }
  }
  if (type === 'sticker') return 'ملصق';
  if (type === 'image') return 'صورة';
  if (type === 'voice') return '🎤 رسالة صوتية';
  try {
    const parsed = JSON.parse(String(row.content || ''));
    if (parsed && typeof parsed === 'object' && parsed.url && parsed.duration != null) {
      return '🎤 رسالة صوتية';
    }
  } catch (_) {}
  return row.content;
}

function inboxThreadKey(row, myPhone) {
  const type = String(row.thread_type || '').trim();
  const id = String(row.thread_id || '').trim();
  if (type === 'store' && isStoreMerchantActor(myPhone, id)) {
    const other = phonesOverlap(row.sender_phone, myPhone)
      ? String(row.receiver_phone || '').trim()
      : String(row.sender_phone || '').trim();
    const otherKey = phoneIdentityKey(other);
    const merchantKey = phoneIdentityKey(storeMerchantPhoneFromThreadId(id));
    if (otherKey) return `${type}:${id}:${merchantKey}:${otherKey}`;
  }
  return `${type}:${id}`;
}

function summaryThreadKey(summary, myPhone) {
  const type = String(summary.thread_type || '').trim();
  const id = String(summary.thread_id || '').trim();
  if (type === 'store' && isStoreMerchantActor(myPhone, id)) {
    const other = String(summary.other_party_phone || '').trim();
    const otherKey = phoneIdentityKey(other);
    const merchantKey = phoneIdentityKey(storeMerchantPhoneFromThreadId(id));
    if (otherKey) return `${type}:${id}:${merchantKey}:${otherKey}`;
  }
  return `${type}:${id}`;
}

function isUnreadIncoming(row, myPhone) {
  if (phonesOverlap(row.sender_phone, myPhone)) return false;
  if (!phonesOverlap(row.receiver_phone, myPhone)) return false;
  return !row.read_at;
}

function formatThreadSummary(row, myPhone) {
  const mine = phonesOverlap(row.sender_phone, myPhone);
  return {
    thread_type: row.thread_type,
    thread_id: row.thread_id,
    other_party_phone: mine ? row.receiver_phone : row.sender_phone,
    other_party_name: mine ? null : row.sender_name,
    last_message: formatLastMessagePreview(row),
    last_at: row.created_at,
  };
}

function mapChatAccessError(message) {
  const text = String(message || '').trim();
  if (text === 'Store not found.') {
    return 'المتجر غير موجود أو غير مسجّل في التطبيق.';
  }
  if (text === 'Order not found.') {
    return 'الطلب غير موجود على السيرفر.';
  }
  if (text === 'Taxi request not found.') {
    return 'رحلة التكسي غير موجودة.';
  }
  if (text === 'Unauthorized chat access.') {
    return 'غير مصرّح لك بفتح هذه المحادثة.';
  }
  if (text === 'Receiver phone is required for store chat.') {
    return 'تعذّر إرسال الرسالة — رقم المستلم مطلوب لمحادثة المتجر.';
  }
  return text;
}

async function resolveStoreContact(phone) {
  const merchant = await selectSingleByPhone('merchant_profiles', phone);
  if (merchant) return merchant;
  return selectSingleByPhone('app_users', phone);
}

function mapChatDbError(error) {
  const message = String(error?.message || error || '').trim();
  const code = String(error?.code || '').trim();

  const tableMissing =
    code === '42P01' ||
    message.includes('Could not find the table') ||
    (message.includes('relation') &&
      message.includes('chat_messages') &&
      message.includes('does not exist'));

  if (tableMissing) {
    return 'جدول المحادثات غير منشأ في Supabase. نفّذ ملف supabase/chat_messages.sql ثم أعد المحاولة.';
  }

  const schemaOutdated =
    code === '42703' ||
    code === 'PGRST204' ||
    (message.includes('chat_messages') && message.includes('does not exist')) ||
    (message.toLowerCase().includes('schema cache') &&
      message.includes('chat_messages'));

  if (schemaOutdated) {
    return 'جدول المحادثات يحتاج تحديثاً. نفّذ في Supabase SQL Editor ملف supabase/chat_messages.sql ثم أعد المحاولة.';
  }

  return message || 'Failed to save chat message.';
}

async function assertCanAccessThread(threadType, threadId, requestPhone) {
  const { evaluateThreadAccess } = require('../lib/db_auth_policy');
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedId = String(threadId || '').trim();
  if (!trimmedId) {
    throw new Error('Thread id is required.');
  }

  switch (threadType) {
    case 'order': {
      const row = await selectSingle('customer_orders', 'id', trimmedId);
      if (!row) throw new Error('Order not found.');
      const payload = normalizeObject(row.order_payload || row.payload);
      const decision = evaluateThreadAccess({
        threadType: 'order',
        actorPhone: phone,
        threadId: trimmedId,
        parties: {
          customerPhone:
            row.phone || row.customer_phone || payload.customerPhone || payload.customer_phone || '',
          merchantPhone:
            row.merchant_phone || payload.merchantPhone || payload.merchant_phone || '',
          courierPhone:
            row.courier_phone || payload.courierPhone || payload.courier_phone || '',
        },
      });
      if (!decision.allowed) throw new Error(decision.reason || 'Unauthorized chat access.');
      return;
    }
    case 'taxi': {
      const row = await selectSingle('taxi_requests', 'id', trimmedId);
      if (!row) throw new Error('Taxi request not found.');
      const meta = readTaxiMeta(row);
      const decision = evaluateThreadAccess({
        threadType: 'taxi',
        actorPhone: phone,
        threadId: trimmedId,
        parties: {
          customerPhone: meta.customerPhone || row.customer_phone || '',
          driverPhone: meta.driverPhone || row.driver_phone || '',
        },
      });
      if (!decision.allowed) throw new Error(decision.reason || 'Unauthorized chat access.');
      return;
    }
    case 'store': {
      const contact = await resolveStoreContact(
        storeMerchantPhoneFromThreadId(trimmedId)
      );
      if (!contact) throw new Error('Store not found.');
      const decision = evaluateThreadAccess({
        threadType: 'store',
        actorPhone: phone,
        threadId: trimmedId,
        parties: { merchantPhone: storeMerchantPhoneFromThreadId(trimmedId) },
      });
      if (!decision.allowed) throw new Error(decision.reason || 'Unauthorized chat access.');
      return;
    }
    case 'support': {
      const decision = evaluateThreadAccess({
        threadType: 'support',
        actorPhone: phone,
        threadId: trimmedId,
        isAdmin: await isAdminChatPhone(phone),
      });
      if (!decision.allowed) throw new Error(decision.reason || 'Unauthorized chat access.');
      return;
    }
    default:
      throw new Error('Invalid thread type.');
  }
}

async function resolveReceiverPhone(threadType, threadId, senderPhone, explicitReceiver) {
  const explicit = String(explicitReceiver || '').trim();
  if (explicit) return await resolvePhoneKey(explicit);

  const sender = await resolvePhoneKey(senderPhone);
  const trimmedId = String(threadId || '').trim();

  switch (threadType) {
    case 'order': {
      const row = await selectSingle('customer_orders', 'id', trimmedId);
      if (!row) return null;
      const payload = normalizeObject(row.order_payload ?? row.payload);
      const customerPhone =
        row.customer_phone || payload.customerPhone || payload.customer_phone || '';
      const merchantPhone =
        row.merchant_phone || payload.merchantPhone || payload.merchant_phone || '';
      if (phonesOverlap(sender, customerPhone)) return merchantPhone || null;
      if (phonesOverlap(sender, merchantPhone)) return customerPhone || null;
      const courierPhone =
        row.courier_phone || payload.courierPhone || payload.courier_phone || '';
      if (phonesOverlap(sender, courierPhone)) {
        return customerPhone || merchantPhone || null;
      }
      return merchantPhone || customerPhone || null;
    }
    case 'taxi': {
      const row = await selectSingle('taxi_requests', 'id', trimmedId);
      if (!row) return null;
      const meta = readTaxiMeta(row);
      const customerPhone = meta.customerPhone || row.customer_phone || '';
      const driverPhone = meta.driverPhone || row.driver_phone || '';
      if (phonesOverlap(sender, customerPhone)) return driverPhone || null;
      if (phonesOverlap(sender, driverPhone)) return customerPhone || null;
      return driverPhone || customerPhone || null;
    }
    case 'store': {
      // Customer → store: receiver is the merchant phone (from thread id).
      // Merchant → customer: explicit receiver is required (handled above).
      const merchantPhone = storeMerchantPhoneFromThreadId(trimmedId);
      if (phonesOverlap(sender, merchantPhone)) {
        throw new Error('Receiver phone is required for store chat.');
      }
      return merchantPhone;
    }
    case 'support': {
      if (await isAdminChatPhone(sender)) {
        return await resolvePhoneKey(trimmedId);
      }
      return await getPrimaryAdminReceiverPhone();
    }
    default:
      return null;
  }
}

async function getChatMessages(threadType, threadId, requestPhone, options = {}) {
  purgeExpiredChatImages({ batchSize: 50 }).catch(() => {});
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedType = String(threadType || '').trim();
  const trimmedId = String(threadId || '').trim();
  await assertCanAccessThread(trimmedType, trimmedId, phone);

  const limitNum = Math.min(Math.max(Number(options.limit) || 30, 1), 100);
  const offsetNum = Math.max(Number(options.offset) || 0, 0);
  const afterTimestamp = String(options.after || '').trim();
  const beforeTimestamp = String(options.before || '').trim();
  const otherPartyPhone = String(options.otherPartyPhone || '').trim();

  const supabase = assertSupabaseAdmin();

  // Store merchant inboxes share one thread_id (merchant phone). Fetch a wider
  // window then filter to the requested customer pair.
  const storeMerchantInbox =
    trimmedType === 'store' &&
    isStoreMerchantActor(phone, trimmedId) &&
    otherPartyPhone;
  const fetchLimit = storeMerchantInbox
    ? Math.min(Math.max(limitNum * 8, 80), 400)
    : limitNum;

  let query = supabase
    .from('chat_messages')
    .select('*')
    .eq('thread_type', trimmedType)
    .eq('thread_id', trimmedId)
    .order('created_at', { ascending: false });

  if (afterTimestamp) {
    query = query.gt('created_at', afterTimestamp).limit(limitNum);
  } else if (beforeTimestamp) {
    query = query.lt('created_at', beforeTimestamp).limit(limitNum);
  } else if (offsetNum > 0 && !storeMerchantInbox) {
    query = query.range(offsetNum, offsetNum + limitNum - 1);
  } else {
    query = query.limit(fetchLimit);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let rows = data || [];

  if (trimmedType === 'store') {
    if (isStoreMerchantActor(phone, trimmedId)) {
      if (otherPartyPhone) {
        const otherKey = await resolvePhoneKey(otherPartyPhone);
        rows = rows.filter(
          (row) =>
            (phonesOverlap(phone, row.sender_phone) &&
              phonesOverlap(otherKey, row.receiver_phone)) ||
            (phonesOverlap(phone, row.receiver_phone) &&
              phonesOverlap(otherKey, row.sender_phone))
        );
        if (offsetNum > 0) {
          rows = rows.slice(offsetNum, offsetNum + limitNum);
        } else if (rows.length > limitNum) {
          rows = rows.slice(0, limitNum);
        }
      }
    } else {
      rows = rows.filter(
        (row) =>
          phonesOverlap(phone, row.sender_phone) ||
          phonesOverlap(phone, row.receiver_phone)
      );
    }
  }
  return rows.map(formatMessage);
}

const INBOX_COLUMNS_BASE =
  'id, thread_type, thread_id, sender_phone, receiver_phone, sender_name, content, message_type, created_at';

function isMissingColumnError(error, column) {
  const message = String(error?.message || '');
  const code = String(error?.code || '');
  const mentionsColumn = message.includes(column);
  if (!mentionsColumn) return false;
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    message.toLowerCase().includes('schema cache') ||
    message.toLowerCase().includes('could not find')
  );
}

async function fetchInboxSide(supabase, phoneColumn, variants) {
  const run = (select) =>
    supabase
      .from('chat_messages')
      .select(select)
      .in(phoneColumn, variants)
      .order('created_at', { ascending: false })
      .limit(500);

  let result = await run(`${INBOX_COLUMNS_BASE}, read_at`);
  if (result.error && isMissingColumnError(result.error, 'read_at')) {
    result = await run(INBOX_COLUMNS_BASE);
  }
  if (result.error && isMissingColumnError(result.error, 'sender_name')) {
    result = await run(
      'id, thread_type, thread_id, sender_phone, receiver_phone, content, message_type, created_at'
    );
  }
  return result;
}

async function getChatInbox(requestPhone) {
  purgeExpiredChatImages({ batchSize: 50 }).catch(() => {});
  const phone = await resolvePhoneKey(requestPhone);
  const variants = getPhoneVariants(phone);
  if (variants.length === 0) return [];

  const supabase = assertSupabaseAdmin();

  const [sentResult, receivedResult] = await Promise.all([
    fetchInboxSide(supabase, 'sender_phone', variants),
    fetchInboxSide(supabase, 'receiver_phone', variants),
  ]);

  const error = sentResult.error || receivedResult.error;
  if (error) throw new Error(mapChatDbError(error));

  const combined = [...(sentResult.data || []), ...(receivedResult.data || [])];
  combined.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const threads = new Map();
  const unreadCounts = new Map();
  for (const row of combined) {
    const key = inboxThreadKey(row, phone);
    if (!threads.has(key)) {
      threads.set(key, formatThreadSummary(row, phone));
    }
    if (isUnreadIncoming(row, phone)) {
      unreadCounts.set(key, (unreadCounts.get(key) || 0) + 1);
    }
  }

  const summaries = Array.from(threads.values());
  const enriched = await Promise.all(
    summaries.map(async (summary) => {
      const context = await buildThreadContext(
        summary.thread_type,
        summary.thread_id,
        phone,
        summary.other_party_phone,
        summary.other_party_name
      );
      const key = summaryThreadKey(summary, phone);
      const unreadCount = unreadCounts.get(key) || 0;
      return {
        ...summary,
        ...context,
        unread_count: unreadCount,
        has_unread: unreadCount > 0,
      };
    })
  );

  return enriched.sort(
    (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
  );
}

async function saveChatMessage(payload) {
  const threadType = String(payload.threadType || payload.thread_type || 'order').trim();
  const threadId = String(payload.threadId || payload.thread_id || payload.orderId || '').trim();
  const senderPhone = await resolvePhoneKey(payload.senderPhone);
  const content = String(payload.content || '').trim();
  const messageType = String(payload.messageType || payload.message_type || 'text').trim();

  if (!threadId) throw new Error('Thread id is required.');
  if (!content) throw new Error('Message content is required.');
  if (!senderPhone) throw new Error('Unauthorized.');

  const senderName = await resolveSenderDisplayName(senderPhone, payload);
  if (!senderName) {
    throw new Error(
      'أكمل ملفك الشخصي (الاسم ورقم الهاتف) قبل إرسال الرسائل في المحادثة.'
    );
  }

  await assertCanAccessThread(threadType, threadId, senderPhone);

  const receiverPhone = await resolveReceiverPhone(
    threadType,
    threadId,
    senderPhone,
    payload.receiverPhone
  );

  const supabase = assertSupabaseAdmin();
  const insertPayload = {
    thread_type: threadType,
    thread_id: threadId,
    sender_phone: senderPhone,
    receiver_phone: receiverPhone ? await resolvePhoneKey(receiverPhone) : null,
    sender_name: senderName,
    message_type: messageType || 'text',
    content,
  };
  const replyToRaw = String(payload.replyTo ?? payload.reply_to ?? '').trim();
  if (replyToRaw && isUuid(replyToRaw)) {
    insertPayload.reply_to = replyToRaw;
  }

  const { data, error } = await supabase
    .from('chat_messages')
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw new Error(mapChatDbError(error));
  return formatMessage(data);
}

function isRealSenderName(name) {
  const cleaned = String(name || '').trim();
  if (cleaned.length < 2) return false;
  return !PLACEHOLDER_SENDER_NAMES.has(cleaned) &&
    !PLACEHOLDER_SENDER_NAMES.has(cleaned.toLowerCase());
}

async function resolveSenderDisplayName(senderPhone, payload) {
  const fromPayload = String(payload.senderName || payload.sender_name || '').trim();
  if (isRealSenderName(fromPayload)) return fromPayload;

  try {
    const { getAppUser } = require('./users');
    const user = await getAppUser(senderPhone);
    const fromUser = String(user?.full_name || user?.fullName || '').trim();
    if (isRealSenderName(fromUser)) return fromUser;
  } catch (_) {}

  try {
    const { getCustomerProfile } = require('./customer_data');
    if (typeof getCustomerProfile === 'function') {
      const profile = await getCustomerProfile(senderPhone);
      const fromProfile = String(
        profile?.display_name ||
          profile?.displayName ||
          profile?.full_name ||
          profile?.fullName ||
          profile?.name ||
          ''
      ).trim();
      if (isRealSenderName(fromProfile)) return fromProfile;
    }
  } catch (_) {}

  try {
    const { getMerchantProfile } = require('./merchants');
    const merchant = await getMerchantProfile(senderPhone);
    const store = String(merchant?.store_name || merchant?.storeName || '').trim();
    if (isRealSenderName(store)) return store;
  } catch (_) {}

  try {
    const { getDriverProfile } = require('./operator_profiles');
    const driver = await getDriverProfile(senderPhone);
    const driverName = String(driver?.name || driver?.display_name || '').trim();
    if (isRealSenderName(driverName)) return formatCaptainDisplayName(driverName);
  } catch (_) {}

  return '';
}

async function appendTaxiArrivedSystemMessage({
  requestId,
  driverPhone,
  customerPhone,
  driverName,
}) {
  const threadType = 'taxi';
  const threadId = String(requestId || '').trim();
  const driver = String(driverPhone || '').trim();
  const customer = String(customerPhone || '').trim();
  if (!threadId || !driver || !customer) return null;

  const supabase = assertSupabaseAdmin();
  const { data: existing, error: readError } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('thread_type', threadType)
    .eq('thread_id', threadId)
    .eq('message_type', 'system')
    .eq('content', 'لقد وصلت')
    .limit(1);
  if (readError) throw new Error(mapChatDbError(readError));
  if (Array.isArray(existing) && existing.length > 0) return null;

  const driverKey = await resolvePhoneKey(driver);
  const customerKey = await resolvePhoneKey(customer);
  const captainName = await resolveDriverDisplayName(driverKey, { driverName });

  const insertPayload = {
    thread_type: threadType,
    thread_id: threadId,
    sender_phone: driverKey,
    receiver_phone: customerKey,
    sender_name: captainName,
    message_type: 'system',
    content: 'لقد وصلت',
  };

  const { data, error } = await supabase
    .from('chat_messages')
    .insert(insertPayload)
    .select()
    .single();
  if (error) throw new Error(mapChatDbError(error));
  return formatMessage(data);
}

async function appendCallChatEvent(callLogRow) {
  const row = callLogRow || {};
  const threadType = String(row.thread_type || '').trim();
  const threadId = String(row.thread_id || '').trim();
  const callLogId = String(row.id || '').trim();
  if (!threadType || !threadId || !callLogId) return null;

  const status = String(row.status || '').trim();
  if (!['ended', 'missed', 'no_answer', 'failed'].includes(status)) return null;

  const supabase = assertSupabaseAdmin();
  const { data: recent, error: readError } = await supabase
    .from('chat_messages')
    .select('id, content')
    .eq('thread_type', threadType)
    .eq('thread_id', threadId)
    .eq('message_type', 'call')
    .order('created_at', { ascending: false })
    .limit(30);
  if (readError) throw new Error(mapChatDbError(readError));

  for (const item of recent || []) {
    try {
      const parsed = JSON.parse(String(item.content || '{}'));
      if (String(parsed.callLogId || '') === callLogId) return null;
    } catch (_) {}
  }

  const content = JSON.stringify({
    callLogId,
    status,
    durationSeconds: row.duration_seconds ?? 0,
    direction: row.direction || 'outgoing',
  });

  return saveChatMessage({
    threadType,
    threadId,
    senderPhone: row.caller_phone,
    receiverPhone: row.receiver_phone,
    senderName: row.caller_name,
    messageType: 'call',
    content,
  });
}

async function markThreadAsRead(threadType, threadId, requestPhone, otherPartyPhone) {
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedType = String(threadType || '').trim();
  const trimmedId = String(threadId || '').trim();
  if (!trimmedId) throw new Error('Thread id is required.');

  await assertCanAccessThread(trimmedType, trimmedId, phone);

  const supabase = assertSupabaseAdmin();
  const receiverVariants = getPhoneVariants(phone);
  if (receiverVariants.length === 0) return { success: true, updated: 0 };

  let query = supabase
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('thread_type', trimmedType)
    .eq('thread_id', trimmedId)
    .in('receiver_phone', receiverVariants)
    .is('read_at', null);

  if (trimmedType === 'store' && isStoreMerchantActor(phone, trimmedId)) {
    const other = String(otherPartyPhone || '').trim();
    if (other) {
      const senderVariants = getPhoneVariants(await resolvePhoneKey(other));
      if (senderVariants.length > 0) {
        query = query.in('sender_phone', senderVariants);
      }
    }
  }

  if (trimmedType === 'support' && (await isAdminChatPhone(phone))) {
    const resolvedUser = await resolvePhoneKey(trimmedId);
    const userVariants = getPhoneVariants(resolvedUser);
    const threadVariants = [
      ...new Set([trimmedId, resolvedUser, ...userVariants].map((v) => String(v || '').trim()).filter(Boolean)),
    ];
    if (userVariants.length > 0 && threadVariants.length > 0) {
      const { data, error } = await supabase
        .from('chat_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('thread_type', 'support')
        .in('thread_id', threadVariants)
        .in('sender_phone', userVariants)
        .is('read_at', null)
        .select('id');
      if (error) {
        if (isMissingColumnError(error, 'read_at')) {
          return { success: true, updated: 0, read_at_supported: false };
        }
        throw new Error(mapChatDbError(error));
      }
      return {
        success: true,
        updated: Array.isArray(data) ? data.length : 0,
        read_at_supported: true,
      };
    }
  }

  const { data, error } = await query.select('id');
  if (error) {
    if (isMissingColumnError(error, 'read_at')) {
      return { success: true, updated: 0, read_at_supported: false };
    }
    throw new Error(mapChatDbError(error));
  }

  return {
    success: true,
    updated: Array.isArray(data) ? data.length : 0,
    read_at_supported: true,
  };
}

function threadRowMatchesDeleteScope(row, phone, threadType, threadId, otherPartyPhone) {
  if (String(row.thread_type || '').trim() !== String(threadType || '').trim()) {
    return false;
  }
  if (String(row.thread_id || '').trim() !== String(threadId || '').trim()) {
    return false;
  }

  if (threadType === 'store') {
    const merchantPhone = storeMerchantPhoneFromThreadId(threadId);
    if (phonesOverlap(merchantPhone, phone)) {
      const other = String(otherPartyPhone || '').trim();
      if (!other) return false;
      return (
        (phonesOverlap(row.sender_phone, phone) && phonesOverlap(row.receiver_phone, other)) ||
        (phonesOverlap(row.receiver_phone, phone) && phonesOverlap(row.sender_phone, other))
      );
    }
    return phonesOverlap(row.sender_phone, phone) || phonesOverlap(row.receiver_phone, phone);
  }

  return true;
}

function callLogMatchesDeleteScope(row, phone, threadType, threadId, otherPartyPhone) {
  if (threadType !== 'store') return true;
  if (isStoreMerchantActor(phone, threadId)) {
    const other = String(otherPartyPhone || '').trim();
    if (!other) return false;
    return (
      (phonesOverlap(row.caller_phone, phone) && phonesOverlap(row.receiver_phone, other)) ||
      (phonesOverlap(row.receiver_phone, phone) && phonesOverlap(row.caller_phone, other))
    );
  }
  return phonesOverlap(row.caller_phone, phone) || phonesOverlap(row.receiver_phone, phone);
}

async function deleteChatThread(threadType, threadId, requestPhone, otherPartyPhone) {
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedType = String(threadType || '').trim();
  const trimmedId = String(threadId || '').trim();
  if (!trimmedId) throw new Error('Thread id is required.');

  await assertCanAccessThread(trimmedType, trimmedId, phone);

  const supabase = assertSupabaseAdmin();
  const { data: rows, error: readError } = await supabase
    .from('chat_messages')
    .select('id, content, message_type, sender_phone, receiver_phone, thread_type, thread_id')
    .eq('thread_type', trimmedType)
    .eq('thread_id', trimmedId);

  if (readError) throw new Error(mapChatDbError(readError));

  const toDelete = (rows || []).filter((row) =>
    threadRowMatchesDeleteScope(row, phone, trimmedType, trimmedId, otherPartyPhone)
  );

  for (const row of toDelete) {
    if (String(row.message_type || '').trim() === 'image') {
      try {
        await deleteChatImageByUrl(row.content);
      } catch (cleanupError) {
        console.warn('delete chat image:', cleanupError?.message || cleanupError);
      }
    }
  }

  const ids = toDelete.map((row) => row.id);
  if (ids.length > 0) {
    const { error: deleteMessagesError } = await supabase
      .from('chat_messages')
      .delete()
      .in('id', ids);
    if (deleteMessagesError) throw new Error(mapChatDbError(deleteMessagesError));
  }

  let callLogsDeleted = 0;
  try {
    const { data: callRows, error: callReadError } = await supabase
      .from('voice_call_logs')
      .select('id, caller_phone, receiver_phone')
      .eq('thread_type', trimmedType)
      .eq('thread_id', trimmedId);
    if (!callReadError && Array.isArray(callRows)) {
      const callIds = callRows
        .filter((row) =>
          callLogMatchesDeleteScope(row, phone, trimmedType, trimmedId, otherPartyPhone)
        )
        .map((row) => row.id);
      if (callIds.length > 0) {
        const { error: callDeleteError } = await supabase
          .from('voice_call_logs')
          .delete()
          .in('id', callIds);
        if (!callDeleteError) callLogsDeleted = callIds.length;
      }
    }
  } catch (_) {}

  return {
    success: true,
    deleted_messages: ids.length,
    deleted_call_logs: callLogsDeleted,
  };
}

async function markAllThreadsAsRead(requestPhone) {
  const phone = await resolvePhoneKey(requestPhone);
  const receiverVariants = getPhoneVariants(phone);
  if (receiverVariants.length === 0) return { success: true, updated: 0 };

  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() })
    .in('receiver_phone', receiverVariants)
    .is('read_at', null)
    .select('id');

  if (error) {
    if (isMissingColumnError(error, 'read_at')) {
      return { success: true, updated: 0, read_at_supported: false };
    }
    throw new Error(mapChatDbError(error));
  }
  return {
    success: true,
    updated: data ? data.length : 0,
    read_at_supported: true,
  };
}

function formatSupportThreadForAdmin(row, allRows) {
  const threadId = String(row.thread_id || '').trim();
  const threadRows = allRows.filter(
    (item) => String(item.thread_id || '').trim() === threadId
  );
  const userVariants = new Set();
  for (const variant of getPhoneVariants(threadId)) {
    userVariants.add(variant);
  }

  let unreadCount = 0;
  for (const item of threadRows) {
    const fromUser = getPhoneVariants(item.sender_phone).some((variant) =>
      userVariants.has(variant)
    );
    if (fromUser && !item.read_at) unreadCount += 1;
  }

  const latest = threadRows.reduce((best, item) => {
    if (!best) return item;
    return new Date(item.created_at).getTime() > new Date(best.created_at).getTime()
      ? item
      : best;
  }, null);

  const lastFromUser = latest
    ? getPhoneVariants(latest.sender_phone).some((variant) => userVariants.has(variant))
    : false;

  return {
    thread_type: 'support',
    thread_id: threadId,
    other_party_phone: threadId,
    other_party_name: lastFromUser ? latest?.sender_name : null,
    last_message: latest ? formatLastMessagePreview(latest) : '',
    last_at: latest?.created_at || row.created_at,
    unread_count: unreadCount,
    has_unread: unreadCount > 0,
  };
}

async function getSupportThreadsForAdmin(adminPhone) {
  await assertAdminAccess(adminPhone);
  const supabase = assertSupabaseAdmin();

  let result = await supabase
    .from('chat_messages')
    .select(`${INBOX_COLUMNS_BASE}, read_at`)
    .eq('thread_type', 'support')
    .order('created_at', { ascending: false })
    .limit(500);

  if (result.error && isMissingColumnError(result.error, 'read_at')) {
    result = await supabase
      .from('chat_messages')
      .select(INBOX_COLUMNS_BASE)
      .eq('thread_type', 'support')
      .order('created_at', { ascending: false })
      .limit(500);
  }
  if (result.error && isMissingColumnError(result.error, 'sender_name')) {
    result = await supabase
      .from('chat_messages')
      .select(
        'id, thread_type, thread_id, sender_phone, receiver_phone, content, message_type, created_at'
      )
      .eq('thread_type', 'support')
      .order('created_at', { ascending: false })
      .limit(500);
  }
  if (result.error) throw new Error(mapChatDbError(result.error));

  const rows = result.data || [];
  const threads = new Map();
  for (const row of rows) {
    const key = String(row.thread_id || '').trim();
    if (!key || threads.has(key)) continue;
    threads.set(key, formatSupportThreadForAdmin(row, rows));
  }

  const summaries = Array.from(threads.values());
  const enriched = await Promise.all(
    summaries.map(async (summary) => {
      const context = await buildThreadContext(
        'support',
        summary.thread_id,
        adminPhone,
        summary.other_party_phone,
        summary.other_party_name
      );
      return {
        ...summary,
        ...context,
        other_party_name:
          context.other_party_name ||
          context.thread_title ||
          summary.other_party_name ||
          summary.thread_id,
      };
    })
  );

  return enriched.sort(
    (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
  );
}

async function getUnreadCount(requestPhone) {
  const phone = await resolvePhoneKey(requestPhone);
  const receiverVariants = getPhoneVariants(phone);
  if (receiverVariants.length === 0) return { totalUnread: 0 };

  const supabase = assertSupabaseAdmin();
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .in('receiver_phone', receiverVariants)
    .is('read_at', null);

  if (error) {
    if (isMissingColumnError(error, 'read_at')) {
      return { totalUnread: 0, read_at_supported: false };
    }
    throw new Error(mapChatDbError(error));
  }
  return { totalUnread: count ?? 0, read_at_supported: true };
}

/** حذف رسالتي (حذف ناعم: deleted_at + deleted_by) — فقط مرسل الرسالة. */
async function deleteChatMessage(threadType, threadId, messageId, requestPhone) {
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedType = String(threadType || '').trim();
  const trimmedId = String(threadId || '').trim();
  const trimmedMessageId = String(messageId || '').trim();
  if (!trimmedId || !trimmedMessageId) {
    throw new Error('Thread id and message id are required.');
  }
  await assertCanAccessThread(trimmedType, trimmedId, phone);

  const supabase = assertSupabaseAdmin();
  const senderVariants = getPhoneVariants(phone);
  const { data, error } = await supabase
    .from('chat_messages')
    .update({ deleted_at: new Date().toISOString(), deleted_by: phone })
    .eq('thread_type', trimmedType)
    .eq('thread_id', trimmedId)
    .eq('id', trimmedMessageId)
    .in('sender_phone', senderVariants)
    .is('deleted_at', null)
    .select()
    .single();
  if (error) throw new Error(mapChatDbError(error));
  if (!data) {
    const err = new Error('Message not found or you are not its sender.');
    err.statusCode = 404;
    throw err;
  }
  return { success: true, id: data.id, deleted_at: data.deleted_at };
}

/** إضافة/إزالة تفاعل إيموجي على رسالة (من كلا الطرفين). */
async function toggleChatReaction(threadType, threadId, messageId, requestPhone, emoji) {
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedType = String(threadType || '').trim();
  const trimmedId = String(threadId || '').trim();
  const trimmedMessageId = String(messageId || '').trim();
  const trimmedEmoji = String(emoji || '').trim();
  if (!trimmedId || !trimmedMessageId || !trimmedEmoji) {
    throw new Error('Thread id, message id and emoji are required.');
  }
  await assertCanAccessThread(trimmedType, trimmedId, phone);

  const supabase = assertSupabaseAdmin();
  const { data: row } = await supabase
    .from('chat_messages')
    .select('id, reactions')
    .eq('thread_type', trimmedType)
    .eq('thread_id', trimmedId)
    .eq('id', trimmedMessageId)
    .maybeSingle();
  if (!row) throw new Error('Message not found.');

  const reactions = normalizeObject(row.reactions);
  let phones = Array.isArray(reactions[trimmedEmoji])
    ? reactions[trimmedEmoji].map((p) => String(p))
    : [];
  const already = phones.some((p) => phonesOverlap(p, phone));
  if (already) {
    phones = phones.filter((p) => !phonesOverlap(p, phone));
  } else {
    phones.push(phone);
  }
  const next = { ...reactions };
  if (phones.length === 0) {
    delete next[trimmedEmoji];
  } else {
    next[trimmedEmoji] = phones;
  }

  const { data: updated, error } = await supabase
    .from('chat_messages')
    .update({ reactions: next })
    .eq('id', trimmedMessageId)
    .select()
    .single();
  if (error) throw new Error(mapChatDbError(error));

  return {
    success: true,
    id: updated.id,
    reactions: next,
    myEmoji: already ? null : trimmedEmoji,
  };
}

/** بحث نصي داخل المحادثة. */
async function searchChatMessages(threadType, threadId, requestPhone, query) {
  const phone = await resolvePhoneKey(requestPhone);
  const trimmedType = String(threadType || '').trim();
  const trimmedId = String(threadId || '').trim();
  const trimmedQuery = String(query || '').trim().slice(0, 100);
  if (!trimmedId) throw new Error('Thread id is required.');
  await assertCanAccessThread(trimmedType, trimmedId, phone);

  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('thread_type', trimmedType)
    .eq('thread_id', trimmedId)
    .ilike('content', `%${trimmedQuery}%`)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(mapChatDbError(error));
  return (data || []).map(formatMessage).filter((m) => !m.deleted_at);
}

module.exports = {
  getChatMessages,
  getChatInbox,
  getSupportThreadsForAdmin,
  saveChatMessage,
  appendTaxiArrivedSystemMessage,
  appendCallChatEvent,
  markThreadAsRead,
  markAllThreadsAsRead,
  getUnreadCount,
  deleteChatThread,
  deleteChatMessage,
  toggleChatReaction,
  searchChatMessages,
  resolveReceiverPhone,
  assertCanAccessThread,
  isAdminChatPhone,
  mapChatAccessError,
  SUPPORT_PLATFORM_PHONE,
};
