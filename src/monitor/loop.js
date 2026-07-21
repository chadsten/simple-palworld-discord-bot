import { isUp, getPlayers, getMetrics } from '../palworld.js';
import { armRestartCountdown, cancelRestartCountdown } from '../autorestart.js';
import { recordSample } from '../perflog.js';
import { sanitizeErrorMessage } from '../utils/security.js';
import { createLogger } from '../utils/logger.js';
import { logPath, rolloverIfLarge, MAX_LOG_BYTES } from '../utils/logfiles.js';
import { withLock } from '../lock.js';
import config from '../config/index.js';
import { updateDiscordStatus, announceServerEvent, setDiscordClient, lastKnownServerName } from './presence.js';

// Server state constants
export const SERVER_STATE = {
  UNKNOWN: 'UNKNOWN',       // Bot doesn't know current server state
  KNOWN_UP: 'KNOWN_UP',     // Bot knows server is running
  KNOWN_DOWN: 'KNOWN_DOWN'  // Bot knows server is stopped
};

// Monitoring state
let consecutiveEmptyChecks = 0;
let monitoringActive = false;
let intervalId = null;
export let serverState = SERVER_STATE.UNKNOWN;

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
    // Any pending restart countdown belongs to the server instance that just
    // went away - keeping it would restart a stopped server, or fire its
    // warnings and restart against whatever gets started next.
    cancelRestartCountdown('server is down');
    await updateDiscordStatus();
  }
}

/**
 * Starts the background server monitoring system
 * @param {Function} gracefulShutdownFn - Function to call for graceful shutdown
 * @param {Client} client - Discord client for status updates
 * @param {Function} performRestartFn - Optional scheduled-restart action
 *   (actions.doScheduledRestart). Injected rather than imported for the same
 *   reason as gracefulShutdownFn: actions.js imports this module, so importing
 *   it here would close a cycle. Omitting it disables the auto-restart arming.
 */
export async function startMonitoring(gracefulShutdownFn, client = null, performRestartFn = null) {
  setDiscordClient(client);
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
    await performMonitorCheck(gracefulShutdownFn, performRestartFn);
  }, config.monitoring.intervalMs);
}

/**
 * Performs a single monitoring check
 * @param {Function} gracefulShutdownFn - Function to call for graceful shutdown
 * @param {Function} performRestartFn - Optional scheduled-restart action, armed
 *   with the current uptime whenever the server is confirmed UP
 */
async function performMonitorCheck(gracefulShutdownFn, performRestartFn = null) {
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

    // ONE /metrics sample per poll, feeding two consumers:
    //   1. the FPS sample log, always - uptime, FPS and player count have to come
    //      from the same response or the correlation the log exists for is lost;
    //   2. scheduled auto-restart, when enabled and the action was injected. This
    //      poll only DETECTS that uptime has entered the restart window;
    //      autorestart.js then arms precise one-shot timers for the in-game
    //      countdown.
    // Isolated in its own try/catch so a /metrics hiccup costs nothing more than
    // skipping this cycle - the auto-stop logic below must run regardless, and the
    // next poll re-checks.
    try {
      const metrics = await getMetrics();
      recordSample({ uptime: metrics.uptime, fps: metrics.serverfps, players: metrics.currentplayernum });
      if (config.autoRestart.enabled && performRestartFn) {
        armRestartCountdown(metrics.uptime || 0, performRestartFn);
      }
    } catch (error) {
      logger.warn(`Metrics check skipped: ${sanitizeErrorMessage(error)}`);
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
          const result = await withLock(async () => {
            return await gracefulShutdownFn();
          });

          if (result.success) {
            logger.info(`Auto-stop successful: ${result.message}`);
            // Reset counter after successful shutdown
            consecutiveEmptyChecks = 0;
            // Announce to the configured channel (best-effort, never throws)
            await announceServerEvent(`🛑 ${lastKnownServerName} auto-stopped — no players online.`);
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
    logger.error(`Error during monitoring check: ${sanitizedMessage}`);
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
