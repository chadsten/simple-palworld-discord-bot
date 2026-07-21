import { getPlayers, saveWorld, isUp } from '../palworld.js';
import { killServerByName } from '../servercontrol.js';
import { setServerDown, announceServerEvent } from '../monitor.js';
import { sanitizeErrorMessage } from '../utils/security.js';
import { createLogger } from '../utils/logger.js';
import { sleep, waitFor } from '../utils/async.js';
import config from '../config/index.js';
import {
  FORCE_KILL_CONFIRM_MS,
  shouldAnnounce,
  announceAction,
  withLockResult,
  serverIsFullyDown,
  shutdownAndWait,
  saveSettleAndShutdown
} from './shared.js';

const logger = createLogger('Actions');

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
 *
 * announce lets a caller that posts its OWN announce-channel summary opt out of
 * these lines entirely: doScheduledRestart wraps doKill purely as its stop step
 * and prints its own "🔁 Scheduled restart complete" line, so without this it
 * would announce twice. It is distinct from originChannelId, which means "which
 * channel the command came from" - overloading that to silence a caller would be
 * a lie.
 * @param {{ actor?: string, originChannelId?: string, message?: string, announce?: boolean }} [options]
 *   actor names who asked, for the announcement; originChannelId is the channel the
 *   command was run in, which suppresses the announcement per shouldAnnounce;
 *   message is broadcast into in-game chat by the shutdown; announce defaults to
 *   true and, when false, suppresses doKill's own announce-channel line so a
 *   wrapping caller can post a single summary of its own
 * @returns {Promise<{success: boolean, message: string, forced: boolean}>} forced
 *   tells callers whether the stop escalated, so they need not parse the message. A
 *   server already down on entry (or one that died in the gap just before the force
 *   kill) is a success with forced:false and posts no announcement, since this call
 *   stopped nothing
 */
export async function doKill({ actor, originChannelId, message = 'Server is shutting down.', announce = true } = {}) {
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

    if (announce && shouldAnnounce(originChannelId)) {
      await announceServerEvent(`🛑 The Palworld server was saved and cleanly stopped by ${actor}.`);
    }

    return { success: true, message: 'Server stopped gracefully (world saved).', forced: false };
  }

  const result = await killServerByName();
  if (!result.killed) {
    // killServerByName reports nothing killed in two genuinely-DOWN states as well
    // as in the real failure: the server was already down when doKill ran (isUp()
    // was false, the polite block was skipped, stoppedCleanly stayed false, and
    // taskkill then found no process), or a clean shutdown finished in the gap after
    // the stopTimeoutMs window but before taskkill ran. Re-confirm actual state
    // before calling it a failure. A SINGLE serverIsFullyDown() check suffices, not
    // a waitFor poll: killServerByName already proved no process exists, so there is
    // nothing to wait to disappear - the only open question is whether REST is also
    // silent, which one check answers.
    if (await serverIsFullyDown()) {
      // Genuinely down (already-down, or died in the gap): the goal is already met,
      // so this is a success, not a failure. Post NO announcement - THIS call
      // stopped nothing, and a "force-killed"/"cleanly stopped by ${actor}" line
      // would be a lie.
      await setServerDown();
      return { success: true, message: 'Server is already down.', forced: false };
    }
    // The server is still responding, so the derived image name never matched a real
    // process - the launcher-misconfiguration failure this message was written for.
    // The reason already explains that case in full.
    return { success: false, message: `Force stop failed: ${result.reason}`, forced: true };
  }

  // taskkill exiting 0 only proves it killed the process with the DERIVED image
  // name - it cannot prove that name was the real server. This backstop is
  // name-independent because serverIsFullyDown also tests isUp(): a still-alive
  // server keeps answering REST and gives away the lie even after a process with
  // the derived name is gone. Poll briefly - the process and its REST listener
  // take a moment to disappear.
  const confirmedDown = await waitFor(serverIsFullyDown, FORCE_KILL_CONFIRM_MS, config.timing.pollIntervalMs);
  if (!confirmedDown) {
    return {
      success: false,
      message: 'Force kill issued but the server is still responding - it may be running under a different image name.',
      forced: true
    };
  }

  // Notify monitor that server is now down
  await setServerDown();

  if (announce && shouldAnnounce(originChannelId)) {
    await announceServerEvent(`⚠️ The Palworld server was force-killed by ${actor}.`);
  }

  return { success: true, message: `Server process force-killed (${result.image}).`, forced: true };
}
