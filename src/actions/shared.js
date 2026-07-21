import { saveWorld, shutdown, isUp } from '../palworld.js';
import { startServer } from '../process.js';
import { isServerProcessRunning } from '../servercontrol.js';
import { setServerUp, announceServerEvent } from '../monitor.js';
import { sanitizeErrorMessage } from '../utils/security.js';
import { sleep, waitFor } from '../utils/async.js';
import { withLock } from '../lock.js';
import config from '../config/index.js';

/**
 * How long to wait, after a successful force kill, for the server to actually
 * disappear before trusting the kill. A killed process and its REST listener
 * take a moment to go away, so this polls rather than checking once - but a kill
 * that should be near-instant gets a SHORT budget, not the graceful-shutdown
 * stopTimeoutMs (45s), which is a clean-stop drain window and far too long here.
 */
export const FORCE_KILL_CONFIRM_MS = 10000;

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
export function shouldAnnounce(originChannelId) {
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
export async function announceAction(actor, verb, originChannelId) {
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
export async function withLockResult(fn) {
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
export async function startAndReport(successMessage, onProgress) {
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
export async function serverIsFullyDown() {
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
export async function shutdownAndWait(message) {
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
export async function saveSettleAndShutdown(message) {
  await saveWorld();
  await sleep(config.timing.saveSettleMs);
  return shutdownAndWait(message);
}
