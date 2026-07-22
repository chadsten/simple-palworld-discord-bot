/**
 * Cross-process single-instance guard
 *
 * Stops a SECOND launch of the same install from running a second bot beside the
 * first - two bots would double every Discord reply and announcement and race
 * the shared server-operation lock across processes.
 *
 * The guard is an OS-level exclusive resource, NOT a PID lock file: a Windows
 * NAMED PIPE bound via node:net. Windows refuses a second bind of the same pipe
 * name (EADDRINUSE), and - crucially - releases the pipe automatically when the
 * holding process dies, even on a hard crash. That makes it inherently
 * stale-free: there is no leftover lock file to reap after a crash. node:net is
 * a core module, so this needs no native dependency and works under pkg.
 *
 * The pipe name is namespaced by the launch folder (getBaseDir), so two copies
 * of the SAME install collide - the double-launch we guard - while two separate
 * installs in different folders keep independent pipes and never block each
 * other.
 *
 * The guard is a convenience, not a security control, so it FAILS OPEN: any pipe
 * error other than "already in use" resolves as acquired (degraded) rather than
 * blocking the user's bot. It never throws; it always resolves.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { getBaseDir } from './utils/paths.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Singleton');

/**
 * Derives the per-install pipe name. Namespaced by a sha1 of the lower-cased
 * launch folder so the SAME install collides while different installs do not;
 * lower-cased because Windows paths are case-insensitive. A short 12-hex-char
 * tag keeps the name readable while staying collision-free in practice.
 * @returns {string} The `\\.\pipe\...` name for this install
 */
function getPipeName() {
  const tag = crypto.createHash('sha1').update(getBaseDir().toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\exos-palworld-bot-${tag}`;
}

/**
 * Acquires the cross-process single-instance lock for this install by binding an
 * exclusive named pipe. The returned handle must be kept alive for the process
 * lifetime - the OS releases the pipe (and the lock) when the process exits.
 *
 * @param {object} [options]
 * @param {number} [options.retryMs=0] - How long to keep retrying while the pipe
 *   is held by another instance. Zero fails fast; a non-zero window (used by the
 *   tray restart handoff) waits for the outgoing instance to exit and release it.
 * @param {number} [options.retryIntervalMs=250] - Delay between retries.
 * @returns {Promise<{acquired: boolean, handle?: (import('node:net').Server|null), degraded?: boolean}>}
 *   `{acquired:true, handle}` when this process holds the lock; `{acquired:false}`
 *   when another instance holds it past the retry window; `{acquired:true,
 *   handle:null, degraded:true}` when the guard failed open on an unexpected error.
 */
export async function acquireSingleInstanceLock({ retryMs = 0, retryIntervalMs = 250 } = {}) {
  const pipeName = getPipeName();
  const deadline = Date.now() + retryMs;

  return new Promise((resolve) => {
    const attempt = () => {
      const server = net.createServer();

      server.once('listening', () => {
        // unref so the guard alone never keeps the event loop alive or blocks a
        // clean exit; the pipe stays bound for the process's lifetime regardless.
        server.unref();
        resolve({ acquired: true, handle: server });
      });

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Another instance holds the pipe. Retry until the window closes, then
          // concede - the caller (main.js) reports "already running" and exits.
          if (Date.now() < deadline) {
            setTimeout(attempt, retryIntervalMs);
          } else {
            resolve({ acquired: false });
          }
          return;
        }
        // Any other error: FAIL OPEN. The guard is a convenience, not a security
        // control, so a weird pipe error must never stop the user's bot starting.
        logger.warn(`Single-instance guard unavailable, starting anyway: ${err.message}`);
        resolve({ acquired: true, handle: null, degraded: true });
      });

      server.listen(pipeName);
    };

    attempt();
  });
}
