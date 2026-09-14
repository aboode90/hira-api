const { stripBase64Deep } = require('./image_refs');

/** Business blobs — must live in dedicated tables, never app_state. */
const FORBIDDEN_APP_STATE_KEYS = Object.freeze([
  'orders',
  'items',
  'merchantStore',
  'driverProfile',
  'courierProfile',
  'merchantOffers',
  'merchantReviews',
  'merchantProfileComplete',
  'adminAccess',
  'adminRole',
  'admin_role',
  'accountType',
  'userRole',
  'user_role',
  'customerPhone',
  'customerName',
  'customerAddress',
  'customerLatitude',
  'customerLongitude',
  'customerAvatarBase64',
  'customerAvatarUrl',
  'profileComplete',
]);

/** UI / preferences only — mirrors merge_app_state allow-list in SQL. */
const ALLOWED_APP_STATE_KEYS = Object.freeze([
  'darkMode',
  'inAppAlertsEnabled',
  'notificationsEnabled',
  'lastMainTab',
  'homeCategoryFilter',
  'catalogSearchHistory',
  'drafts',
  'syncHints',
  'skippedCustomerSetup',
  'driverType',
  'taxiFavoritePlaces',
  'activeRole',
  'lang',
  'accountSuspended',
  'suspendedAt',
]);

function stripForbiddenAppStateKeys(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {};
  }
  const out = stripBase64Deep({ ...state });
  for (const key of FORBIDDEN_APP_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      delete out[key];
    }
  }
  return out;
}

function sanitizeAppState(state) {
  const stripped = stripForbiddenAppStateKeys(state);
  const out = {};
  for (const key of ALLOWED_APP_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stripped, key)) {
      out[key] = stripped[key];
    }
  }
  return out;
}

module.exports = {
  FORBIDDEN_APP_STATE_KEYS,
  ALLOWED_APP_STATE_KEYS,
  stripForbiddenAppStateKeys,
  sanitizeAppState,
};
