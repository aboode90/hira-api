/**
 * Supabase Repository — Module Index
 *
 * يجمع ويُعيد تصدير جميع الوظائف من الوحدات الفرعية
 * ليحافظ على التوافق مع require('./supabase_repo') الموجود في server.js والملفات الأخرى.
 */

const common = require('./common');
const users = require('./users');
const customer_data = require('./customer_data');
const merchants = require('./merchants');
const orders = require('./orders');
const couriers_drivers = require('./couriers_drivers');
const admin = require('./admin');
const push_notifications = require('./push_notifications');
const user_notifications = require('./user_notifications');
const taxi = require('./taxi');
const admin_roles = require('./admin_roles');
const admin_permissions = require('./admin_permissions');
const chat = require('./chat');
const call_logs = require('./call_logs');
const operator_profiles = require('./operator_profiles');
const merchant_offers = require('./merchant_offers');
const media_assets = require('./media_assets');
const customer_offers = require('./customer_offers');
const customer_used = require('./customer_used');
const customer_cars = require('./customer_cars');
const customer_real_estate = require('./customer_real_estate');
const customer_professionals = require('./customer_professionals');

module.exports = {
  // Common / Config
  ...common,

  // Users & State
  ...users,

  // Customer Data (profiles, addresses, favorites)
  ...customer_data,

  // Merchants, Products, Reviews, Marketplace
  ...merchants,

  // Merchant private courier fleet
  ...require('./merchant_couriers'),

  // Orders & Delivery
  ...orders,

  // Couriers & Drivers helpers
  ...couriers_drivers,

  // Admin
  ...admin,

  // Push notifications
  ...push_notifications,

  // User in-app notifications
  ...user_notifications,

  // Taxi
  ...taxi,

  // Admin Roles
  ...admin_roles,

  // Admin Permissions
  ...admin_permissions,

  // Chat
  ...chat,

  // Voice call logs
  ...call_logs,

  // Driver / courier profiles
  ...operator_profiles,

  // Merchant offers / reviews API
  ...merchant_offers,

  // Media assets
  ...media_assets,

  // Customer offers (public offers section)
  ...customer_offers,

  // Customer used listings
  ...customer_used,

  // Customer car sell listings
  ...customer_cars,

  // Customer real estate listings
  ...customer_real_estate,

  // Customer professional profiles
  ...customer_professionals,

  // Notification outbox
  ...require('./notification_outbox'),
};
