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
import { isServerProcessRunning, killServerByName } from './servercontrol.js';
import { setServerUp, setServerDown, announceServerEvent } from './monitor.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { sleep, waitFor } from './utils/async.js';
import { withLock } from './lock.js';
import config from './config/index.js';

const logger = createLogger('Actions');

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
 * The start half shared by every path that launches the server (doStart, doBounce
 * and doScheduledRestart): launch the server, flip the monitor to UP, and return
 * the caller's success message with the update-check warning appended when the
 * update-on-start check failed. Deliberately does NOT catch - each caller phrases
 * its own "failed after the stop already happened" message.
 * @param {string} successMessage - Base message to return on success
 * @param {(message: string) => (void|Promise<void>)} [onProgress] - Progress sink for startServer
 * @returns {Promise<string>} Final success message
 */
async function startAndReport(successMessage, onProgress) {
  const { updateWarning } = await startServer({ onProgress });

  // Notify monitor that server is now up
  await setServerUp();

  return updateWarning ? `${successMessage}\n${updateWarning}` : successMessage;
}

/**
 * Reports whether the server is REALLY gone, not merely quiet. A silent REST API
 * is necessary but not sufficient: a wedged server can stop answering /info while
 * still holding the world file and the game port, and a "shutdown complete" check
 * that trusted REST alone has silently lied here before.
 *
 * isServerProcessRunning() returns false when no image name is derivable (the
 * SERVICE_NAME path, where START_CMD is unset), which degrades this check to the
 * REST answer alone - the best available signal in that configuration.
 * @returns {Promise<boolean>} true when both REST and the process list say down
 * @private
 */
async function serverIsFullyDown() {
  if (await isUp()) return false;
  return !(await isServerProcessRunning());
}

/**
 * Asks the server to shut down and polls until it is actually gone. Split out of
 * saveSettleAndShutdown so gracefulShutdown can slot its final player re-check
 * between the settle wait and the shutdown without duplicating the poll logic.
 * Lets REST failures throw - callers decide whether that aborts or escalates.
 * @param {string} message - Broadcast into in-game chat immediately by the server
 * @returns {Promise<boolean>} true when the server was confirmed down in time
 * @private
 */
async function shutdownAndWait(message) {
  // The configured delay gives the server time to finish pending operations.
  await shutdown(config.timing.shutdownDelaySeconds, message);
  return waitFor(serverIsFullyDown, config.timing.stopTimeoutMs, config.timing.pollIntervalMs);
}

/**
 * The full polite stop: save the world, wait out the settle window, then shut
 * down and confirm the process is gone.
 *
 * The save + settle is deliberate and unconditional. NOTHING in the Palworld REST
 * documentation states whether /shutdown saves the world on its way out, so the
 * bot never relies on it: it saves explicitly and then waits saveSettleMs for the
 * write to land on disk before pulling the server out from under it.
 * @param {string} message - Broadcast into in-game chat immediately by the server
 * @returns {Promise<boolean>} true when the server was confirmed down in time
 * @private
 */
async function saveSettleAndShutdown(message) {
  await saveWorld();
  await sleep(config.timing.saveSettleMs);
  return shutdownAndWait(message);
}

