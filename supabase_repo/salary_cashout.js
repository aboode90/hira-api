const {
  nowIso,
  resolvePhoneKey,
  getPhoneVariants,
  selectMany,
  selectSingle,
  saveRow,
  assertSupabaseAdmin,
} = require('./common');
const { getAppUser } = require('./users');

const STATUS = Object.freeze({
  PENDING_OUTLET: 'pending_outlet',
  REJECTED_OUTLET: 'rejected_outlet',
  ACCEPTED_OUTLET: 'accepted_outlet',
  ASSIGNED_COURIER: 'assigned_courier',
  ON_WAY: 'on_way',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

function mapRequestRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    requestType: String(row.request_type || 'salary_cashout'),
    customerPhone: String(row.customer_phone || ''),
    contactPhone: row.contact_phone ? String(row.contact_phone) : '',
    fullName: String(row.full_name || ''),
    amountIqd: Number(row.amount_iqd || 0),
    customerLat: Number(row.customer_lat),
    customerLng: Number(row.customer_lng),
    addressText: row.address_text ? String(row.address_text) : '',
    landmark: row.landmark ? String(row.landmark) : '',
    statusKey: String(row.status_key || STATUS.PENDING_OUTLET),
    outletPhone: row.outlet_phone ? String(row.outlet_phone) : '',
    courierPhone: row.courier_phone ? String(row.courier_phone) : '',
    outletDecidedAt: row.outlet_decided_at || null,
    courierAcceptedAt: row.courier_accepted_at || null,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
    note: row.note ? String(row.note) : '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeRequestType(raw) {
  const value = String(raw || '').trim();
  return value === 'card_topup' ? 'card_topup' : 'salary_cashout';
}

function normalizeContactPhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (/^07\d{9}$/.test(digits)) return digits;
  if (/^9647\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^7\d{9}$/.test(digits)) return `0${digits}`;
  return digits;
}

