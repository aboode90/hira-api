const {
  chunkValues,
  indexProductsByPhoneVariants,
  collectProductsForPhone,
} = require('../supabase_repo/merchants');

describe('merchant store listing product batching', () => {
  test('chunkValues splits phones into safe .in batches', () => {
    const phones = Array.from({ length: 200 }, (_, i) => `+9647${String(i).padStart(8, '0')}`);
    const chunks = chunkValues(phones, 90);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(90);
    expect(chunks[1]).toHaveLength(90);
    expect(chunks[2]).toHaveLength(20);
  });

  test('collectProductsForPhone groups batched rows without N+1 and dedupes variants', () => {
    const products = [
      {
        id: 'p1',
        phone: '07800000001',
        name_ar: 'منتج أ',
        created_at: '2026-01-02T00:00:00Z',
      },
      {
        id: 'p2',
        phone: '+9647800000002',
        name_ar: 'منتج ب',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'p1',
        phone: '+9647800000001',
        name_ar: 'منتج أ',
        created_at: '2026-01-02T00:00:00Z',
      },
    ];
    const byVariant = indexProductsByPhoneVariants(products);
    const forMerchantA = collectProductsForPhone(byVariant, '07800000001');
    const forMerchantB = collectProductsForPhone(byVariant, '07800000002');

    expect(forMerchantA.map((row) => row.id)).toEqual(['p1']);
    expect(forMerchantB.map((row) => row.id)).toEqual(['p2']);
  });
});
