require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

async function checkAdmins() {
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log("Fetching users with role = admin...");
  const { data: users, error: err1 } = await supabase
    .from('app_users')
    .select('phone, role, full_name');
  if (err1) {
    console.error("Error reading users:", err1);
  } else {
    const dbAdmins = users.filter(u => u.role === 'admin');
    console.log(`Found ${dbAdmins.length} users with role = 'admin' in app_users:`);
    console.log(dbAdmins);
  }

  console.log("Fetching app states to check for adminAccess = true or userRole = admin...");
  const { data: states, error: err2 } = await supabase
    .from('app_state')
    .select('phone, state');
  if (err2) {
    console.error("Error reading states:", err2);
  } else {
    const stateAdmins = [];
    states.forEach(row => {
      const state = row.state || {};
      if (state.adminAccess === true || state.userRole === 'admin' || state.user_role === 'admin') {
        stateAdmins.push({
          phone: row.phone,
          adminAccess: state.adminAccess,
          userRole: state.userRole,
          user_role: state.user_role
        });
      }
    });
    console.log(`Found ${stateAdmins.length} users with admin flags in app_state:`);
    console.log(stateAdmins);
  }
}

checkAdmins();
