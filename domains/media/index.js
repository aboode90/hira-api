module.exports = {
  id: 'media',
  mountPath: '/db',
  router: require('../../routes/media'),
  repository: {
    media: require('../../supabase_repo/media_assets'),
  },
};
