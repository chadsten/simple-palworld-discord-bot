/**
 * Background server monitoring.
 *
 * Split across src/monitor/ - this file is the barrel that preserves the public
 * import path './monitor.js' for every consumer:
 *   - loop.js owns the monitoring loop AND its mutable state (serverState,
 *     consecutiveEmptyChecks, ...); those are co-mutated by the state handlers and
 *     the loop, so they live together to keep each `let` a single-owner binding.
 *   - presence.js owns the Discord presentation half (client handle, status,
 *     announcements) and its own discordClient + lastKnownServerName state.
 */
export { startMonitoring, setServerUp, setServerDown } from './monitor/loop.js';
export { announceServerEvent } from './monitor/presence.js';
