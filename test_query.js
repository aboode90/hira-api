require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function injectDriver() {
  const phone = '+9647855505865';
  
  console.log("Fetching current state for:", phone);
  
  const { data, error } = await supabase
    .from('app_state')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();
    
  if (error || !data) {
    console.error("User state not found or error:", error);
    return;
  }
  
  const currentState = data.state || {};
  
  // Inject mock driver profile fields so the backend recognizes this account as a driver request
  const updatedState = {
    ...currentState,
    userRole: 'driver',
    driverProfile: {
      name: "عبدالله",
      phone: "+9647855505865",
      vehicle: "تاكسي بغداد (سنترا صفراء)",
      plate: "أ / 10293 بغداد",
      area: "الكرادة / الجادرية",
      isApproved: false,
      approvalStatus: "pending",
      // Include document placeholders for testing the document viewer modal
      profileImage: "https://placehold.co/400x400/png?text=Profile+Image",
      vehicleImage: "https://placehold.co/600x400/png?text=Vehicle+Image",
      idFrontImage: "https://placehold.co/600x400/png?text=ID+Front",
      idBackImage: "https://placehold.co/600x400/png?text=ID+Back",
      residenceCardImage: "https://placehold.co/600x400/png?text=Residence+Card",
      vehicleRegFrontImage: "https://placehold.co/600x400/png?text=Vehicle+Reg+Front",
      vehicleRegBackImage: "https://placehold.co/600x400/png?text=Vehicle+Reg+Back"
    }
  };
  
  console.log("Updating database state...");
  
  const { data: updatedRow, error: updateError } = await supabase
    .from('app_state')
    .update({ state: updatedState, updated_at: new Date().toISOString() })
    .eq('phone', phone)
    .select();
    
  if (updateError) {
    console.error("Failed to update state:", updateError);
  } else {
    console.log("Successfully injected driver profile! Database updated successfully.");
  }
}

injectDriver();