/**
 * Executes graceful server shutdown with player checks and world save.
 * Used by the /palstop and /palbounce actions AND directly by the monitor's
 * auto-stop path. Returns a structured result rather than replying to anyone.
 *
 * Refusing while players are online is this function's OWN policy, not a server
 * limitation - the REST shutdown works fine with players connected. doKill is the
 * path that stops the server regardless.
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
    // Save world state before shutdown to prevent data loss, then let the write
    // settle - see saveSettleAndShutdown for why the save is never assumed.
    await saveWorld();
    await sleep(config.timing.saveSettleMs);

    // Second player count check - abort if players connected during the save and
    // its settle window. That window is tens of seconds wide, so this is a real
    // race rather than a formality. The save that already ran is harmless.
    players = await getPlayers();
    if (players.length > 0) {
      return { success: false, message: `Abort: **${players.length}** player(s) just connected.` };
    }

    const serverDown = await shutdownAndWait('Stopping (admin request).');
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
 * and returns the same messages so the Discord command is unchanged. onProgress
 * surfaces the coarse "checking for updates" line from the update-on-start check.
 * @param {{ actor?: string, onProgress?: (message: string) => (void|Promise<void>) }} [options]
 *   actor is used only for the announcement
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 */
export async function doStart({ actor, onProgress } = {}) {
  try {
    return await withLock(async () => {
      const up = await isUp();
      if (up) {
        return { success: true, message: 'Server is already **UP**.', embedTitle: 'Server Status' };
      }

      try {
        // startAndReport owns launch + monitor state + the update-warning suffix.
        const message = await startAndReport('Server started successfully!', onProgress);

        // Announce the successful, explicitly-requested start
        await announceAction(actor, 'started');

        return { success: true, message, embedTitle: 'Server Started' };
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
 * Stops the server unconditionally: politely first, by force if that fails.
 *
 * POLITE FIRST. Unlike gracefulShutdown this never refuses - no player count, no
 * "already down" bail-out - but a clean save + REST shutdown is still tried
 * before anything is killed, because a force kill loses everything since the last
 * autosave. The REST shutdown works with players connected, so the polite path is
 * available even in the case that made this command necessary.
 *
 * A WEDGED SERVER IS STILL FAST. If the REST API does not answer, isUp() is false
 * and the polite path is skipped entirely; if it answers but the shutdown fails or
 * does not take, the failure is logged and escalates rather than throwing. Either
 * way the kill still happens.
 *
 * DELIBERATELY NOT RUN UNDER THE SHARED LOCK: this is the emergency escape hatch
 * and must work even when a wedged operation is still holding the lock. That also
 * lets doScheduledRestart call it from inside the lock it already holds (withLock
 * is not reentrant).
 *
 * announceAction's "actor verb the server" phrasing doesn't fit these lines, so
 * the full sentences are posted directly under the same channel guard.
 * @param {{ actor?: string, message?: string }} [options] - actor names who asked,
 *   for the announcement; message is broadcast into in-game chat by the shutdown
 * @returns {Promise<{success: boolean, message: string, forced: boolean}>} forced
 *   tells callers whether the stop escalated, so they need not parse the message
 */
export async function doKill({ actor, message = 'Server is shutting down.' } = {}) {
  let stoppedCleanly = false;

  if (await isUp()) {
    try {
      stoppedCleanly = await saveSettleAndShutdown(message);
    } catch (e) {
      // An unreachable or wedged REST API must escalate, not throw.
      logger.warn(`Clean stop failed, escalating to a force kill: ${sanitizeErrorMessage(e)}`);
    }
  }

  if (stoppedCleanly) {
    // Notify monitor that server is now down
    await setServerDown();

    if (config.discord.announceChannelId) {
      await announceServerEvent(`🛑 The Palworld server was saved and cleanly stopped by ${actor}.`);
    }

    return { success: true, message: 'Server stopped gracefully (world saved).', forced: false };
  }

  const result = await killServerByName();
  if (!result.killed) {
    // The reason already explains the launcher-misconfiguration case in full.
    return { success: false, message: `Force stop failed: ${result.reason}`, forced: true };
  }

  // Notify monitor that server is now down
  await setServerDown();

  if (config.discord.announceChannelId) {
    await announceServerEvent(`⚠️ The Palworld server was force-killed by ${actor}.`);
  }

  return { success: true, message: `Server process force-killed (${result.image}).`, forced: true };
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
        const message = await startAndReport('Server restarted successfully!', onProgress);

        // Announce the successful, explicitly-requested restart
        await announceAction(actor, 'restarted');

        return { success: true, message, embedTitle: 'Server Restarted' };
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

/**
 * Runs the scheduled auto-restart under the shared lock: save -> settle -> clean
 * shutdown -> force kill if that did not take -> wait -> start. Invoked by the
 * countdown timers armed in autorestart.js, never by a person, so it takes no
 * actor and reports only a summary.
 *
 * Unlike doBounce this MUST complete once it is due, so it stops through doKill,
 * which never refuses over a player count and escalates to a force kill only when
 * the clean stop fails. doKill is deliberately NOT lock-aware, so calling it from
 * inside the lock we already hold is safe (withLock is not reentrant), and reusing
 * it keeps the stop + monitor state + announcement in one place.
 *
 * There is no separate "restarting now" announce: the REST shutdown broadcasts its
 * message into in-game chat immediately, so the restart wording is handed to doKill
 * instead. That avoids a double notification AND avoids telling players a restart
 * is happening on a path that then fails to stop the server.
 *
 * A busy lock returns the standard failure result, which the countdown treats as a
 * failed restart and holds off re-arming until a full interval has passed.
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function doScheduledRestart() {
  try {
    return await withLock(async () => {
      const stopResult = await doKill({ actor: 'the scheduled restart', message: 'Server restarting now!' });
      if (!stopResult.success) {
        // Nothing was stopped - starting now would either be a no-op or race a
        // dying server, so abort and leave the running instance alone.
        return { success: false, message: `Scheduled restart aborted — ${stopResult.message}` };
      }

      await sleep(config.timing.bounceDelayMs);

      try {
        const message = await startAndReport('Scheduled restart completed.');

        await announceServerEvent(
          stopResult.forced
            ? '🔁 Scheduled restart complete — the clean stop did not take, so the server was force-stopped.'
            : '🔁 Scheduled restart complete — the server was gracefully stopped and restarted.'
        );

        return { success: true, message };
      } catch (e) {
        // Server is already down at this point, so name the start failure exactly
        await announceServerEvent('⚠️ Scheduled restart stopped the server but could not start it again. See logs.');
        return { success: false, message: `Scheduled restart failed after stop: \`${sanitizeErrorMessage(e)}\`` };
      }
    });
  } catch (err) {
    // Lock busy - another operation is in progress
    return { success: false, message: sanitizeErrorMessage(err) };
  }
}
