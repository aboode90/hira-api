module.exports = {
  id: 'delivery',
  mountPath: '/db',
  router: require('../../routes/delivery'),
  repository: {
    orders: require('../../supabase_repo/orders'),
  },
};
