/**
 * utils/logger.js — Winston Logging System
 * Logs to console (dev) and rotating daily log files (all envs).
 * Log files live in src/logs/ and rotate daily, kept for 14 days.
 *
 * Usage anywhere in the project:
 *   const logger = require("../utils/logger");
 *   logger.info("message");
 *   logger.warn("message");
 *   logger.error("message");
 */

const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const path = require("path");

const LOG_DIR   = process.env.LOG_DIR || path.join(__dirname, "../logs");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const fmt = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`
  )
);

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: fmt,
  transports: [
    // Console output (colored in dev)
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), fmt),
    }),

    // Rotating daily log file — all levels
    new DailyRotateFile({
      dirname:      LOG_DIR,
      filename:     "system-%DATE%.log",
      datePattern:  "YYYY-MM-DD",
      maxFiles:     "14d",
      zippedArchive: true,
    }),

    // Separate error-only log file
    new DailyRotateFile({
      dirname:      LOG_DIR,
      filename:     "error-%DATE%.log",
      datePattern:  "YYYY-MM-DD",
      level:        "error",
      maxFiles:     "30d",
      zippedArchive: true,
    }),
  ],
});

module.exports = logger;
