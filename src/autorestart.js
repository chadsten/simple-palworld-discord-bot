/**
 * Scheduled restart countdown
 *
 * TWO-TIER TIMING, deliberately:
 *
 * 1. COARSE (detection) - the background monitor polls on MONITOR_INTERVAL_MS,
 *    10 minutes by default. That poll is what NOTICES the server has been up
 *    long enough to be inside the restart window, but a 10-minute cadence can
 *    never deliver a warning "5 minutes before" anything, and shortening it just
 *    to serve the countdown would multiply REST traffic all day for one event.
 *
 * 2. PRECISE (delivery) - the first poll that lands inside the window arms a set
 *    of one-shot timers computed from the exact seconds remaining, so the in-game
 *    warnings and the restart itself fire to the second no matter where in the
 *    window that poll happened to land. A countdown armed LATE - against a server
 *    already at or past the interval - is floored to the full warning chain
 *    instead of collapsing (see MIN_COUNTDOWN_SECONDS).
 *
 * This module owns ONLY the scheduling and its timers. The restart itself is
 * injected as performRestart, so no import edge is created toward actions.js or
 * monitor.js - monitor.js -> autorestart.js -> actions.js would close a cycle,
 * since actions.js already imports monitor.js.
 */
import { announce } from './palworld.js';
import { createLogger } from './utils/logger.js';
import { sanitizeErrorMessage } from './utils/security.js';
import config from './config/index.js';

const logger = createLogger('AutoRestart');

/**
 * In-game warning schedule, in minutes before the restart, largest first.
 * Deliberately fixed rather than configurable: it is a player-experience
 * decision, and RESTART_INTERVAL_HOURS' 1-hour floor exists precisely so this
 * schedule always fits comfortably inside a single restart interval.
 */
const WARNING_MINUTES = [30, 20, 10, 5, 3, 2, 1];

/**
 * Seconds remaining at or below which a poll arms the countdown.
 *
 * It MUST exceed the largest warning by a full monitor poll interval. Arming at
 * exactly WARNING_MINUTES[0] * 60 is self-defeating: a poll can only arm at or
 * below that mark, but the 30-minute warning only gets a positive delay ABOVE
 * it, so the largest warning could never fire. Adding one poll interval widens
 * the window to 40 minutes at the 10-minute default, which guarantees some poll
 * lands in the 30-to-40-minute band while the 30-minute mark is still ahead.
 *
 * Arming early is harmless: every delay below is derived from the exact
 * secondsRemaining at arm time, so warnings and the restart still fire to the
 * second no matter how early the window opened.
 */
const ARM_THRESHOLD_SECONDS = WARNING_MINUTES[0] * 60 + config.monitoring.intervalMs / 1000;

/**
 * Shortest countdown that may ever be armed: long enough for the whole warning
 * chain, so players are never bounced without the notice they normally get.
 *
 * Inert during steady-state monitoring. The first poll to land inside the window
 * always lands in the (1800, 2400] band - the previous poll was above
 * ARM_THRESHOLD_SECONDS and polls are exactly one interval apart - so the raw
 * remainder already clears this floor.
 *
 * It engages only when a countdown is armed LATE: the bot was restarted
 * mid-window, auto-restart was just enabled, or a failure cooldown expired
 * against an already-overdue server. Unfloored, those arm a truncated warning
 * chain - or none at all, restarting a populated server on the spot.
 */
const MIN_COUNTDOWN_SECONDS = WARNING_MINUTES[0] * 60;

/**
 * How long a failed restart must be left alone before another is armed: one full
 * restart interval. Without it, a persistently failing restart re-arms on the very
 * next monitor poll - uptime is still past the interval - and grinds out a fresh
 * floored countdown, spamming the whole warning chain into chat, forever.
 */
const FAILURE_COOLDOWN_MS = config.autoRestart.intervalHours * 3600 * 1000;

/** Pending one-shot timer handles - every warning plus the final restart. */
let timers = [];

/** True while a countdown is armed; keeps later polls from arming a second one. */
let armed = false;

/**
 * True while the injected performRestart() is running. The restart stops the
 * server, which reaches cancelRestartCountdown() through the monitor - see there
 * for why that has to be ignored.
 */
let restartInFlight = false;

/** Epoch ms before which no countdown may be armed after a failed restart. */
let cooldownUntilMs = 0;

/**
 * Clears every pending timer and empties the handle list.
 * @private
 */
function clearTimers() {
  for (const handle of timers) clearTimeout(handle);
  timers = [];
}

/**
 * Registers a one-shot timer whose callback can never leak a rejection. An
 * unhandled rejection from a timer is fatal to the bot (main.js exits on it) and
 * there is no caller left to catch it, so the guard lives here rather than at
 * each call site. Handles are unref'd so a pending countdown never by itself
 * keeps the process alive.
 * @param {number} delayMs - Delay before firing
 * @param {() => Promise<void>} run - Callback body
 * @private
 */
function addTimer(delayMs, run) {
  const handle = setTimeout(() => {
    // Promise.resolve().then(run) also traps a SYNCHRONOUS throw from run.
    Promise.resolve()
      .then(run)
      .catch((error) => logger.warn(`Countdown task failed: ${sanitizeErrorMessage(error)}`));
  }, delayMs);

  // Node returns a Timeout with unref(); other hosts return a plain number.
  handle?.unref?.();
  timers.push(handle);
}

/**
 * Opens the post-failure cooldown window (see FAILURE_COOLDOWN_MS). Logged here,
 * once, rather than at each suppressed poll.
 * @private
 */
