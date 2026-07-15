/**
 * Interaction-free server actions
 *
 * These functions own the start/stop/bounce orchestration so it can be shared by
 * BOTH the Discord slash commands (index.js) and the host-side tray "Commands"
 * submenu (tray.js) with zero duplication. They take no Discord interaction and
 * return a plain { success, message, embedTitle? } result; the CALLER decides how
 * to present it (the Discord side builds an embed from embedTitle, the tray side
 * just logs the message).
 *
 * Each action runs under the single shared lock (lock.js) so it cannot interleave
 * with another command or the monitor's auto-stop. On success it posts a short
 * actor-named line to the announce channel.
 *
 * AUTO-STOP IS A SEPARATE PATH: the background monitor calls gracefulShutdown()
 * directly (via the lock it was handed), NOT doStop(), and does its own auto-stop
 * announcement. The action-level announcements below therefore fire only for
 * explicit user/host start/stop/bounce actions - there is no double announce.
 */
import { getPlayers, saveWorld, shutdown, isUp } from './palworld.js';
import { startServer } from './process.js';
import { setServerUp, setServerDown, announceServerEvent } from './monitor.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { sleep, waitFor } from './utils/async.js';
import { withLock } from './lock.js';
import config from './config/index.js';

/**
 * Posts a best-effort actor-named line to the announce channel after a successful
 * action. Silently does nothing when no announce channel is configured; never
 * throws (announceServerEvent is itself best-effort).
 * @param {string|undefined} actor - Display name of who triggered the action
 * @param {string} verb - Past-tense verb, e.g. 'started', 'stopped', 'restarted'
 */
async function announceAction(actor, verb) {
  if (!config.discord.announceChannelId) return;
  await announceServerEvent(`${actor} ${verb} the server.`);
}

/**
 * Executes graceful server shutdown with player checks and world save.
 * Used by the /palstop and /palbounce actions AND directly by the monitor's
 * auto-stop path. Returns a structured result rather than replying to anyone.
 * @returns {Promise<{success: boolean, message: string}>} Result of shutdown attempt
 */
export async function gracefulShutdown() {
  // Check if server is up
  const up = await isUp();
  if (!up) return { success: false, message: 'Server already appears **DOWN**.' };

  // First player count check - don't stop if players are online
  let players = await getPlayers();
  if (players.length > 0) {
    return { success: false, message: `Cannot stop: **${players.length}** player(s) online.` };
  }

  try {
    // Save world state before shutdown to prevent data loss
    await saveWorld();

    // Wait after saving to allow any last-second player connections
    // This prevents stopping the server right as someone joins
    await sleep(config.timing.saveWorldDelayMs);

    // Second player count check - abort if players connected during save operation
    // This double-check prevents accidentally stopping server with active players
    players = await getPlayers();
    if (players.length > 0) {
      return { success: false, message: `Abort: **${players.length}** player(s) just connected.` };
    }

    // Graceful shutdown with configured delay allows server to clean up properly
    // The delay gives the server time to finish any pending operations
    await shutdown(config.timing.shutdownDelaySeconds, 'Stopping (admin request).');

    // Wait for server to actually go down before confirming
    const serverDown = await waitFor(async () => !(await isUp()), config.timing.startTimeoutMs, config.timing.pollIntervalMs);
    if (!serverDown) {
      return { success: false, message: 'Server shutdown timed out - may still be running.' };
    }

    // Notify monitor that server is now down
    await setServerDown();

    return { success: true, message: 'Graceful server stop completed.' };
  } catch (e) {
    // Provide specific error feedback for debugging server issues
    const sanitizedMessage = sanitizeErrorMessage(e);
    return { success: false, message: `Stop failed: \`${sanitizedMessage}\`` };
  }
}

/**
 * Starts the server under the shared lock. Mirrors the /palstart core behaviour
 * and returns the same messages so the Discord command is unchanged.
 * @param {{ actor?: string }} [options] - actor is used only for the announcement
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 */
export async function doStart({ actor } = {}) {
  try {
    return await withLock(async () => {
      const up = await isUp();
      if (up) {
        return { success: true, message: 'Server is already **UP**.', embedTitle: 'Server Status' };
      }

      try {
        await startServer();

        // Notify monitor that server is now up
        await setServerUp();

        // Announce the successful, explicitly-requested start
        await announceAction(actor, 'started');

        return { success: true, message: 'Server started successfully!', embedTitle: 'Server Started' };
      } catch (e) {
        // Provide specific error feedback to help with troubleshooting
        const sanitizedMessage = sanitizeErrorMessage(e);
        return { success: false, message: `Start failed: \`${sanitizedMessage}\`` };
      }
    });
  } catch (err) {
    // Lock busy - another operation is in progress
    return { success: false, message: sanitizeErrorMessage(err) };
  }
}

/**
 * Gracefully stops the server under the shared lock. Returns gracefulShutdown's
 * structured result verbatim so the /palstop message is unchanged.
 * @param {{ actor?: string }} [options] - actor is used only for the announcement
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function doStop({ actor } = {}) {
  try {
    return await withLock(async () => {
      const result = await gracefulShutdown();
      if (result.success) {
        await announceAction(actor, 'stopped');
      }
      return result;
    });
  } catch (err) {
    // Lock busy - another operation is in progress
    return { success: false, message: sanitizeErrorMessage(err) };
  }
}

/**
 * Runs the full stop -> wait -> start sequence under a SINGLE lock so nothing can
 * interleave mid-bounce. Mirrors the /palbounce logic and returns only the FINAL
 * result. The optional onProgress callback receives the intermediate "Restarting
 * in Ns..." message so a caller can surface it (the Discord command edits its
 * reply; the tray logs it) without the action doing any interactive I/O itself.
 * @param {{ actor?: string, onProgress?: (message: string) => (void|Promise<void>) }} [options]
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 */
export async function doBounce({ actor, onProgress } = {}) {
  try {
    return await withLock(async () => {
      // Reuse the graceful stop path - it handles the "players online" and
      // "already down" cases and returns a structured result
      const stopResult = await gracefulShutdown();
      if (!stopResult.success) {
        // Do not start the server if the stop did not succeed
        return { success: false, message: `Bounce aborted — ${stopResult.message}` };
      }

      // Stop succeeded - surface the intermediate message and wait before restarting
      if (onProgress) {
        await onProgress(`Server stopped. Restarting in ${Math.round(config.timing.bounceDelayMs / 1000)}s...`);
      }
      await sleep(config.timing.bounceDelayMs);

      try {
        await startServer();

        // Notify monitor that server is now up
        await setServerUp();

        // Announce the successful, explicitly-requested restart
        await announceAction(actor, 'restarted');

        return { success: true, message: 'Server restarted successfully!', embedTitle: 'Server Restarted' };
      } catch (e) {
        // Stop already completed, so surface the restart failure specifically
        return { success: false, message: `Restart failed after stop: \`${sanitizeErrorMessage(e)}\`` };
      }
    });
  } catch (err) {
    // Lock busy - another operation is in progress
    return { success: false, message: sanitizeErrorMessage(err) };
  }
}
