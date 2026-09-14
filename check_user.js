require('dotenv').config();
const {
  getAppUser,
  getUserState,
  getMerchantProfile,
  getCustomerProfile
} = require('./supabase_repo');

async function main() {
  const basePhone = process.argv[2] || '07744009992';
  const variants = [
    basePhone,
    '964' + basePhone.replace(/^0/, ''),
    '+964' + basePhone.replace(/^0/, '')
  ];

  console.log(`Checking data for phone variants: ${variants.join(', ')}`);
  
  for (const phoneKey of variants) {
    try {
      console.log(`\n============================`);
      console.log(`Testing variant: ${phoneKey}`);
      console.log(`============================`);

      const user = await getAppUser(phoneKey);
      console.log('\n--- 1. App User ---');
      console.log(user ? '✅ Found' : '❌ Not Found');
      if (user) console.log(JSON.stringify(user, null, 2));

      const state = await getUserState(phoneKey);
      console.log('\n--- 2. App State (Role, Driver/Courier Profile) ---');
      console.log(state ? '✅ Found' : '❌ Not Found');
      if (state) console.log(JSON.stringify(state, null, 2));

      const merchant = await getMerchantProfile(phoneKey);
      console.log('\n--- 3. Merchant Profile ---');
      console.log(merchant ? '✅ Found' : '❌ Not Found');
      if (merchant) console.log(JSON.stringify(merchant, null, 2));

      const customer = await getCustomerProfile(phoneKey);
      console.log('\n--- 4. Customer Profile ---');
      console.log(customer ? '✅ Found' : '❌ Not Found');
      if (customer) console.log(JSON.stringify(customer, null, 2));

    } catch (error) {
      console.error(`Error for ${phoneKey}:`, error.message);
    }
  }
}

main();
