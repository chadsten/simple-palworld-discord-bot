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

/**
 * Validates a boolean-like environment value. Accepts real booleans and the
 * case-insensitive strings "true"/"false" (surrounding whitespace tolerated), and
 * uses the supplied default when the value is unset or empty. Any other value is
 * rejected, matching the module's fail-fast approach.
 * @param {string} name - Environment variable name for error reporting
 * @param {string|boolean|undefined} value - Value to parse
 * @param {boolean} defaultValue - Value used when unset or empty
 * @returns {boolean} Parsed boolean value
 * @throws {Error} If value is present but not a recognized boolean
 */
function validateBoolean(name, value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new Error(`${name} must be true or false, got: ${value}`);
}

// Parse and validate all configuration values
const config = {
  // Discord Bot Configuration
  discord: {
    token: validateRequired('DISCORD_TOKEN', process.env.DISCORD_TOKEN),
    clientId: validateRequired('CLIENT_ID', process.env.CLIENT_ID),
    guildId: validateRequired('GUILD_ID', process.env.GUILD_ID),
    roleName: validateOptionalString(process.env.PALSERVER_ROLE_NAME) || 'palserver',
    adminRoleName: validateOptionalString(process.env.PALSERVER_ADMIN_ROLE_NAME) || 'palserver-admin',
    announceChannelId: validateOptionalString(process.env.ANNOUNCE_CHANNEL_ID),
    hostActorName: validateOptionalString(process.env.HOST_ACTOR_NAME) || 'Host'
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
    
    // Grace period for server shutdown in seconds (default: 10 seconds). This is
    // the waittime handed to REST /shutdown: the server broadcasts the message to
    // in-game chat immediately, then waits this long before going down, so it is
    // the players' last notice. 2 was fine when only the empty-server /palstop
    // reached this path, but /palkill and the scheduled restart now stop with
    // players connected. Keep in sync with .env.example.
    shutdownDelaySeconds: validatePositiveInteger(
      'SHUTDOWN_DELAY_SECONDS',
      process.env.SHUTDOWN_DELAY_SECONDS || '10',
      0,     // Minimum 0 seconds (immediate)
      30     // Maximum 30 seconds
    ),

    // Delay between graceful stop and restart during a bounce, in milliseconds (default: 15 seconds)
    bounceDelayMs: validatePositiveInteger(
      'BOUNCE_DELAY_MS',
      process.env.BOUNCE_DELAY_MS || '15000',
      1000,   // Minimum 1 second
      120000  // Maximum 2 minutes
    ),

    // How long to wait after a world save before shutting the server down, so the
    // save is durably written to disk (default: 30 seconds). Nothing documents
    // whether the REST /shutdown saves on its way out, so the bot always saves
    // first and waits out this settle window before stopping. It doubles as the
    // window in which a late-joining player can still abort a graceful stop.
    saveSettleMs: validatePositiveInteger(
      'SAVE_SETTLE_MS',
      process.env.SAVE_SETTLE_MS || '30000',
      0,      // Minimum 0 (no settle wait)
      120000  // Maximum 2 minutes
    ),

    // How long to wait for the server to actually go down after a REST shutdown
    // before escalating to a force kill (default: 45 seconds). Distinct from
    // startTimeoutMs, which is a START budget and has nothing to do with stops.
    stopTimeoutMs: validatePositiveInteger(
      'STOP_TIMEOUT_MS',
      process.env.STOP_TIMEOUT_MS || '45000',
      10000,  // Minimum 10 seconds
      300000  // Maximum 5 minutes
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

  // Scheduled Auto-Restart Configuration
  // Opt-in. The monitor watches server uptime and, once it nears intervalHours,
  // arms a countdown that warns in-game before saving, stopping and restarting.
  autoRestart: {
    // Master switch: off unless explicitly enabled, mirroring steam.updateOnStart.
    enabled: validateBoolean('AUTO_RESTART_ENABLED', process.env.AUTO_RESTART_ENABLED, false),

    // Hours of server uptime before an automatic restart (default: 6 hours).
    intervalHours: validatePositiveInteger(
      'RESTART_INTERVAL_HOURS',
      process.env.RESTART_INTERVAL_HOURS || '6',
      1,   // Minimum 1 hour: the baked-in warning schedule starts 30 minutes out,
           // so a sub-hour interval could want to warn about the next restart
           // before the previous one had even finished.
      168  // Maximum 1 week
    )
  },

  // SteamCMD Update-on-Start Configuration
  // No-op unless updateOnStart is true AND steamcmdPath is set.
  steam: {
    // Master switch: run a SteamCMD update check before every server start.
    updateOnStart: validateBoolean('UPDATE_ON_START', process.env.UPDATE_ON_START, false),

    // Absolute path to steamcmd.exe. Empty disables the feature entirely.
    steamcmdPath: validateOptionalString(process.env.STEAMCMD_PATH),

    // Steam app id of the Palworld dedicated server (2394010 is confirmed correct).
    appId: validatePositiveInteger('STEAM_APP_ID', process.env.STEAM_APP_ID || '2394010'),

    // Install directory SteamCMD updates into. Empty falls back to START_CWD.
    installDir: validateOptionalString(process.env.STEAM_INSTALL_DIR),

    // Kill the update if no SteamCMD output arrives for this long (default: 2 min).
    // SteamCMD streams continuous progress, so silence means it wedged.
    stallTimeoutMs: validatePositiveInteger(
      'UPDATE_STALL_TIMEOUT_MS',
      process.env.UPDATE_STALL_TIMEOUT_MS || '120000',
      30000,   // Minimum 30 seconds
      600000   // Maximum 10 minutes
    ),

    // Hard wall-clock cap on the whole update regardless of output (default: 30 min).
    timeoutMs: validatePositiveInteger(
      'UPDATE_TIMEOUT_MS',
      process.env.UPDATE_TIMEOUT_MS || '1800000',
      60000,    // Minimum 1 minute
      3600000   // Maximum 1 hour
    )
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