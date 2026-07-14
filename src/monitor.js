import 'dotenv/config';
import { isUp, getPlayers, getInfo } from './palworld.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { logPath, rolloverIfLarge, MAX_LOG_BYTES } from './utils/logfiles.js';
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
 * Performs a single monitoring check
 * @param {Function} gracefulShutdownFn - Function to call for graceful shutdown
 * @param {Function} withLockFn - Lock mechanism to prevent concurrent operations
 */
async function performMonitorCheck(gracefulShutdownFn, withLockFn) {
  logger.debug('Starting monitor check');

  // The detached game process owns palserver.log directly, so the bot can't
  // roll it inline - piggyback a size check on each monitor cycle instead.
  // While the server is running Windows may refuse to rename a file it holds
  // an open handle on (EBUSY/EPERM); rolloverIfLarge swallows that, so the
  // rename is simply deferred until the process releases the handle (server
  // stop) and the next check succeeds. We never force-close the game's handle.
  rolloverIfLarge(logPath('palserver.log'), MAX_LOG_BYTES);

  // Skip monitoring entirely when we know server is down
  if (serverState === SERVER_STATE.KNOWN_DOWN) {
    logger.debug('Server state is KNOWN_DOWN, skipping monitoring check');
    return;
  }

  try {
    // Check if server is up
    logger.debug('Checking server status');
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
    // Server is up, check player count
    const players = await getPlayers();
    const playerCount = players.length;

    if (playerCount === 0) {
      // No players online
      consecutiveEmptyChecks++;

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
            // Announce to the configured channel (best-effort, never throws)
            await announce(`🛑 ${lastKnownServerName} auto-stopped — no players online.`);
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
 * Sends a message to the configured announcement channel
 * Best-effort: silently disabled when unconfigured, never throws
 * @param {string} message - Message to post to the channel
 * @private
 */
async function announce(message) {
  if (!config.discord.announceChannelId) {
    return;
  }

  if (!discordClient) {
    logger.debug('Discord client not available, skipping announcement');
    return;
  }

  try {
    const channel = await discordClient.channels.fetch(config.discord.announceChannelId);
    if (!channel?.isTextBased?.()) {
      logger.warn(`Announce channel not found or not text-based: ${config.discord.announceChannelId}`);
      return;
    }
    await channel.send(message);
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    logger.warn('Failed to send announcement', { error: sanitizedMessage });
  }
}