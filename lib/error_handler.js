const logger = require('./logger');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 */

/**
 * @param {Error} err
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.expose || status < 500
    ? err.message
    : 'Internal server error.';

  if (status >= 500) {
    logger.error(`${req.method} ${req.path}`, {
      status,
      message: err.message,
      stack: err.stack,
      authPhone: req.authPhone || '(none)',
    });
  } else {
    logger.warn(`${req.method} ${req.path}`, {
      status,
      message: err.message,
      authPhone: req.authPhone || '(none)',
    });
  }

  if (res.headersSent) return;

  res.status(status).json({
    message,
    ...(process.env.NODE_ENV !== 'production' && status >= 500
      ? { error: err.message, stack: err.stack }
      : {}),
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    message: `Unknown route: ${req.method} ${req.path}`,
  });
}

module.exports = { errorHandler, notFoundHandler };
