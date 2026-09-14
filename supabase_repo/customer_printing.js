const { resolvePhoneKey, getPhoneVariants, selectMany } = require('./common');

const {
  EDEN_PRINTING_CATEGORY,
  profileHasEdenPrintingService,
} = require('../lib/eden_printing');

async function hasMyCustomerPrintingStore(phone) {
  const phoneKey = await resolvePhoneKey(phone);
  const { getMerchantProfile } = require('./merchants');
  const profile = await getMerchantProfile(phoneKey);
  if (profileHasEdenPrintingService(profile)) return true;

  const variants = getPhoneVariants(phoneKey);
  const rows = await selectMany(
    'merchant_products',
    [{ method: 'in', column: 'phone', value: variants }],
    { column: 'created_at', ascending: false },
    20,
  );
  return (rows || []).some((row) => {
    const cat = String(row.category || row.service_id || '').trim();
    return cat === EDEN_PRINTING_CATEGORY;
  });
}

module.exports = {
  hasMyCustomerPrintingStore,
};
