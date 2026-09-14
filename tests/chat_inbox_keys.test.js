const assert = require('assert');

// Mirror the identity key used by backend/supabase_repo/chat.js
function phoneIdentityKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return String(phone || '').trim();
}

function phonesOverlap(left, right) {
  const leftDigits = String(left || '').replace(/\D/g, '');
  const rightDigits = String(right || '').replace(/\D/g, '');
  if (!leftDigits || !rightDigits) return false;
  const leftCore = leftDigits.slice(-10);
  const rightCore = rightDigits.slice(-10);
  return leftCore === rightCore || leftDigits.endsWith(rightCore) || rightDigits.endsWith(leftCore);
}

function inboxThreadKey(row, myPhone) {
  const type = String(row.thread_type || '').trim();
  const id = String(row.thread_id || '').trim();
  if (type === 'store' && phonesOverlap(id, myPhone)) {
    const other = phonesOverlap(row.sender_phone, myPhone)
      ? String(row.receiver_phone || '').trim()
      : String(row.sender_phone || '').trim();
    const otherKey = phoneIdentityKey(other);
    if (otherKey) return `${type}:${phoneIdentityKey(id)}:${otherKey}`;
  }
  return `${type}:${id}`;
}

describe('store inbox thread keys', () => {
  const merchant = '+9647900123456';

  test('keeps separate customer threads despite phone format differences', () => {
    const fromA = {
      thread_type: 'store',
      thread_id: merchant,
      sender_phone: '07900111111',
      receiver_phone: merchant,
    };
    const fromACanonical = {
      thread_type: 'store',
      thread_id: '9647900123456',
      sender_phone: '+9647900111111',
      receiver_phone: merchant,
    };
    const fromB = {
      thread_type: 'store',
      thread_id: merchant,
      sender_phone: '+9647900222222',
      receiver_phone: merchant,
    };

    const keyA1 = inboxThreadKey(fromA, merchant);
    const keyA2 = inboxThreadKey(fromACanonical, merchant);
    const keyB = inboxThreadKey(fromB, merchant);

    assert.strictEqual(keyA1, keyA2);
    assert.notStrictEqual(keyA1, keyB);
  });

  test('customer-side store threads stay keyed by store only', () => {
    const customer = '+9647900111111';
    const row = {
      thread_type: 'store',
      thread_id: merchant,
      sender_phone: merchant,
      receiver_phone: customer,
    };
    assert.strictEqual(inboxThreadKey(row, customer), `store:${merchant}`);
  });
});
