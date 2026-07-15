/**
 * Server process control and PID tracking
 *
 * The Palworld server is launched detached and unref'd (see process.js), and
 * both the launcher and the real server can surface as "Pal.exe", so killing by
 * name is unsafe. Instead we persist the spawned PID to logs/.serverpid and use
 * it to force-kill the whole process TREE on demand. The pid file survives a bot
 * restart, so a tray "Kill Server" still works after the bot process is bounced.
 *
 * Every helper here is best-effort and never throws out to callers: a failure to
 * persist, read, or delete the pid file must not disrupt server launch, and the
 * destructive killServerTree() always resolves with a structured result object.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ensureLogDir, logPath } from './utils/logfiles.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('ServerControl');

/**
 * Name of the file that stores the tracked server PID, inside the logs/ folder.
 */
const PID_FILE = '.serverpid';

/**
 * Persists the spawned server PID to logs/.serverpid as plain text.
 * Best-effort: a failure to write must never fail the server launch.
 * @param {number} pid - Process ID of the freshly spawned server
 */
export function recordServerPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn(`Refusing to record invalid server PID: ${pid}`);
    return;
  }

  try {
    ensureLogDir();
    fs.writeFileSync(logPath(PID_FILE), String(pid));
    logger.debug(`Recorded server PID ${pid}`);
  } catch (error) {
    logger.warn(`Could not persist server PID: ${sanitizeErrorMessage(error)}`);
  }
}

/**
 * Reads the tracked server PID from logs/.serverpid.
 * @returns {number|null} The integer PID, or null when missing/invalid
 */
export function getTrackedServerPid() {
  try {
    const raw = fs.readFileSync(logPath(PID_FILE), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Liveness probe for a PID. On Windows `process.kill(pid, 0)` sends no signal but
 * throws when the process is gone (ESRCH) and succeeds when it is alive; EPERM
 * means the process exists but is owned by someone else, so it counts as alive.
 * @param {number} pid - Process ID to probe
 * @returns {boolean} true if the process is currently running
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Deletes the tracked PID file. Best-effort; a missing file is not an error.
 */
export function clearTrackedServerPid() {
  try {
    fs.rmSync(logPath(PID_FILE), { force: true });
  } catch (error) {
    logger.debug(`Could not clear server PID file: ${sanitizeErrorMessage(error)}`);
  }
}

/**
 * Force-kills the tracked server process TREE via `taskkill /F /T /PID <pid>`.
 * This is the destructive host-side action behind the tray "Kill Server" item.
 * It resolves the target PID from the pid file, verifies it is still alive, then
 * spawns taskkill (no shell, args array - injection-safe) and awaits its exit.
 * Never throws: always resolves to a result object describing the outcome.
 * @returns {Promise<{killed: boolean, pid?: number, reason?: string}>} Kill result
 */
export async function killServerTree() {
  const pid = getTrackedServerPid();
  if (pid === null || !isPidAlive(pid)) {
    return { killed: false, reason: 'no tracked server process is running' };
  }

  return new Promise((resolve) => {
    try {
      // taskkill lives on PATH; run without a shell and pass the PID as its own
      // argv entry so there is no injection surface. /F forces, /T kills the tree.
      const proc = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('error', (error) => {
        resolve({ killed: false, reason: sanitizeErrorMessage(error) });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          clearTrackedServerPid();
          resolve({ killed: true, pid });
        } else {
          const reason = sanitizeErrorMessage(stderr || `taskkill exited with code ${code}`);
          resolve({ killed: false, reason });
        }
      });
    } catch (error) {
      resolve({ killed: false, reason: sanitizeErrorMessage(error) });
    }
  });
}
