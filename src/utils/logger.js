/**
 * Configurable Logging Utility
 *
 * Provides structured, level-based logging with performance optimizations
 * for production environments. Supports filtering by log level to reduce
 * verbosity and improve performance.
 *
 * In addition to the coloured console output, every emitted line is teed to
 * logs/bot.log as PLAIN text (no ANSI codes) with size-based rollover. The
 * file side-effect is best-effort: a write failure degrades gracefully to
 * console-only and never throws.
 */
import fs from 'node:fs';
import { ensureLogDir, logPath, rolloverIfLarge, MAX_LOG_BYTES } from './logfiles.js';

/**
 * Log levels in order of priority
 */
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

/**
 * Log level names for string comparison
 */
const LEVEL_NAMES = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

/**
 * Current log level (configurable via environment)
 */
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * ANSI color codes for console output
 */
const COLORS = {
  ERROR: '\x1b[31m',   // Red
  WARN: '\x1b[33m',    // Yellow
  INFO: '\x1b[36m',    // Cyan
  DEBUG: '\x1b[37m',   // White
  RESET: '\x1b[0m'     // Reset
};

function getTimestamp() {
  return new Date().toLocaleString();
}

function formatMessage(level, component, message) {
  const color = COLORS[level] || COLORS.INFO;
  const reset = COLORS.RESET;

  return `${color}${formatPlain(level, component, message)}${reset}`;
}

/**
 * Formats a log line as plain text (no ANSI colour) for the log file.
 * @param {string} level - Log level name
 * @param {string} component - Component tag
 * @param {string} message - Log message
 * @returns {string} Uncoloured log line
 */
function formatPlain(level, component, message) {
  return `[${getTimestamp()}] ${level.padEnd(5)} [${component}] ${message}`;
}

/**
 * Rollover check cadence: check bot.log's size every this many writes rather
 * than on every line, keeping the common path free of a per-line statSync.
 */
const ROLLOVER_CHECK_EVERY = 500;

let dirReady = false;
let writeCount = 0;

/**
 * Appends a plain-text line to logs/bot.log with periodic size rollover.
 * Best-effort: any failure is swallowed so logging never breaks the app -
 * the console already received the message.
 * @param {string} line - Plain (uncoloured) log line to append
 */
function appendToFile(line) {
  try {
    if (!dirReady) {
      ensureLogDir();
      dirReady = true;
    }

    if (++writeCount % ROLLOVER_CHECK_EVERY === 0) {
      rolloverIfLarge(logPath('bot.log'), MAX_LOG_BYTES);
    }

    fs.appendFileSync(logPath('bot.log'), `${line}\n`);
  } catch {}
}

function log(level, component, message) {
  if (level > CURRENT_LEVEL) {
    return;
  }

  const levelName = LEVEL_NAMES[level];
  const formattedMessage = formatMessage(levelName, component, message);

  if (level === LOG_LEVELS.ERROR) {
    console.error(formattedMessage);
  } else if (level === LOG_LEVELS.WARN) {
    console.warn(formattedMessage);
  } else {
    console.log(formattedMessage);
  }

  appendToFile(formatPlain(levelName, component, message));
}

export function createLogger(component) {
  return {
    error: (message) => log(LOG_LEVELS.ERROR, component, message),
    warn: (message) => log(LOG_LEVELS.WARN, component, message),
    info: (message) => log(LOG_LEVELS.INFO, component, message),
    debug: (message) => log(LOG_LEVELS.DEBUG, component, message)
  };
}

/**
 * Global logger instance
 */
export const logger = createLogger('Global');