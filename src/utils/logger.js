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
export const LOG_LEVELS = {
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

/**
 * Performance logging utilities
 */
export class PerformanceLogger {
  constructor(component, operation) {
    this.component = component;
    this.operation = operation;
    this.startTime = process.hrtime.bigint();
    this.logger = createLogger(component);
  }
  
  /**
   * End performance measurement and log result
   * @param {Object} metadata - Additional metadata
   */
  end(metadata = {}) {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - this.startTime) / 1000000; // Convert nanoseconds to milliseconds
    
    this.logger.debug(`${this.operation} completed`, {
      durationMs: durationMs.toFixed(2),
      ...metadata
    });
    
    return durationMs;
  }
  
  /**
   * Add checkpoint measurement
   * @param {string} checkpoint - Checkpoint name
   * @param {Object} metadata - Additional metadata
   */
  checkpoint(checkpoint, metadata = {}) {
    const checkpointTime = process.hrtime.bigint();
    const durationMs = Number(checkpointTime - this.startTime) / 1000000;
    
    this.logger.debug(`${this.operation} - ${checkpoint}`, {
      checkpointMs: durationMs.toFixed(2),
      ...metadata
    });
    
    return durationMs;
  }
}

/**
 * Create performance logger for timing operations
 * @param {string} component - Component name
 * @param {string} operation - Operation description
 * @returns {PerformanceLogger} Performance logger instance
 */
export function createPerformanceLogger(component, operation) {
  return new PerformanceLogger(component, operation);
}

/**
 * Quick performance timing utility
 * @param {string} component - Component name
 * @param {string} operation - Operation description
 * @param {Function} fn - Function to time
 * @returns {Promise<*>} Function result
 */
export async function timeOperation(component, operation, fn) {
  const perfLogger = createPerformanceLogger(component, operation);
  try {
    const result = await fn();
    perfLogger.end({ success: true });
    return result;
  } catch (error) {
    perfLogger.end({ success: false, error: error.message });
    throw error;
  }
}

/**
 * Get current log level information
 * @returns {Object} Current logging configuration
 */
export function getLogConfig() {
  return {
    currentLevel: LEVEL_NAMES[CURRENT_LEVEL],
    currentLevelValue: CURRENT_LEVEL,
    environmentVariable: process.env.LOG_LEVEL || 'not set (using INFO)',
    availableLevels: LEVEL_NAMES
  };
}

export function logStartupInfo() {
  const config = getLogConfig();
  logger.info(`Logger initialized: ${config.currentLevel} level`);
}