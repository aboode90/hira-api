/**
 * Domain service registry — logical boundaries inside the Node monolith.
 *
 * Each domain owns routes (+ future: repository + services colocated).
 * Mount paths stay backward-compatible with existing Flutter / admin clients.
 */

const auth = require('./auth');
const platform = require('./platform');
const user = require('./user');
const merchant = require('./merchant');
const marketplace = require('./marketplace');
const delivery = require('./delivery');
const taxi = require('./taxi');
const chat = require('./chat');
const voice = require('./voice');
const notifications = require('./notifications');
const media = require('./media');
const admin = require('./admin');
const salaryCashout = require('./salary_cashout');
const kashier = require('./kashier');

/** @type {import('./types').DomainService[]} */
const domains = [
  auth,
  platform,
  user,
  merchant,
  marketplace,
  delivery,
  taxi,
  chat,
  voice,
  notifications,
  media,
  admin,
  salaryCashout,
  kashier,
];

/**
 * Mount all domain HTTP routers on the Express app.
 * @param {import('express').Express} app
 */
function mountDomainRoutes(app) {
  for (const domain of domains) {
    if (!domain?.mountPath || !domain?.router) continue;
    app.use(domain.mountPath, domain.router);
    if (Array.isArray(domain.extraMounts)) {
      for (const extra of domain.extraMounts) {
        if (extra?.mountPath && extra?.router) {
          app.use(extra.mountPath, extra.router);
        }
      }
    }
  }
}

/**
 * Start domain background workers (schedulers, pollers).
 */
function startDomainWorkers() {
  for (const domain of domains) {
    if (typeof domain.startWorkers === 'function') {
      domain.startWorkers();
    }
  }
}

module.exports = {
  domains,
  mountDomainRoutes,
  startDomainWorkers,
  auth,
  platform,
  user,
  merchant,
  marketplace,
  delivery,
  taxi,
  chat,
  voice,
  notifications,
  media,
  admin,
  salaryCashout,
  kashier,
};
