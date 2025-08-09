/**
 * Centralized Configuration Module
 * 
 * This module consolidates all environment variable parsing and validation
 * across the Palworld Discord bot to eliminate duplication and ensure
 * consistent configuration handling.
 * 
 * Features:
 * - Type validation for all configuration values
 * - Range validation where appropriate
 * - Clear error messages for invalid configuration
 * - Fail-fast approach at startup
 * - Organized configuration categories
 */
import 'dotenv/config';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Config');

/**
 * Validates that a value is a positive integer within optional bounds
 * @param {string} name - Environment variable name for error reporting
 * @param {string} value - String value to parse and validate
 * @param {number} min - Minimum allowed value (optional)
 * @param {number} max - Maximum allowed value (optional)
 * @returns {number} Parsed integer value
 * @throws {Error} If value is invalid
 */
function validatePositiveInteger(name, value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = parseInt(value, 10);
  
  if (isNaN(parsed)) {
    throw new Error(`${name} must be a valid integer, got: ${value}`);
  }
  
  if (parsed < min) {
    throw new Error(`${name} must be at least ${min}, got: ${parsed}`);
  }
  
  if (parsed > max) {
    throw new Error(`${name} must be at most ${max}, got: ${parsed}`);
  }
  
  return parsed;
}

/**
 * Validates that a required environment variable is set and non-empty
 * @param {string} name - Environment variable name
 * @param {string} value - Environment variable value
 * @returns {string} The validated value
 * @throws {Error} If value is missing or empty
 */
function validateRequired(name, value) {
  if (!value || value.trim() === '') {
    throw new Error(`Required environment variable ${name} is not set or is empty`);
  }
  return value.trim();
}

/**
 * Validates optional string values with basic sanitization
 * @param {string} value - Value to validate
 * @returns {string|null} Sanitized value or null if not provided
 */
function validateOptionalString(value) {
  return value ? value.trim() : null;
}

// Parse and validate all configuration values
const config = {
  // Discord Bot Configuration
  discord: {
    token: validateRequired('DISCORD_TOKEN', process.env.DISCORD_TOKEN),
    clientId: validateRequired('CLIENT_ID', process.env.CLIENT_ID),
    guildId: validateRequired('GUILD_ID', process.env.GUILD_ID)
  },

  // Palworld REST API Configuration
  palworld: {
    apiUrl: validateRequired('PAL_REST_URL', process.env.PAL_REST_URL),
    username: validateRequired('PAL_REST_USER', process.env.PAL_REST_USER),
    password: validateRequired('PAL_REST_PASS', process.env.PAL_REST_PASS)
  },

  // Server Management Configuration
  server: {
    serviceName: validateOptionalString(process.env.SERVICE_NAME),
    startCommand: validateOptionalString(process.env.START_CMD),
    startWorkingDirectory: validateOptionalString(process.env.START_CWD)
  },

  // Timing Configuration (all in milliseconds unless specified)
  timing: {
    // Server startup timeout in milliseconds (default: 2 minutes)
    startTimeoutMs: validatePositiveInteger(
      'START_TIMEOUT_MS', 
      process.env.START_TIMEOUT_MS || '120000',
      5000,  // Minimum 5 seconds
      600000 // Maximum 10 minutes
    ),
    
    // Polling interval for server status checks in milliseconds (default: 3 seconds)
    pollIntervalMs: validatePositiveInteger(
      'POLL_INTERVAL_MS',
      process.env.POLL_INTERVAL_MS || '3000',
      1000,  // Minimum 1 second
      60000  // Maximum 1 minute
    ),
    
    // Delay after world save before final player check in milliseconds (default: 1.5 seconds)
    saveWorldDelayMs: validatePositiveInteger(
      'SAVE_WORLD_DELAY_MS',
      process.env.SAVE_WORLD_DELAY_MS || '1500',
      500,   // Minimum 0.5 seconds
      10000  // Maximum 10 seconds
    ),
    
    // Grace period for server shutdown in seconds (default: 2 seconds)
    shutdownDelaySeconds: validatePositiveInteger(
      'SHUTDOWN_DELAY_SECONDS',
      process.env.SHUTDOWN_DELAY_SECONDS || '2',
      0,     // Minimum 0 seconds (immediate)
      30     // Maximum 30 seconds
    )
  },

  // Monitoring Configuration
  monitoring: {
    // Interval between monitoring checks in milliseconds (default: 10 minutes)
    intervalMs: validatePositiveInteger(
      'MONITOR_INTERVAL_MS',
      process.env.MONITOR_INTERVAL_MS || '600000',
      60000,   // Minimum 1 minute
      3600000  // Maximum 1 hour
    ),
    
    // Number of consecutive empty checks before auto-stop (default: 2)
    emptyCheckThreshold: validatePositiveInteger(
      'EMPTY_CHECK_THRESHOLD',
      process.env.EMPTY_CHECK_THRESHOLD || '2',
      1,  // Minimum 1 check
      10  // Maximum 10 checks
    )
  },

  // Logging Configuration
  logging: {
    // Log level: ERROR, WARN, INFO, DEBUG (default: INFO)
    level: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
    
    // Enable performance logging (default: false in production)
    enablePerformanceLogging: process.env.NODE_ENV !== 'production'
  },

  // Display Configuration
  display: {
    // Character limit for JSON display in Discord embeds
    jsonDisplayLimit: 800
  }
};

// Validate server management configuration logic
if (!config.server.serviceName && !config.server.startCommand) {
  throw new Error(
    'Either SERVICE_NAME or START_CMD must be configured for server management. ' +
    'Set SERVICE_NAME to use Windows Service management, or START_CMD to use process execution.'
  );
}

// Log configuration summary (without sensitive data)
logger.info('Configuration loaded successfully');

/**
 * Frozen configuration object to prevent runtime modifications
 * This ensures configuration remains immutable after initialization
 */
export default Object.freeze(config);