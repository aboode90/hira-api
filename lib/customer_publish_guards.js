/**
 * منع حذف صفوف مجالات نشر الزبون من merchant_* أثناء الترحيل.
 * يُستدعى من مسارات الحذف الحساسة — الحذف الصلب قرار لاحق صريح فقط.
 */
function isProtectedCustomerPublishCategory(category, listingMode = '') {
  const cat = String(category || '').trim();
  const mode = String(listingMode || '').trim();
  if (cat === 'real_estate') return true;
  if (cat === 'restaurant') return true;
  if (cat === 'used' && mode === 'customer_used') return true;
  if (cat === 'offers' && mode === 'customer_offer') return true;
  if (cat === 'cars' && mode === 'customer_car') return true;
  if (cat === 'cars' && mode === 'customer_car_request') return true;
  if (cat === 'professionals') return true;
  return false;
}

module.exports = {
  isProtectedCustomerPublishCategory,
};
