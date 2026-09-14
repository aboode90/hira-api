const { randomUUID } = require('crypto');
const {
  assertSupabaseAdmin,
  nowIso,
  resolvePhoneKey,
  saveRow,
} = require('./common');
const { getServiceFees } = require('../services/app_config_service');

const PROVIDER_TYPES = new Set(['merchant', 'driver', 'courier']);

function normalizeProviderType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!PROVIDER_TYPES.has(type)) {
    throw new Error('نوع الحساب غير صالح.');
  }
  return type;
}

async function findServiceDebit(providerType, referenceType, referenceId) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('id, balance_after_iqd')
    .eq('provider_type', providerType)
    .eq('reference_type', referenceType)
    .eq('reference_id', referenceId)
    .eq('direction', 'debit')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function loadWalletRow(phone, providerType) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('provider_wallets')
    .select()
    .eq('phone', normalizedPhone)
    .eq('provider_type', type)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function ensureWallet(phone, providerType) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const existing = await loadWalletRow(normalizedPhone, type);
  if (existing) return existing;

  const supabase = assertSupabaseAdmin();
  const row = {
    phone: normalizedPhone,
    provider_type: type,
    balance_iqd: 0,
    updated_at: nowIso(),
  };
  const { data: inserted, error: insertError } = await supabase
    .from('provider_wallets')
    .insert(row)
    .select()
    .maybeSingle();
  if (!insertError) return inserted;

  if (/duplicate/i.test(String(insertError.message || ''))) {
    const retry = await loadWalletRow(normalizedPhone, type);
    if (retry) return retry;
  }
  throw new Error(insertError.message);
}

