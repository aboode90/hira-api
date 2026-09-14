module.exports = {
  id: 'salary_cashout',
  mountPath: '/db/salary-cashout',
  router: require('../../routes/salary_cashout'),
  repository: {
    salaryCashout: require('../../supabase_repo/salary_cashout'),
  },
};
