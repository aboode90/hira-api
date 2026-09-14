const crypto = require('crypto');
const { verifySessionToken, base64UrlEncode } = require('../lib/session');

const TEST_SECRET = 'test-secret-for-unit-tests-only';

function createTestToken(phone, secret, expOffset = 3600) {
  const payload = {
    phone,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expOffset,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest();
  const encodedSignature = base64UrlEncode(signature);
  return `${encodedPayload}.${encodedSignature}`;
}

describe('Session Token Verification', () => {
  it('verifies a valid token', () => {
    const token = createTestToken('+9647744009992', TEST_SECRET);
    const result = verifySessionToken(token, TEST_SECRET);
    expect(result.phone).toBe('9647744009992');
    expect(result.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects token with wrong secret', () => {
    const token = createTestToken('+9647744009992', 'wrong-secret');
    expect(() => verifySessionToken(token, TEST_SECRET)).toThrow('Invalid token signature');
  });

  it('rejects expired token', () => {
    const token = createTestToken('+9647744009992', TEST_SECRET, -3600);
    expect(() => verifySessionToken(token, TEST_SECRET)).toThrow('Token expired');
  });

  it('rejects malformed token', () => {
    expect(() => verifySessionToken('not-a-valid-token', TEST_SECRET)).toThrow('Missing token');
  });

  it('rejects empty token', () => {
    expect(() => verifySessionToken('', TEST_SECRET)).toThrow('Missing token');
  });

  it('throws when no secret configured', () => {
    expect(() => verifySessionToken('abc.def', '')).toThrow('SESSION_SECRET');
  });

  it('accepts tokens with 077... phone format', () => {
    const token = createTestToken('07744009992', TEST_SECRET);
    const result = verifySessionToken(token, TEST_SECRET);
    expect(result.phone).toBe('9647744009992');
  });

  it('marks Worker-style tokens as missing se', () => {
    const token = createTestToken('07744009992', TEST_SECRET);
    const result = verifySessionToken(token, TEST_SECRET);
    expect(result.hasSe).toBe(false);
    expect(result.se).toBeNull();
  });

  it('reads explicit se from payload', () => {
    const payload = {
      phone: '9647744009992',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      se: 3,
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', TEST_SECRET).update(encodedPayload).digest();
    const token = `${encodedPayload}.${base64UrlEncode(signature)}`;
    const result = verifySessionToken(token, TEST_SECRET);
    expect(result.hasSe).toBe(true);
    expect(result.se).toBe(3);
  });
});
