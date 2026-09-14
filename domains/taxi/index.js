const { startTaxiScheduler } = require('../../services/taxi_scheduler');

module.exports = {
  id: 'taxi',
  mountPath: '/db/taxi',
  router: require('./routes'),
  repository: {
    taxi: require('./repository/taxi'),
    favorites: require('../../supabase_repo/taxi_favorites'),
    users: require('../../supabase_repo/users'),
  },
  services: {
    pricing: require('../../services/taxi_pricing_service'),
    trip: require('../../services/taxi_trip_service'),
    matching: require('../../services/taxi_matching_service'),
    scheduler: require('../../services/taxi_scheduler'),
  },
  startWorkers() {
    startTaxiScheduler();
  },
};
