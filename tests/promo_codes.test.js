const { validatePromoCode, calculatePromoDiscount } = require('../promo_codes');

describe('Promo Codes', () => {
  describe('validatePromoCode', () => {
    it('rejects empty code', () => {
      const result = validatePromoCode('', 10000);
      expect(result.valid).toBe(false);
      expect(result.messageAr).toBeTruthy();
    });

    it('rejects unknown code', () => {
      const result = validatePromoCode('INVALID', 10000);
      expect(result.valid).toBe(false);
    });

    it('rejects code below minimum subtotal', () => {
      const result = validatePromoCode('GHAITH20', 1000);
      expect(result.valid).toBe(false);
      expect(result.messageAr).toContain('الحد الأدنى');
    });

    it('accepts valid GHAITH20 code with sufficient subtotal', () => {
      const result = validatePromoCode('GHAITH20', 10000);
      expect(result.valid).toBe(true);
      expect(result.code).toBe('GHAITH20');
      expect(result.discountType).toBe('percent');
      expect(result.discountValue).toBe(20);
    });

    it('is case-insensitive', () => {
      const result = validatePromoCode('ghaith20', 10000);
      expect(result.valid).toBe(true);
    });

    it('calculates discount correctly: 20% of 10000 = 2000', () => {
      const result = validatePromoCode('GHAITH20', 10000);
      expect(result.discountAmountIqd).toBe(2000);
    });

    it('caps discount at 50000', () => {
      const result = validatePromoCode('GHAITH20', 500000);
      expect(result.discountAmountIqd).toBe(50000);
    });
  });

  describe('calculatePromoDiscount', () => {
    it('returns 0 for empty subtotal', () => {
      expect(calculatePromoDiscount({ discountType: 'percent', discountValue: 20 }, 0)).toBe(0);
    });

    it('returns 0 for negative subtotal', () => {
      expect(calculatePromoDiscount({ discountType: 'percent', discountValue: 20 }, -100)).toBe(0);
    });

    it('calculates percentage discount', () => {
      const promo = { discountType: 'percent', discountValue: 20 };
      expect(calculatePromoDiscount(promo, 10000)).toBe(2000);
    });
  });
});
