require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const { data, error } = await supabase
    .from('merchant_profiles')
    .select('phone, store_name, service_sub_category, primary_service_id, professional_info')
    .eq('service_sub_category', 'أطباء وعيادات');
  if (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }
  console.log('DOCTORS_COUNT:', (data || []).length);
  for (const p of data || []) {
    const info = p.professional_info || {};
    console.log(
      JSON.stringify({
        phone: p.phone,
        store_name: p.store_name,
        specialty: info.specialty || null,
        specialties: info.specialties || null,
        infoKeys: Object.keys(info),
      })
    );
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
