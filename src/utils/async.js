/**
 * Async timing utilities for delays and polling
 * Shared helpers for pausing execution and waiting on a predicate
 */

/**
 * Promise-based sleep utility for adding delays
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>} Resolves after the specified delay
 */
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Polls a predicate until it returns truthy or the timeout elapses
 * @param {Function} predicate - Async or sync function returning a truthy value when done
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {Promise<boolean>} true if predicate succeeded, false if timeout
 */
export async function waitFor(predicate, timeoutMs, intervalMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await predicate()) return true;
    } catch {}
    await sleep(intervalMs);
  }
  return false;
}
