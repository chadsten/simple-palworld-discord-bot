/**
 * Interaction-free server actions
 *
 * These functions own the start/stop/bounce orchestration so it can be shared by
 * BOTH the Discord slash commands (the command modules in src/commands/) and the host-side tray
 * "Commands" submenu (tray.js) with zero duplication. They take no Discord interaction and
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
 *
 * This module is split across src/actions/ - this file is the barrel that
 * preserves the public import path './actions.js' for every consumer.
 */
export { gracefulShutdown, doStop, doKill } from './actions/stop.js';
export { doStart } from './actions/start.js';
export { doBounce, doScheduledRestart } from './actions/restart.js';
