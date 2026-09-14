module.exports = {
  id: 'platform',
  mountPath: '/app',
  router: require('../../routes/app'),
  extraMounts: [
    { mountPath: '/maps', router: require('../../routes/maps') },
  ],
  repository: {
    admin: require('../../supabase_repo/admin'),
  },
};
