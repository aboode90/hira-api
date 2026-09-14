require('dotenv').config();
const { getAllDrivers, getAllCouriers, getAllAdminAccounts } = require('./supabase_repo');

async function check() {
  try {
    const drivers = await getAllDrivers('+9647744009992');
    console.log("Drivers:", JSON.stringify(drivers, null, 2));
    
    const accounts = await getAllAdminAccounts('+9647744009992');
    console.log("All accounts length:", accounts.length);
  } catch (err) {
    console.error(err);
  }
}

check();
