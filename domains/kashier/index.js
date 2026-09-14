module.exports = {
  id: 'kashier',
  mountPath: '/db/kashier',
  router: require('../../routes/kashier'),
  repository: {
    orders: require('../../supabase_repo/orders'),
    merchants: require('../../supabase_repo/merchants'),
    chat: require('../../supabase_repo/chat'),
  },
};
