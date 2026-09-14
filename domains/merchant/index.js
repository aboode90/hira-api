module.exports = {
  id: 'merchant',
  mountPath: '/db',
  router: require('../../routes/merchants'),
  repository: {
    merchants: require('../../supabase_repo/merchants'),
    orders: require('../../supabase_repo/orders'),
  },
  services: {
    imageRefs: require('../../services/image_refs'),
    workingHours: require('../../services/merchant_working_hours'),
  },
};
