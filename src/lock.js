/**
 * Shared server-operation lock
 *
 * A SINGLE module-scoped lock guards every server start/stop/bounce so that
 * concurrent triggers - multiple Discord users, the background monitor's
 * auto-stop, and the host-side tray "Commands" - can never interleave and leave
 * the server in a half-restarted state. This lives in its own module so both the
 * shared actions (actions.js) and the background monitor (monitor.js) import the
 * exact same `busy` flag; duplicating it would silently split the lock in two.
 */

// Module-scoped guard shared by every importer of withLock.
let busy = false;

/**
 * Runs fn while holding the single shared lock. Throws immediately if another
 * operation is already in progress, and always releases the lock afterwards.
 * @param {Function} fn - Async operation to run under the lock
 * @returns {Promise<*>} Whatever fn resolves to
 * @throws {Error} 'Another operation is in progress.' if the lock is held
 */
export const withLock = async (fn) => {
  if (busy) throw new Error('Another operation is in progress.');
  busy = true;
  try { return await fn(); } finally { busy = false; }
};
