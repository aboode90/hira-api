module.exports = {
  id: 'chat',
  mountPath: '/db/chat',
  router: require('../../routes/chat'),
  repository: {
    chat: require('../../supabase_repo/chat'),
  },
  startWorkers() {
    require('../../services/chat_scheduler').startChatScheduler();
  },
};
