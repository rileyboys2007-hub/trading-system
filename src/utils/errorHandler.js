/**
 * utils/errorHandler.js — Global Error Handling Middleware
 * Catches all unhandled errors in Express routes and services.
 * Returns clean JSON error responses instead of crashing the server.
 *
 * notFound   — catches 404s for undefined routes
 * errorHandler — catches all thrown errors
 */

const logger = require("./logger");

function notFound(req, res, next) {
  const err = new Error(`Route not found: ${req.method} ${req.path}`);
  err.statusCode = 404;
  next(err);
}

function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  logger.error(`[${status}] ${message}${err.stack ? "\n" + err.stack : ""}`);

  res.status(status).json({
    success: false,
    error:   message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}

module.exports = { notFound, errorHandler };