function startFailureCooldown() {
  cooldownUntilMs = Date.now() + FAILURE_COOLDOWN_MS;
  logger.warn(`Restart countdown suppressed for ${config.autoRestart.intervalHours}h after a failed restart`);
}

/**
 * Arms the restart countdown if the given uptime puts the server inside the
 * warning window. Idempotent per window: once armed, later polls are no-ops
 * until the countdown completes or is cancelled.
 *
 * Warnings whose fire time has already passed are SKIPPED rather than burst into
 * chat late, but the MIN_COUNTDOWN_SECONDS floor keeps every countdown at least
 * as long as the largest warning, so in practice the full chain always plays.
 *
 * A restart that FAILED holds this off for a full interval (FAILURE_COOLDOWN_MS),
 * so a broken restart cannot retry on every poll.
 *
 * @param {number} uptimeSeconds - Server uptime from the Palworld /metrics endpoint
 * @param {() => Promise<{success: boolean, message: string}>} performRestart -
 *   Injected restart action (actions.doScheduledRestart); it owns the shared lock
 * @returns {boolean} true when a countdown was armed by this call
 */
export function armRestartCountdown(uptimeSeconds, performRestart) {
  if (!config.autoRestart.enabled || armed) return false;

  const cooldownRemainingMs = cooldownUntilMs - Date.now();
  if (cooldownRemainingMs > 0) {
    logger.debug(`Restart cooldown active (${Math.round(cooldownRemainingMs / 60000)} minutes remaining)`);
    return false;
  }

  // The window check MUST see the RAW remainder: flooring first would report at
  // least 30 minutes left forever and arm the countdown an interval too early.
  const rawSecondsRemaining = config.autoRestart.intervalHours * 3600 - uptimeSeconds;
  if (rawSecondsRemaining > ARM_THRESHOLD_SECONDS) {
    logger.debug(`Not in restart window yet (${Math.round(rawSecondsRemaining / 60)} minutes remaining)`);
    return false;
  }

  armed = true;

  const secondsRemaining = Math.max(rawSecondsRemaining, MIN_COUNTDOWN_SECONDS);

  const scheduled = [];
  for (const minutes of WARNING_MINUTES) {
    const delaySeconds = secondsRemaining - minutes * 60;
    if (delaySeconds < 0) continue; // genuinely past - skip rather than fire late; 0 fires now
    const unit = minutes === 1 ? 'minute' : 'minutes';
    addTimer(delaySeconds * 1000, () => announce(`Server restarting in ${minutes} ${unit}!`));
    scheduled.push(minutes);
  }

  // An already-overdue server (uptime past the interval, e.g. the feature was
  // enabled mid-session) waits out the same full countdown as any other, so its
  // players get the whole warning chain rather than an instant restart.
  addTimer(secondsRemaining * 1000, async () => {
    // Claim ownership of the countdown state for the whole restart - see
    // cancelRestartCountdown for what would otherwise clear it mid-flight.
    restartInFlight = true;
    try {
      const result = await performRestart();
      if (result?.success) {
        logger.info(`Scheduled restart completed: ${result.message}`);
        cooldownUntilMs = 0;
      } else {
        logger.warn(`Scheduled restart did not run: ${result?.message ?? 'no result returned'}`);
        startFailureCooldown();
      }
    } catch (error) {
      logger.error(`Scheduled restart threw: ${sanitizeErrorMessage(error)}`);
      startFailureCooldown();
    } finally {
      // Release the armed state either way. A successful restart resets uptime,
      // so the next window is a full interval away; a failed one is held off by
      // the cooldown instead of retrying on every poll.
      clearTimers();
      armed = false;
      restartInFlight = false;
    }
  });

  // Floor rather than round, and drop to seconds under a minute: rounding up
  // made a 30-second countdown claim "1 minute(s)" while the timer fired at 30s.
  const clampedSeconds = Math.max(Math.round(secondsRemaining), 0);
  const wholeMinutes = Math.floor(clampedSeconds / 60);
  const eta = wholeMinutes > 0
    ? `${wholeMinutes}m ${clampedSeconds % 60}s`
    : `${clampedSeconds}s`;

  const overdueNote = rawSecondsRemaining < MIN_COUNTDOWN_SECONDS
    ? ' (already due - started a full countdown instead)'
    : '';

  logger.info(
    `Restart countdown armed: restarting in ${eta}${overdueNote}; ` +
    `warnings at ${scheduled.length ? scheduled.join(', ') : 'none'}`
  );
  return true;
}

/**
 * Cancels a pending countdown, clearing every scheduled warning and the restart
 * itself. Called when the server goes down for any reason - a stale timer would
 * otherwise try to restart a stopped server, or fire its restart against a
 * freshly started one. Silent no-op when nothing was armed.
 *
 * IGNORED WHILE A RESTART IS IN FLIGHT: the restart stops the server itself, and
 * that setServerDown() reaches here via the monitor's handleServerDown(). Acting
 * on it would log a bogus "countdown cancelled" line on every SUCCESSFUL restart
 * and clear state the in-flight callback still owns and resets itself.
 * @param {string} reason - Short reason, logged when something was cancelled
 */
export function cancelRestartCountdown(reason) {
  if (restartInFlight) return;
  if (!armed && timers.length === 0) return;

  const pending = timers.length;
  clearTimers();
  armed = false;
  logger.info(`Restart countdown cancelled (${pending} pending timer(s)): ${reason}`);
}
