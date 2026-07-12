/**
 * Configurable Logging Utility
 * 
 * Provides structured, level-based logging with performance optimizations
 * for production environments. Supports filtering by log level to reduce
 * verbosity and improve performance.
 */

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
  const timestamp = getTimestamp();
  const color = COLORS[level] || COLORS.INFO;
  const reset = COLORS.RESET;
  
  return `${color}[${timestamp}] ${level.padEnd(5)} [${component}] ${message}${reset}`;
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