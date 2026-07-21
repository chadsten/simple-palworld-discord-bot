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
 * The single place that decides whether an action announcement is worth posting.
 *
 * False when no announce channel is configured, and ALSO when the action was
 * triggered from the announce channel itself: the interaction reply has already
 * told that exact audience what happened, so a second identical-audience message
 * is pure noise. Point ANNOUNCE_CHANNEL_ID at a DIFFERENT channel and it still
 * gets its broadcast; host-side callers (tray, monitor) pass no origin at all, so
 * they always announce.
 * @param {string|undefined} originChannelId - Discord channel the command was run
 *   in, or undefined for machine/host-initiated actions with no channel context
 * @returns {boolean} true when the announcement should be posted
 * @private
 */
function shouldAnnounce(originChannelId) {
  if (!config.discord.announceChannelId) return false;
  return originChannelId !== config.discord.announceChannelId;
}

/**
 * Posts a best-effort actor-named line to the announce channel after a successful
 * action. Silently does nothing when shouldAnnounce says the line would be noise;
 * never throws (announceServerEvent is itself best-effort).
 * @param {string|undefined} actor - Display name of who triggered the action
 * @param {string} verb - Past-tense verb, e.g. 'started', 'stopped', 'restarted'
 * @param {string} [originChannelId] - Channel the command was run in - see shouldAnnounce
 */
async function announceAction(actor, verb, originChannelId) {
  if (!shouldAnnounce(originChannelId)) return;
  await announceServerEvent(`${actor} ${verb} the server.`);
}

/**
 * Runs an action body under the single shared lock and turns a BUSY LOCK into the
 * standard failure result. This is the ONE place that owns that error contract;
 * the bodies keep their own try/catch for the failures they want to phrase
 * themselves. doKill deliberately does not go through here - see its comment.
 * @param {() => Promise<{success: boolean, message: string, embedTitle?: string}>} fn - Action body
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 * @private
 */
