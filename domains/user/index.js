module.exports = {
  id: 'user',
  mountPath: '/db',
  router: require('../../routes/users'),
  repository: {
    users: require('../../supabase_repo/users'),
    customerData: require('../../supabase_repo/customer_data'),
    orders: require('../../supabase_repo/orders'),
    push: require('../../supabase_repo/push_notifications'),
  },
};
