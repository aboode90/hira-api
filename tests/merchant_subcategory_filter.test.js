const test = require('node:test');
const assert = require('node:assert/strict');
const {
  merchantMatchesSubCategoryFilter,
} = require('../supabase_repo/merchants');

test('merchantMatchesSubCategoryFilter requires exact subcategory match', () => {
  const cosmeticsStore = {
    primary_service_id: 'beauty',
    service_sub_category: null,
    store_name: 'كاظم',
  };
  const pharmacyStore = {
    primary_service_id: 'pharmacy',
    service_sub_category: null,
    store_name: 'صيدلية النور',
  };
  const labeledPharmacy = {
    primary_service_id: 'beauty',
    service_sub_category: 'صيدلية',
    store_name: 'صيدلية الحياة',
  };

  assert.equal(
    merchantMatchesSubCategoryFilter(cosmeticsStore, 'صيدلية'),
    false,
    'cosmetics without subcategory must not appear in pharmacy',
  );
  assert.equal(
    merchantMatchesSubCategoryFilter(pharmacyStore, 'صيدلية'),
    true,
    'legacy pharmacy primary service should appear in pharmacy',
  );
  assert.equal(
    merchantMatchesSubCategoryFilter(labeledPharmacy, 'صيدلية'),
    true,
    'beauty merchant labeled as pharmacy should appear',
  );
  assert.equal(
    merchantMatchesSubCategoryFilter(cosmeticsStore, 'صالون نسائي'),
    false,
    'empty subcategory must not leak into salon views',
  );
  assert.equal(
    merchantMatchesSubCategoryFilter(
      { service_sub_category: 'صالون نسائي' },
      'صالون نسائي',
    ),
    true,
  );
  assert.equal(
    merchantMatchesSubCategoryFilter(
      { service_sub_category: 'صالون نسائي' },
      '',
    ),
    true,
    'empty filter shows all',
  );
});