async function createSalaryCashoutRequest(customerPhone, payload = {}) {
  const phoneKey = await resolvePhoneKey(customerPhone);
  const requestType = normalizeRequestType(
    payload.requestType ?? payload.request_type,
  );
  const fullName = String(payload.fullName ?? payload.full_name ?? '').trim();
  const amountIqd = Number.parseInt(
    String(payload.amountIqd ?? payload.amount_iqd ?? ''),
    10,
  );
  const customerLat = Number(payload.customerLat ?? payload.customer_lat);
  const customerLng = Number(payload.customerLng ?? payload.customer_lng);
  const landmark = String(payload.landmark ?? '').trim();
  const addressText = String(
    payload.addressText ?? payload.address_text ?? '',
  ).trim();
  const contactPhone = normalizeContactPhone(
    payload.contactPhone ?? payload.contact_phone,
  );

  if (!fullName || fullName.split(/\s+/).filter(Boolean).length < 3) {
    throw new Error('يرجى إدخال الاسم الثلاثي كاملاً.');
  }
  if (!Number.isFinite(amountIqd) || amountIqd <= 0) {
    throw new Error('يرجى إدخال مبلغ تقريبي صحيح.');
  }
  if (!Number.isFinite(customerLat) || !Number.isFinite(customerLng)) {
    throw new Error('يرجى تحديد موقعك على الخريطة.');
  }
  if (requestType === 'card_topup') {
    if (!/^07\d{9}$/.test(contactPhone)) {
      throw new Error('يرجى إدخال رقم هاتف عراقي صحيح.');
    }
    if (addressText.length < 5) {
      throw new Error('يرجى إدخال العنوان كتابةً.');
    }
  }

  const row = {
    customer_phone: phoneKey,
    request_type: requestType,
    contact_phone: contactPhone || null,
    full_name: fullName,
    amount_iqd: amountIqd,
    customer_lat: customerLat,
    customer_lng: customerLng,
    address_text: addressText || null,
    landmark: landmark || null,
    status_key: STATUS.PENDING_OUTLET,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const saved = await saveRow('salary_cashout_requests', row, 'id');
  return mapRequestRow(saved);
}

async function listCustomerSalaryCashoutRequests(customerPhone) {
  const phoneKey = await resolvePhoneKey(customerPhone);
  const variants = getPhoneVariants(phoneKey);
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await selectMany(
    'salary_cashout_requests',
    [
      { method: 'in', column: 'customer_phone', value: variants },
      { method: 'gte', column: 'created_at', value: sinceIso },
    ],
    { column: 'created_at', ascending: false },
    40,
  );
  return rows.map(mapRequestRow);
}

async function listOutletPendingRequests(outletPhone) {
  await assertOutletAccess(outletPhone);
  const rows = await selectMany(
    'salary_cashout_requests',
    [{ method: 'eq', column: 'status_key', value: STATUS.PENDING_OUTLET }],
    { column: 'created_at', ascending: true },
    50,
  );
  return rows.map(mapRequestRow);
}

async function listOutletActiveRequests(outletPhone) {
  const phoneKey = await resolvePhoneKey(outletPhone);
  await assertOutletAccess(phoneKey);
  const variants = getPhoneVariants(phoneKey);
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await selectMany(
    'salary_cashout_requests',
    [
      { method: 'in', column: 'outlet_phone', value: variants },
      { method: 'gte', column: 'created_at', value: sinceIso },
    ],
    { column: 'created_at', ascending: false },
    50,
  );
  return rows
    .filter((row) =>
      [
        STATUS.ACCEPTED_OUTLET,
        STATUS.ASSIGNED_COURIER,
        STATUS.ON_WAY,
        STATUS.COMPLETED,
      ].includes(String(row.status_key)),
    )
    .map(mapRequestRow);
}

async function assertOutletAccess(outletPhone) {
  const phoneKey = await resolvePhoneKey(outletPhone);
  const user = await getAppUser(phoneKey);
  const role = String(user?.role || '').trim();
  if (role !== 'salary_outlet' && role !== 'admin') {
    throw new Error('هذا الحساب ليس منفذ صرف رواتب.');
  }
  return phoneKey;
}

async function outletDecideRequest(outletPhone, requestId, { accept, note } = {}) {
  const phoneKey = await assertOutletAccess(outletPhone);
  const id = String(requestId || '').trim();
  if (!id) throw new Error('معرّف الطلب مطلوب.');

  const row = await selectSingle('salary_cashout_requests', 'id', id);
  if (!row) throw new Error('الطلب غير موجود.');
  if (String(row.status_key) !== STATUS.PENDING_OUTLET) {
    throw new Error('تمت معالجة هذا الطلب مسبقاً.');
  }

  const patch = {
    id,
    outlet_phone: phoneKey,
    outlet_decided_at: nowIso(),
    updated_at: nowIso(),
    note: note ? String(note).trim() : row.note || null,
    status_key: accept ? STATUS.ACCEPTED_OUTLET : STATUS.REJECTED_OUTLET,
  };
  const saved = await saveRow('salary_cashout_requests', patch, 'id');
  return mapRequestRow(saved);
}

async function listCourierPoolRequests(courierPhone) {
  const phoneKey = await resolvePhoneKey(courierPhone);
  const user = await getAppUser(phoneKey);
  const role = String(user?.role || '').trim();
  if (role !== 'delivery' && role !== 'admin') {
    throw new Error('هذا الحساب ليس مندوباً.');
  }

  const rows = await selectMany(
    'salary_cashout_requests',
    [{ method: 'eq', column: 'status_key', value: STATUS.ACCEPTED_OUTLET }],
    { column: 'created_at', ascending: true },
    200,
  );
  return rows.map(mapRequestRow);
}

async function listCourierAssignedRequests(courierPhone) {
  const phoneKey = await resolvePhoneKey(courierPhone);
  const variants = getPhoneVariants(phoneKey);
  const rows = await selectMany(
    'salary_cashout_requests',
    [{ method: 'in', column: 'courier_phone', value: variants }],
    { column: 'created_at', ascending: false },
    200,
  );
  return rows
    .filter((row) =>
      [STATUS.ASSIGNED_COURIER, STATUS.ON_WAY, STATUS.COMPLETED].includes(
        String(row.status_key),
      ),
    )
    .map(mapRequestRow);
}

async function courierAcceptRequest(courierPhone, requestId) {
  const phoneKey = await resolvePhoneKey(courierPhone);
  const user = await getAppUser(phoneKey);
  if (String(user?.role || '').trim() !== 'delivery' && String(user?.role || '').trim() !== 'admin') {
    throw new Error('هذا الحساب ليس مندوباً.');
  }

  const id = String(requestId || '').trim();
  const row = await selectSingle('salary_cashout_requests', 'id', id);
  if (!row) throw new Error('الطلب غير موجود.');
  if (String(row.status_key) !== STATUS.ACCEPTED_OUTLET) {
    throw new Error('الطلب غير متاح للمندوب حالياً.');
  }

  const saved = await saveRow(
    'salary_cashout_requests',
    {
      id,
      courier_phone: phoneKey,
      courier_accepted_at: nowIso(),
      status_key: STATUS.ASSIGNED_COURIER,
      updated_at: nowIso(),
    },
    'id',
  );
  return mapRequestRow(saved);
}

async function courierUpdateRequestStatus(courierPhone, requestId, statusKey) {
  const phoneKey = await resolvePhoneKey(courierPhone);
  const id = String(requestId || '').trim();
  const next = String(statusKey || '').trim();
  const allowed = new Set([STATUS.ON_WAY, STATUS.COMPLETED]);
  if (!allowed.has(next)) {
    throw new Error('حالة غير صالحة.');
  }

  const row = await selectSingle('salary_cashout_requests', 'id', id);
  if (!row) throw new Error('الطلب غير موجود.');
  const variants = getPhoneVariants(phoneKey);
  if (!variants.includes(String(row.courier_phone || '').trim())) {
    throw new Error('لست المندوب المعيّن لهذا الطلب.');
  }

  const patch = {
    id,
    status_key: next,
    updated_at: nowIso(),
  };
  if (next === STATUS.COMPLETED) {
    patch.completed_at = nowIso();
  }
  const saved = await saveRow('salary_cashout_requests', patch, 'id');
  return mapRequestRow(saved);
}

async function cancelCustomerRequest(customerPhone, requestId) {
  const phoneKey = await resolvePhoneKey(customerPhone);
  const id = String(requestId || '').trim();
  const row = await selectSingle('salary_cashout_requests', 'id', id);
  if (!row) throw new Error('الطلب غير موجود.');
  const variants = getPhoneVariants(phoneKey);
  if (!variants.includes(String(row.customer_phone || '').trim())) {
    throw new Error('لا يمكنك إلغاء هذا الطلب.');
  }
  if (
    ![STATUS.PENDING_OUTLET, STATUS.ACCEPTED_OUTLET].includes(
      String(row.status_key),
    )
  ) {
    throw new Error('لا يمكن إلغاء الطلب في هذه المرحلة.');
  }
  const saved = await saveRow(
    'salary_cashout_requests',
    {
      id,
      status_key: STATUS.CANCELLED,
      cancelled_at: nowIso(),
      updated_at: nowIso(),
    },
    'id',
  );
  return mapRequestRow(saved);
}

module.exports = {
  STATUS,
  createSalaryCashoutRequest,
  listCustomerSalaryCashoutRequests,
  listOutletPendingRequests,
  listOutletActiveRequests,
  outletDecideRequest,
  listCourierPoolRequests,
  listCourierAssignedRequests,
  courierAcceptRequest,
  courierUpdateRequestStatus,
  cancelCustomerRequest,
};
