const express = require('express');
const { requireEmergencyApiKey } = require('../lib/emergency_guard');

const router = express.Router();
const guard = requireEmergencyApiKey;

router.get('/__/recover-merchant', guard, async (req, res) => {
  try {
    const phone = String(req.body?.phone || req.query?.phone || '').trim();
    if (!phone) return res.status(400).json({ message: 'phone required' });
    const { getAppUser, getUserState, assertSupabaseAdmin } = require('../supabase_repo');
    const supabase = assertSupabaseAdmin();
    const [appUser, userState] = await Promise.all([
      getAppUser(phone).catch(() => null),
      getUserState(phone).catch(() => null),
    ]);
    if (!appUser) return res.json({ error: 'user not found' });
    const store = userState?.merchantStore || userState?.store || userState?.merchant_profile;
    if (!store) return res.json({ error: 'no merchant store found in app_state' });
    const profileRow = {
      phone: appUser.phone || phone,
      store_name: store.name || store.store_name || '',
      description: store.description || '',
      is_open: store.isOpen ?? store.is_open ?? true,
      is_approved: store.isApproved ?? store.is_approved ?? false,
      approval_status: store.approvalStatus || store.approval_status || 'pending',
      latitude: store.latitude ?? store.lat ?? null,
      longitude: store.longitude ?? store.lng ?? null,
      address: store.address || '',
      delivery_fee: store.deliveryFee ?? store.delivery_fee ?? 0,
      delivery_areas: store.deliveryAreas || store.delivery_areas || '',
      contact_phone: store.phone || appUser.phone || phone,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('merchant_profiles').upsert(profileRow, { onConflict: 'phone' });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, phone, store_name: profileRow.store_name });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/__/recover-products', guard, async (req, res) => {
  try {
    const { assertSupabaseAdmin } = require('../supabase_repo');
    const supabase = assertSupabaseAdmin();

    const { data: states } = await supabase.from('app_state').select('phone, state').limit(500);
    if (!states) return res.json({ recovered: 0, scanned: 0, errors: [] });

    let recovered = 0;
    let scanned = 0;
    const errors = [];

    for (const row of states) {
      const state = row.state || {};
      const items = state.items;
      if (!Array.isArray(items) || items.length === 0) continue;
      scanned++;

      const phone = row.phone;
      for (const item of items) {
        try {
          const product = {
            id: String(item.id || ''),
            phone: phone,
            name_ar: String(item.nameAr || item.name || ''),
            name_en: String(item.nameEn || item.name || ''),
            description_ar: String(item.descriptionAr || item.description || ''),
            description_en: String(item.descriptionEn || item.description || ''),
            price: parseInt(item.price) || 0,
            category: String(item.category || 'general'),
            sub_category: String(item.subCategory || item.sub_category || ''),
            image: String(item.image || ''),
            image_base64: String(item.imageBase64 || item.image_base64 || ''),
            is_available: item.isAvailable ?? true,
          };
          if (!product.id) continue;
          await supabase.from('merchant_products').upsert(product, { onConflict: 'id' });
          recovered++;
        } catch (e) {
          errors.push({ phone, itemId: item.id, error: e.message });
        }
      }
    }
    return res.json({
      scanned: states.length,
      merchantsWithItems: scanned,
      productsRecovered: recovered,
      errors,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/__/check-products', guard, async (req, res) => {
  try {
    const phone = String(req.query?.phone || '').trim();
    const { assertSupabaseAdmin } = require('../supabase_repo');
    const supabase = assertSupabaseAdmin();
    let query = supabase
      .from('merchant_products')
      .select('phone, id, name, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (phone) {
      const digits = phone.replace(/^\+?9640*/, '');
      query = supabase
        .from('merchant_products')
        .select('phone, id, name_ar, price, created_at')
        .or(`phone.eq.${phone},phone.eq.+964${digits},phone.eq.0${digits}`)
        .limit(100);
    }
    const { data } = await query;
    return res.json({ total: data?.length || 0, products: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/__/make-admin', guard, async (req, res) => {
  try {
    const phone = String(req.query?.phone || '').trim();
    if (!phone) return res.status(400).json({ message: 'phone required' });
    const { resolvePhoneKey, assertSupabaseAdmin, getAppUser } = require('../supabase_repo');
    const supabase = assertSupabaseAdmin();
    const pk = await resolvePhoneKey(phone);
    if (!pk) return res.json({ error: 'phone not resolved' });
    const user = await getAppUser(pk);
    const name = user?.full_name || user?.fullName || '';

    await supabase.from('merchant_products').delete().eq('phone', pk);
    await supabase.from('taxi_driver_status').delete().eq('phone', pk);
    await supabase
      .from('merchant_reviews')
      .delete()
      .or(`merchant_phone.eq.${pk},customer_phone.eq.${pk}`);

    await supabase.from('app_state').upsert(
      {
        phone: pk,
        state: {
          customerName: name || 'Admin',
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'phone' }
    );

    await supabase
      .from('app_users')
      .update({
        role: 'admin',
        account_type: 'admin',
        updated_at: new Date().toISOString(),
      })
      .eq('phone', pk);

    await supabase
      .from('admin_roles')
      .upsert(
        { phone: pk, role: 'admin', updated_at: new Date().toISOString() },
        { onConflict: 'phone' }
      );

    const currentEnv = process.env.ADMIN_PHONES || '';
    if (!currentEnv.includes(pk)) {
      process.env.ADMIN_PHONES = currentEnv ? `${currentEnv},${pk}` : pk;
    }

    return res.json({
      success: true,
      phone: pk,
      message: 'تم تحويل الحساب إلى Admin وحذف جميع البيانات الأخرى',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/__/recover-all-merchants', guard, async (req, res) => {
  try {
    const { getUserState, assertSupabaseAdmin } = require('../supabase_repo');
    const { getPhoneVariants } = require('../supabase_repo/common');
    const supabase = assertSupabaseAdmin();
    const { data: states } = await supabase.from('app_state').select('phone, state').limit(500);
    if (!states) return res.json({ recovered: 0, errors: [] });

    const { data: existingProfiles } = await supabase.from('merchant_profiles').select('phone');
    const existingPhones = new Set();
    for (const row of existingProfiles || []) {
      for (const variant of getPhoneVariants(row.phone)) {
        existingPhones.add(variant);
      }
    }

    let recovered = 0;
    const errors = [];

    for (const row of states) {
      const state = row.state || {};
      const store = state.merchantStore || state.store || state.merchant_profile;
      if (!store) continue;
      const phone = row.phone;
      if (getPhoneVariants(phone).some((variant) => existingPhones.has(variant))) continue;

      try {
        const profileRow = {
          phone,
          store_name: String(store.name || store.store_name || '').trim(),
          description: String(store.description || '').trim(),
          is_open: store.isOpen ?? store.is_open ?? true,
          is_approved: store.isApproved ?? store.is_approved ?? false,
          approval_status: String(store.approvalStatus || store.approval_status || 'pending').trim(),
          latitude: store.latitude ?? store.lat ?? null,
          longitude: store.longitude ?? store.lng ?? null,
          address: String(store.address || '').trim(),
          delivery_fee: store.deliveryFee ?? store.delivery_fee ?? 0,
          delivery_areas: String(store.deliveryAreas || store.delivery_areas || '').trim(),
          contact_phone: String(store.phone || phone).trim(),
          updated_at: new Date().toISOString(),
        };
        if (!profileRow.store_name) continue;
        await supabase.from('merchant_profiles').upsert(profileRow, { onConflict: 'phone' });
        for (const variant of getPhoneVariants(phone)) {
          existingPhones.add(variant);
        }
        recovered++;
      } catch (e) {
        errors.push({ phone, error: e.message });
      }
    }
    return res.json({ recovered, totalScanned: states.length, errors });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/db/debug/user-bundle', guard, async (req, res) => {
  try {
    const phone = String(req.query?.phone || '').trim();
    if (!phone) return res.status(400).json({ message: 'phone required' });
    const {
      getAppUser,
      getUserState,
      getMerchantProfile,
      assertSupabaseAdmin,
    } = require('../supabase_repo');
    const { getPhoneVariants } = require('../supabase_repo/common');
    const supabase = assertSupabaseAdmin();
    const phoneVariants = [...new Set([...getPhoneVariants(phone), phone].filter(Boolean))];

    let merchantProfile = null;
    let productCount = 0;
    let matchedMerchantPhone = null;
    try {
      merchantProfile = await getMerchantProfile(phone);
      if (merchantProfile?.phone) {
        matchedMerchantPhone = merchantProfile.phone;
      }
      const countPhone = matchedMerchantPhone || phoneVariants[0] || phone;
      const { count } = await supabase
        .from('merchant_products')
        .select('id', { count: 'exact', head: true })
        .in('phone', phoneVariants.length > 0 ? phoneVariants : [countPhone]);
      productCount = count || 0;
    } catch (_) {}

    const [appUser, userState] = await Promise.all([
      getAppUser(phone).catch((e) => ({ error: e.message })),
      getUserState(phone).catch((e) => ({ error: e.message })),
    ]);

    let similarUsers = [];
    try {
      const suffix = String(phone).replace(/\D/g, '').slice(-8);
      if (suffix.length >= 6) {
        const { data } = await supabase
          .from('app_users')
          .select('phone, role, full_name')
          .ilike('phone', `%${suffix}%`)
          .limit(5);
        similarUsers = (data || []).filter(
          (row) => !phoneVariants.includes(String(row.phone || '').trim())
        );
      }
    } catch (_) {}

    const hasServerData = Boolean(
      appUser?.phone ||
        merchantProfile?.store_name ||
        (userState && typeof userState === 'object' && !userState.error)
    );

    return res.json({
      phone,
      phoneVariantsChecked: phoneVariants,
      appUser: appUser?.phone
        ? {
            phone: appUser.phone,
            full_name: appUser.full_name,
            role: appUser.role,
          }
        : null,
      merchantProfile: merchantProfile?.store_name
        ? {
            phone: merchantProfile.phone,
            store_name: merchantProfile.store_name,
            is_approved: merchantProfile.is_approved,
            approval_status: merchantProfile.approval_status,
          }
        : null,
      merchantProductsCount: productCount,
      userStateKeys:
        userState && typeof userState === 'object' && !userState.error
          ? Object.keys(userState)
          : null,
      similarUsers,
      diagnosis: hasServerData
        ? 'يوجد سجل على السيرفر لهذا الرقم أو أحد صيغه.'
        : 'لا يوجد أي بيانات على السيرفر لهذا الرقم.',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
