require('dotenv').config();
const { getAllDrivers } = require('./supabase_repo/admin');

(async () => {
  const drivers = await getAllDrivers('+9647744009992');
  console.log('TOTAL DRIVERS:', drivers.length);
  const target = drivers.filter((d) => String(d.phone || '').includes('7726511479'));
  console.log('TARGET:', JSON.stringify(target, null, 1));
  console.log('--- pending count ---');
  console.log('pending drivers:', drivers.filter((d) => d.approvalStatus === 'pending').length);
})();
