module.exports = {
  id: 'marketplace',
  mountPath: '/db',
  router: require('../../routes/marketplace'),
  repository: {
    merchants: require('../../supabase_repo/merchants'),
  },
};
