import 'dotenv/config';
import { isUp, getPlayers, getInfo } from './palworld.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger, createPerformanceLogger } from './utils/logger.js';
import config from './config/index.js';
import { ActivityType } from 'discord.js';

// Server state constants
const SERVER_STATE = {
  UNKNOWN: 'UNKNOWN',       // Bot doesn't know current server state
  KNOWN_UP: 'KNOWN_UP',     // Bot knows server is running
  KNOWN_DOWN: 'KNOWN_DOWN'  // Bot knows server is stopped
};

// Monitoring state
let consecutiveEmptyChecks = 0;
let monitoringActive = false;
let intervalId = null;
let serverState = SERVER_STATE.UNKNOWN;
let discordClient = null;
let lastKnownServerName = 'Palworld Server';

// Logger instance for this module
const logger = createLogger('Monitor');

/**
 * Internal function to handle server state change to UP
 * Centralizes all the logic for when server becomes available
 */
async function handleServerUp() {
  if (serverState !== SERVER_STATE.KNOWN_UP) {
    serverState = SERVER_STATE.KNOWN_UP;
    consecutiveEmptyChecks = 0;
    logger.info('Monitoring Started');
    await updateDiscordStatus();
  }
}

/**
 * Internal function to handle server state change to DOWN  
 * Centralizes all the logic for when server becomes unavailable
 */
async function handleServerDown() {
  if (serverState !== SERVER_STATE.KNOWN_DOWN) {
    serverState = SERVER_STATE.KNOWN_DOWN;
    consecutiveEmptyChecks = 0;
    logger.info('Monitoring Paused');
    await updateDiscordStatus();
  }
}

/**
 * Starts the background server monitoring system
 * @param {Function} gracefulShutdownFn - Function to call for graceful shutdown
 * @param {Function} withLockFn - Lock mechanism to prevent concurrent operations
 * @param {Client} client - Discord client for status updates
 */
export async function startMonitoring(gracefulShutdownFn, withLockFn, client = null) {
  discordClient = client;
  if (monitoringActive) {
    logger.info('Already active, skipping start');
    return;
  }

  monitoringActive = true;
  consecutiveEmptyChecks = 0;
  
  // Perform immediate server status check (not full monitoring)
  try {
    const serverUp = await isUp();
    if (serverUp) {
      logger.info('Server is KNOWN_UP');
      await handleServerUp();
    } else {
      logger.info('Server is KNOWN_DOWN');
      await handleServerDown();
    }
  } catch {
    // If check fails, leave state as UNKNOWN and let first interval handle it
    logger.info('Monitoring Started');
  }
  
  intervalId = setInterval(async () => {
    await performMonitorCheck(gracefulShutdownFn, withLockFn);
  }, config.monitoring.intervalMs);
}

/**
 * Stops the background monitoring system
 */
