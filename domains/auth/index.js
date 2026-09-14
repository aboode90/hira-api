module.exports = {
  id: 'auth',
  mountPath: '/auth',
  router: require('../../routes/auth'),
  repository: {
    users: require('../../supabase_repo/users'),
  },
};