async function getProviderWallet(phone, providerType) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const wallet = await ensureWallet(normalizedPhone, type);
  const fees = await getServiceFees();
  const feeKey =
    type === 'merchant'
      ? 'merchantOrderIqd'
      : type === 'driver'
        ? 'taxiOrderIqd'
        : 'courierOrderIqd';
  const serviceFeeIqd = Number(fees[feeKey] ?? 250) || 250;

  const supabase = assertSupabaseAdmin();
  const { data: transactions, error } = await supabase
    .from('wallet_transactions')
    .select(
      'id, direction, amount_iqd, balance_after_iqd, reference_type, reference_id, note_ar, created_at'
    )
    .eq('phone', normalizedPhone)
    .eq('provider_type', type)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  const { data: topups, error: topupError } = await supabase
    .from('wallet_topup_requests')
    .select('id, amount_iqd, status_key, note_text, created_at, updated_at')
    .eq('phone', normalizedPhone)
    .eq('provider_type', type)
    .order('created_at', { ascending: false })
    .limit(10);
  if (topupError) throw new Error(topupError.message);

  return {
    phone: normalizedPhone,
    providerType: type,
    balanceIqd: Number(wallet.balance_iqd ?? 0) || 0,
    serviceFeeIqd,
    transactions: (transactions || []).map((row) => ({
      id: row.id,
      direction: row.direction,
      amountIqd: Number(row.amount_iqd ?? 0) || 0,
      balanceAfterIqd: Number(row.balance_after_iqd ?? 0) || 0,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      noteAr: row.note_ar || '',
      createdAt: row.created_at,
    })),
    topupRequests: (topups || []).map((row) => ({
      id: row.id,
      amountIqd: Number(row.amount_iqd ?? 0) || 0,
      statusKey: row.status_key,
      noteText: row.note_text || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

async function assertSufficientBalance(phone, providerType, amountIqd) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const wallet = await ensureWallet(normalizedPhone, type);
  const balance = Number(wallet.balance_iqd ?? 0) || 0;
  const amount = Math.max(0, Number(amountIqd) || 0);
  if (amount <= 0) return { ok: true, balance };
  if (balance < amount) {
    const err = new Error(
      'رصيد الحساب غير كافٍ. يرجى شحن المحفظة أولاً لاستقبال الطلبات.',
    );
    err.code = 'INSUFFICIENT_WALLET_BALANCE';
    throw err;
  }
  return { ok: true, balance };
}

async function findServiceCredit(providerType, referenceType, referenceId) {
  const supabase = assertSupabaseAdmin();
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('id, balance_after_iqd')
    .eq('provider_type', providerType)
    .eq('reference_type', referenceType)
    .eq('reference_id', referenceId)
    .eq('direction', 'credit')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function refundServiceFee({
  phone,
  providerType,
  amountIqd,
  referenceType,
  referenceId,
  noteAr,
  originalReferenceType = 'taxi_request',
}) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const amount = Math.max(0, Number(amountIqd) || 0);
  const refType = String(referenceType || '').trim();
  const refId = String(referenceId || '').trim();
  const debitRefType = String(originalReferenceType || 'taxi_request').trim();
  if (!refType || !refId || amount <= 0) {
    return { refunded: false, balanceIqd: 0 };
  }

  const existingCredit = await findServiceCredit(type, refType, refId);
  if (existingCredit) {
    return {
      refunded: false,
      alreadyRefunded: true,
      balanceIqd: Number(existingCredit.balance_after_iqd ?? 0) || 0,
    };
  }

  const debit = await findServiceDebit(type, debitRefType, refId);
  if (!debit) {
    return { refunded: false, balanceIqd: 0, reason: 'no_debit' };
  }

  await ensureWallet(normalizedPhone, type);
  const wallet = await loadWalletRow(normalizedPhone, type);
  const currentBalance = Number(wallet.balance_iqd ?? 0) || 0;
  const newBalance = currentBalance + amount;

  const supabase = assertSupabaseAdmin();
  const { data: updatedWallet, error: updateError } = await supabase
    .from('provider_wallets')
    .update({
      balance_iqd: newBalance,
      updated_at: nowIso(),
    })
    .eq('phone', normalizedPhone)
    .eq('provider_type', type)
    .select()
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updatedWallet) throw new Error('تعذر إرجاع رصيد المحفظة.');

  await saveRow('wallet_transactions', {
    id: randomUUID(),
    phone: normalizedPhone,
    provider_type: type,
    direction: 'credit',
    amount_iqd: amount,
    balance_after_iqd: newBalance,
    reference_type: refType,
    reference_id: refId,
    note_ar: String(noteAr || '').trim() || null,
    created_at: nowIso(),
  });

  return { refunded: true, balanceIqd: newBalance };
}

async function chargeServiceFee({
  phone,
  providerType,
  amountIqd,
  referenceType,
  referenceId,
  noteAr,
}) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const amount = Math.max(0, Number(amountIqd) || 0);
  const refType = String(referenceType || '').trim();
  const refId = String(referenceId || '').trim();
  if (!refType || !refId) {
    throw new Error('Wallet reference is required.');
  }
  if (amount <= 0) {
    const wallet = await ensureWallet(normalizedPhone, type);
    return {
      charged: false,
      balanceIqd: Number(wallet.balance_iqd ?? 0) || 0,
    };
  }

  const existing = await findServiceDebit(type, refType, refId);
  if (existing) {
    return {
      charged: false,
      alreadyCharged: true,
      balanceIqd: Number(existing.balance_after_iqd ?? 0) || 0,
    };
  }

  await assertSufficientBalance(normalizedPhone, type, amount);

  const supabase = assertSupabaseAdmin();
  const wallet = await ensureWallet(normalizedPhone, type);
  const currentBalance = Number(wallet.balance_iqd ?? 0) || 0;
  const newBalance = currentBalance - amount;

  const { data: updatedWallet, error: updateError } = await supabase
    .from('provider_wallets')
    .update({
      balance_iqd: newBalance,
      updated_at: nowIso(),
    })
    .eq('phone', normalizedPhone)
    .eq('provider_type', type)
    .gte('balance_iqd', amount)
    .select()
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updatedWallet) {
    const err = new Error(
      'رصيد الحساب غير كافٍ. يرجى شحن المحفظة أولاً لاستقبال الطلبات.',
    );
    err.code = 'INSUFFICIENT_WALLET_BALANCE';
    throw err;
  }

  try {
    await saveRow('wallet_transactions', {
      id: randomUUID(),
      phone: normalizedPhone,
      provider_type: type,
      direction: 'debit',
      amount_iqd: amount,
      balance_after_iqd: newBalance,
      reference_type: refType,
      reference_id: refId,
      note_ar: String(noteAr || '').trim() || null,
      created_at: nowIso(),
    });
  } catch (insertError) {
    const duplicate =
      String(insertError?.message || '').includes('wallet_transactions_service_debit_unique') ||
      String(insertError?.message || '').includes('duplicate key');
    if (duplicate) {
      const row = await findServiceDebit(type, refType, refId);
      return {
        charged: false,
        alreadyCharged: true,
        balanceIqd: Number(row?.balance_after_iqd ?? newBalance) || newBalance,
      };
    }
    throw insertError;
  }

  return { charged: true, balanceIqd: newBalance };
}