export function stopMonitoring() {
  if (!monitoringActive) {
    logger.info('Not active, skipping stop');
    return;
  }
  
  logger.info('Stopping monitoring');
  monitoringActive = false;
  consecutiveEmptyChecks = 0;
  
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Performs a single monitoring check
 * @param {Function} gracefulShutdownFn - Function to call for graceful shutdown
 * @param {Function} withLockFn - Lock mechanism to prevent concurrent operations
 */
async function performMonitorCheck(gracefulShutdownFn, withLockFn) {
  const perfLogger = createPerformanceLogger('Monitor', 'check');
  
  logger.debug('Starting monitor check');
  
  // Skip monitoring entirely when we know server is down
  if (serverState === SERVER_STATE.KNOWN_DOWN) {
    logger.debug('Server state is KNOWN_DOWN, skipping monitoring check');
    perfLogger.end({ skipped: true, serverState });
    return;
  }
  
  try {
    // Check if server is up
    logger.debug('Checking server status');
    perfLogger.checkpoint('server-status-check');
    const serverUp = await isUp();
    
    if (!serverUp) {
      // Server is down, update state and reset counter
      if (serverState !== SERVER_STATE.KNOWN_DOWN) {
        logger.info('Server is DOWN, updating state to KNOWN_DOWN');
        await handleServerDown();
      }
      return;
    }

    logger.debug('Server is UP, checking player count');
    // Update server state if needed
    if (serverState !== SERVER_STATE.KNOWN_UP) {
      logger.info('Server is UP, updating state to KNOWN_UP');
      await handleServerUp();
    }
    perfLogger.checkpoint('player-count-check');
    // Server is up, check player count
    const players = await getPlayers();
    const playerCount = players.length;
    
    const checkData = {
      playerCount,
      consecutiveEmptyChecks,
      threshold: config.monitoring.emptyCheckThreshold
    };
    
    if (playerCount === 0) {
      // No players online
      consecutiveEmptyChecks++;
      checkData.consecutiveEmptyChecks = consecutiveEmptyChecks;
      
      logger.info(`Empty server check ${consecutiveEmptyChecks}/${config.monitoring.emptyCheckThreshold}`);
      
      if (consecutiveEmptyChecks >= config.monitoring.emptyCheckThreshold) {
        logger.warn(`Threshold reached, triggering auto-stop`);
        
        // Use the lock mechanism to prevent conflicts with manual commands
        try {
          const result = await withLockFn(async () => {
            return await gracefulShutdownFn();
          });
          
          if (result.success) {
            logger.info(`Auto-stop successful: ${result.message}`);
            // Reset counter after successful shutdown
            consecutiveEmptyChecks = 0;
          } else {
            logger.warn(`Auto-stop failed: ${result.message}`);
            // Keep the counter if shutdown failed (maybe players joined during shutdown)
          }
        } catch (lockError) {
          // Lock is busy (manual operation in progress)
          const sanitizedMessage = sanitizeErrorMessage(lockError);
          logger.info(`Auto-stop skipped (operation in progress): ${sanitizedMessage}`);
        }
      }
    } else {
      // Players are online, reset counter
      if (consecutiveEmptyChecks > 0) {
        logger.info(`${playerCount} player(s) online, resetting empty check counter`);
        consecutiveEmptyChecks = 0;
      } else {
        logger.debug(`Players present, no action needed`);
      }
    }
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    logger.error('Error during monitoring check', { error: sanitizedMessage });
    // Don't reset counter on errors, just log and continue
  }
  
  perfLogger.end({ consecutiveEmptyChecks });
  logger.debug('Monitor check completed');
}

/**
 * Updates the server state to indicate server is up
 * Called when the bot successfully starts the server
 */
export async function setServerUp() {
  if (serverState !== SERVER_STATE.KNOWN_UP) {
    logger.info('Server is KNOWN_UP');
    await handleServerUp();
  }
}

/**
 * Updates the server state to indicate server is down
 * Called when the bot successfully stops the server
 */
export async function setServerDown() {
  if (serverState !== SERVER_STATE.KNOWN_DOWN) {
    logger.info('Server is KNOWN_DOWN');
    await handleServerDown();
  }
}

/**
 * Updates the Discord bot's status based on server state
 * @private
 */
async function updateDiscordStatus() {
  if (!discordClient || !discordClient.user) {
    logger.debug('Discord client not available, skipping status update');
    return;
  }

  try {
    let serverName = lastKnownServerName;
    
    // Try to get the actual server name if server is up
    if (serverState === SERVER_STATE.KNOWN_UP) {
      try {
        const info = await getInfo();
        if (info.servername) {
          serverName = info.servername;
          lastKnownServerName = serverName; // Store for when server goes down
        }
      } catch {
        // If we can't get server info, use last known name
      }
    }
    // When server is down, we use the last known server name

    const status = serverState === SERVER_STATE.KNOWN_UP ? 'UP' : 'DOWN';
    const activityName = `${serverName} is ${status}`;
    
    await discordClient.user.setActivity(activityName, { 
      type: ActivityType.Custom 
    });
    
    logger.info(`Discord status updated: ${activityName}`);
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    logger.error('Failed to update Discord status', { error: sanitizedMessage });
  }
}

/**
 * Gets current monitoring status for debugging
 * @returns {Object} Current monitoring state
 */
export function getMonitorStatus() {
  return {
    active: monitoringActive,
    serverState,
    intervalMs: config.monitoring.intervalMs,
    emptyCheckThreshold: config.monitoring.emptyCheckThreshold,
    consecutiveEmptyChecks,
    nextCheckIn: intervalId ? Math.ceil(config.monitoring.intervalMs / 1000) : null
  };
}