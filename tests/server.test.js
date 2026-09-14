const { validatePromoCode } = require('../promo_codes');

describe('Server Health', () => {
  it('exports the required modules', () => {
    expect(validatePromoCode).toBeDefined();
    expect(typeof validatePromoCode).toBe('function');
  });
});

describe('Environment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('detects missing SESSION_SECRET', () => {
    delete process.env.SESSION_SECRET;
    const { verifySessionToken } = require('../routes/_middleware');
    expect(() => verifySessionToken('test')).toThrow();
  });
});