async function createWalletTopupRequest(phone, providerType, data = {}) {
  const normalizedPhone = await resolvePhoneKey(phone);
  const type = normalizeProviderType(providerType);
  const amount = Math.round(Number(data.amountIqd ?? data.amount_iqd ?? 0));
  if (!Number.isFinite(amount) || amount < 1000) {
    throw new Error('أدخل مبلغ شحن صالح (1000 د.ع على الأقل).');
  }

  await ensureWallet(normalizedPhone, type);
  const row = {
    id: randomUUID(),
    phone: normalizedPhone,
    provider_type: type,
    amount_iqd: amount,
    status_key: 'pending',
    note_text: String(data.noteText ?? data.note_text ?? '').trim() || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const saved = await saveRow('wallet_topup_requests', row);
  return {
    id: saved.id,
    amountIqd: Number(saved.amount_iqd ?? amount) || amount,
    statusKey: saved.status_key,
    noteText: saved.note_text || '',
    createdAt: saved.created_at,
    updatedAt: saved.updated_at,
  };
}

async function chargeMerchantOrderFee(merchantPhone, orderId) {
  const fees = await getServiceFees();
  const amount = Number(fees.merchantOrderIqd ?? 250) || 250;
  return chargeServiceFee({
    phone: merchantPhone,
    providerType: 'merchant',
    amountIqd: amount,
    referenceType: 'merchant_order',
    referenceId: String(orderId),
    noteAr: `رسوم خدمة طلب متجر (${amount} د.ع)`,
  });
}

async function chargeTaxiOrderFee(driverPhone, requestId) {
  const fees = await getServiceFees();
  const amount = Number(fees.taxiOrderIqd ?? 250) || 250;
  return chargeServiceFee({
    phone: driverPhone,
    providerType: 'driver',
    amountIqd: amount,
    referenceType: 'taxi_request',
    referenceId: String(requestId),
    noteAr: `رسوم خدمة رحلة تكسي (${amount} د.ع)`,
  });
}

async function chargeCourierOrderFee(courierPhone, orderId) {
  const fees = await getServiceFees();
  const amount = Number(fees.courierOrderIqd ?? 250) || 250;
  return chargeServiceFee({
    phone: courierPhone,
    providerType: 'courier',
    amountIqd: amount,
    referenceType: 'delivery_order',
    referenceId: String(orderId),
    noteAr: `رسوم خدمة توصيل (${amount} د.ع)`,
  });
}

module.exports = {
  ensureWallet,
  getProviderWallet,
  assertSufficientBalance,
  findServiceDebit,
  refundServiceFee,
  chargeServiceFee,
  createWalletTopupRequest,
  chargeMerchantOrderFee,
  chargeTaxiOrderFee,
  chargeCourierOrderFee,
};
