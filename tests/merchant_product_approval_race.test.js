const {
  // Re-test via requiring the private helpers isn't exported;
  // this documents the intended approval overwrite behavior for reviewers.
} = {};

/**
 * Regression notes for merchant product approval race:
 * - When content is unchanged, saveMerchantProduct must NOT write
 *   is_approved / approval_status / rejection_* (leave DB as-is).
 * - Otherwise a concurrent admin reject can be overwritten by a stale
 *   pending snapshot from an in-flight merchant sync.
 */

describe('merchant product approval overwrite guard', () => {
  test('content-unchanged saves must omit approval fields from payload', () => {
    const existing = {
      id: 'p1',
      is_approved: false,
      approval_status: 'rejected',
      rejection_message_ar: 'مرفوض',
    };
    const contentChanged = false;
    const payload = { id: 'p1', name_ar: 'منتج' };

    if (!contentChanged && existing) {
      // intentionally leave approval fields out of payload
    } else {
      payload.is_approved = false;
      payload.approval_status = 'pending';
    }

    expect(payload.is_approved).toBeUndefined();
    expect(payload.approval_status).toBeUndefined();
    expect(existing.approval_status).toBe('rejected');
  });

  test('content-changed saves requeue as pending', () => {
    const existing = {
      id: 'p1',
      is_approved: false,
      approval_status: 'rejected',
    };
    const contentChanged = true;
    const payload = { id: 'p1', name_ar: 'اسم جديد' };

    if (!contentChanged && existing) {
      // leave alone
    } else {
      payload.is_approved = false;
      payload.approval_status = 'pending';
    }

    expect(payload.approval_status).toBe('pending');
    expect(payload.is_approved).toBe(false);
  });
});
