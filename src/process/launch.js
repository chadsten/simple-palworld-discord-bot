import { isUp } from '../palworld.js';
import { validateServiceName, validateStartCommand, validateWorkingDirectory, sanitizeErrorMessage } from '../utils/security.js';
import { waitFor } from '../utils/async.js';
import { createLogger } from '../utils/logger.js';
import { isServerProcessRunning } from '../servercontrol.js';
import { announceServerEvent } from '../monitor.js';
import { runSteamUpdate } from '../steamupdate.js';
import config from '../config/index.js';
import { startWindowsService } from './service.js';
import { runSecureDetached } from './hiddenLaunch.js';

const logger = createLogger('Process');

/**
 * Starts the game server, optionally running a best-effort SteamCMD update first.
 * The onProgress sink (when provided) surfaces the coarse "checking for updates"
 * message; the tray path passes none. updateWarning is a short line the caller
 * appends to its reply when an update check failed but the server was started
 * anyway, and is null when the update was skipped, succeeded, or the server was
 * already running.
 * @param {{ onProgress?: (message: string) => (void|Promise<void>) }} [options]
 * @returns {Promise<{updateWarning: string|null}>}
 */
export async function startServer({ onProgress } = {}) {
  try {
    const already = await isUp();
    if (already) return { updateWarning: null };

    // Best-effort SteamCMD update before launch. The isUp() guard above proves the
    // server isn't answering REST, so it can't hold the install files open - the
    // precondition for SteamCMD to replace them. Never blocks the start.
    const updateWarning = await maybeRunUpdate(onProgress);

    const serviceName = config.server.serviceName;
    const startCmd = config.server.startCommand;

    if (serviceName) {
      // Validate service name before using it
      validateServiceName(serviceName);
      await startWindowsService(serviceName);
    } else if (startCmd) {
      // Validate and parse start command, and the optional working directory,
      // before either reaches the generated launch VBScript.
      const { executable, args } = validateStartCommand(startCmd);
      const workingDir = config.server.startWorkingDirectory
        ? validateWorkingDirectory(config.server.startWorkingDirectory)
        : null;
      await runSecureDetached(executable, args, workingDir);
    } else {
      throw new Error('No SERVICE_NAME or START_CMD configured');
    }

    const ok = await waitFor(async () => await isUp(), config.timing.startTimeoutMs, config.timing.pollIntervalMs);
    if (!ok) throw new Error('Server did not come up in time');
    return { updateWarning };
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    const sanitizedError = new Error(sanitizedMessage);
    sanitizedError.name = error.name;
    throw sanitizedError;
  }
}

/**
 * Runs the best-effort SteamCMD update-on-start before launch, when enabled.
 * Returns a short warning string to append to the caller's reply when the update
 * did NOT succeed, or null when it was skipped or succeeded. Never throws: an
 * update problem must never block the server start.
 *
 * Skipped (returns null) when UPDATE_ON_START is off or STEAMCMD_PATH is unset,
 * and also when a server process is still alive - isUp() probes the REST API,
 * but a hung/zombie server that stopped answering REST can still hold the file
 * locks SteamCMD needs, so we never update while any server process lives.
 * On failure it surfaces loudly in bot.log and the announce channel here, and
 * returns the warning for the Discord reply.
 * @param {(message: string) => (void|Promise<void>)} [onProgress] - Coarse progress sink
 * @returns {Promise<string|null>} Warning text for a failed update, else null
 */
async function maybeRunUpdate(onProgress) {
  if (!config.steam.updateOnStart || !config.steam.steamcmdPath) {
    logger.debug('Update-on-start disabled or STEAMCMD_PATH unset; skipping update');
    return null;
  }

  if (await isServerProcessRunning()) {
    logger.warn('Skipping SteamCMD update: a server process is still alive (REST may be unresponsive)');
    return null;
  }

  const result = await runSteamUpdate({ onProgress });
  if (result.ok) {
    logger.info(result.updated ? 'SteamCMD update applied' : 'Server already up to date');
    return null;
  }

  // Best-effort: start on the current build and surface the failure loudly - here
  // in bot.log and the announce channel; the returned line goes to the reply.
  logger.warn(`SteamCMD update failed: ${result.reason}`);
  await announceServerEvent('⚠️ Server update check failed — starting on the current build. See logs.');
  return '⚠️ Update check failed — starting on the current build. See logs.';
}
