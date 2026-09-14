require('dotenv').config();
const { getAdminReports } = require('./supabase_repo');

async function test() {
  try {
    console.log("Running getAdminReports for admin phone: +9647744009992");
    const reports = await getAdminReports('+9647744009992');
    console.log("Reports fetched successfully!");
    console.log(JSON.stringify(reports, null, 2));
  } catch (error) {
    console.error("Error fetching reports:", error);
  }
}

test();