async function withLockResult(fn) {
  try {
    return await withLock(fn);
  } catch (err) {
    // Lock busy - another operation is in progress
    return { success: false, message: sanitizeErrorMessage(err) };
  }
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
 * @param {{ actor?: string, originChannelId?: string, onProgress?: (message: string) => (void|Promise<void>) }} [options]
 *   actor is used only for the announcement; originChannelId is the channel the
 *   command was run in, which suppresses the announcement per shouldAnnounce
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 */
export async function doStart({ actor, originChannelId, onProgress } = {}) {
  return withLockResult(async () => {
    const up = await isUp();
    if (up) {
      return { success: true, message: 'Server is already **UP**.', embedTitle: 'Server Status' };
    }

    try {
      // startAndReport owns launch + monitor state + the update-warning suffix.
      const message = await startAndReport('Server started successfully!', onProgress);

      // Announce the successful, explicitly-requested start
      await announceAction(actor, 'started', originChannelId);

      return { success: true, message, embedTitle: 'Server Started' };
    } catch (e) {
      // Provide specific error feedback to help with troubleshooting
      const sanitizedMessage = sanitizeErrorMessage(e);
      return { success: false, message: `Start failed: \`${sanitizedMessage}\`` };
    }
  });
}

/**
 * Gracefully stops the server under the shared lock. Returns gracefulShutdown's
 * structured result verbatim so the /palstop message is unchanged.
 * @param {{ actor?: string, originChannelId?: string }} [options] - actor is used
 *   only for the announcement; originChannelId is the channel the command was run
 *   in, which suppresses the announcement per shouldAnnounce
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function doStop({ actor, originChannelId } = {}) {
  return withLockResult(async () => {
    const result = await gracefulShutdown();
    if (result.success) {
      await announceAction(actor, 'stopped', originChannelId);
    }
    return result;
  });
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
 * the full sentences are posted directly - but under the same shouldAnnounce test,
 * so /palkill suppresses its announcement in the invoking channel exactly like the
 * other commands.
 * @param {{ actor?: string, originChannelId?: string, message?: string }} [options]
 *   actor names who asked, for the announcement; originChannelId is the channel the
 *   command was run in, which suppresses the announcement per shouldAnnounce;
 *   message is broadcast into in-game chat by the shutdown
 * @returns {Promise<{success: boolean, message: string, forced: boolean}>} forced
 *   tells callers whether the stop escalated, so they need not parse the message
 */
export async function doKill({ actor, originChannelId, message = 'Server is shutting down.' } = {}) {
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

    if (shouldAnnounce(originChannelId)) {
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

  if (shouldAnnounce(originChannelId)) {
    await announceServerEvent(`⚠️ The Palworld server was force-killed by ${actor}.`);
  }

  return { success: true, message: `Server process force-killed (${result.image}).`, forced: true };
}

/**
 * The stop -> wait -> start pipeline shared by doBounce and doScheduledRestart.
 * They differ only in HOW they stop, how they phrase the outcome and how they
 * announce it, so all of that is passed in and the sequencing lives here once.
 * Assumes the caller already holds the shared lock.
 * @param {object} options
 * @param {() => Promise<{success: boolean, message: string, forced?: boolean}>} options.stop -
 *   Stop strategy; its structured result is passed on to announceSuccess
 * @param {string} options.abortPrefix - Leader for the message returned when the stop refused
 * @param {string} options.failurePrefix - Leader for the message returned when the start failed
 * @param {string} options.successMessage - Base success message, before startAndReport's suffix
 * @param {string} [options.embedTitle] - Embed title to attach to a successful result
 * @param {(stopResult: object) => Promise<void>} options.announceSuccess - Posts the success announcement
 * @param {() => Promise<void>} [options.announceFailure] - Posts the "stopped but could not start" announcement
 * @param {(message: string) => (void|Promise<void>)} [options.onProgress] - Progress sink
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 * @private
 */
async function runRestartPipeline({
  stop, abortPrefix, failurePrefix, successMessage, embedTitle, announceSuccess, announceFailure, onProgress
}) {
  const stopResult = await stop();
  if (!stopResult.success) {
    // Nothing was stopped - starting now would either be a no-op or race a dying
    // server, so abort and leave the running instance alone.
    return { success: false, message: `${abortPrefix}${stopResult.message}` };
  }

  // Stop succeeded - surface the intermediate message and wait before restarting
  if (onProgress) {
    await onProgress(`Server stopped. Restarting in ${Math.round(config.timing.bounceDelayMs / 1000)}s...`);
  }
  await sleep(config.timing.bounceDelayMs);

  try {
    const message = await startAndReport(successMessage, onProgress);

    await announceSuccess(stopResult);

    return embedTitle ? { success: true, message, embedTitle } : { success: true, message };
  } catch (e) {
    // The server is already down at this point, so name the start failure exactly
    if (announceFailure) await announceFailure();
    return { success: false, message: `${failurePrefix}\`${sanitizeErrorMessage(e)}\`` };
  }
}

/**
 * Runs the full stop -> wait -> start sequence under a SINGLE lock so nothing can
 * interleave mid-bounce. Mirrors the /palbounce logic and returns only the FINAL
 * result. The optional onProgress callback receives the intermediate "Restarting
 * in Ns..." message so a caller can surface it (the Discord command edits its
 * reply; the tray logs it) without the action doing any interactive I/O itself.
 * @param {{ actor?: string, originChannelId?: string, onProgress?: (message: string) => (void|Promise<void>) }} [options]
 *   actor is used only for the announcement; originChannelId is the channel the
 *   command was run in, which suppresses the announcement per shouldAnnounce
 * @returns {Promise<{success: boolean, message: string, embedTitle?: string}>}
 */
export async function doBounce({ actor, originChannelId, onProgress } = {}) {
  return withLockResult(() => runRestartPipeline({
    // Reuse the graceful stop path - it handles the "players online" and
    // "already down" cases and returns a structured result
    stop: gracefulShutdown,
    abortPrefix: 'Bounce aborted — ',
    failurePrefix: 'Restart failed after stop: ',
    successMessage: 'Server restarted successfully!',
    embedTitle: 'Server Restarted',
    // Announce the successful, explicitly-requested restart
    announceSuccess: () => announceAction(actor, 'restarted', originChannelId),
    onProgress
  }));
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
 * it keeps the stop + monitor state + announcement in one place. No originChannelId
 * is passed to it, or used here, so a machine-initiated restart ALWAYS announces.
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
  return withLockResult(() => runRestartPipeline({
    stop: () => doKill({ actor: 'the scheduled restart', message: 'Server restarting now!' }),
    abortPrefix: 'Scheduled restart aborted — ',
    failurePrefix: 'Scheduled restart failed after stop: ',
    successMessage: 'Scheduled restart completed.',
    announceSuccess: (stopResult) => announceServerEvent(
      stopResult.forced
        ? '🔁 Scheduled restart complete — the clean stop did not take, so the server was force-stopped.'
        : '🔁 Scheduled restart complete — the server was gracefully stopped and restarted.'
    ),
    announceFailure: () => announceServerEvent('⚠️ Scheduled restart stopped the server but could not start it again. See logs.')
  }));
}
