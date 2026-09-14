module.exports = {
  id: 'admin',
  mountPath: '/db',
  router: require('../../routes/admin'),
  repository: {
    admin: require('../../supabase_repo/admin'),
    adminRoles: require('../../supabase_repo/admin_roles'),
    adminPermissions: require('../../supabase_repo/admin_permissions'),
    couriersDrivers: require('../../supabase_repo/couriers_drivers'),
    users: require('../../supabase_repo/users'),
    merchants: require('../../supabase_repo/merchants'),
    taxi: require('../../supabase_repo/taxi'),
  },
};
