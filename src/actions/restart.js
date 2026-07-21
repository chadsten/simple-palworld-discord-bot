import { announceServerEvent } from '../monitor.js';
import { sanitizeErrorMessage } from '../utils/security.js';
import { sleep } from '../utils/async.js';
import config from '../config/index.js';
import { withLockResult, startAndReport, announceAction } from './shared.js';
import { gracefulShutdown, doKill } from './stop.js';

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
 * it keeps the stop + monitor state in one place.
 *
 * doKill is called with announce: false so it does NOT post its own Discord
 * announce-channel line: this path posts exactly ONE announce-channel message of
 * its own - the "🔁 Scheduled restart complete" summary below - and doKill's
 * "cleanly stopped"/"force-killed" line would be a second, redundant post.
 *
 * The IN-GAME broadcast is a separate channel and stays: the restart wording is
 * handed to doKill as the shutdown message so the REST /shutdown broadcasts it
 * into in-game chat immediately. There is no separate "restarting now" Discord
 * announce, which also avoids telling players a restart is happening on a path
 * that then fails to stop the server. suppressing doKill's Discord line does not
 * touch that in-game broadcast.
 *
 * A busy lock returns the standard failure result, which the countdown treats as a
 * failed restart and holds off re-arming until a full interval has passed.
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function doScheduledRestart() {
  return withLockResult(() => runRestartPipeline({
    stop: () => doKill({ actor: 'the scheduled restart', message: 'Server restarting now!', announce: false }),
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
