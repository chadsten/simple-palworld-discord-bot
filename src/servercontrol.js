/**
 * Server process control by image name
 *
 * The Palworld server is launched detached through WMI (see process.js), so Node
 * never owns its process handle. Force-killing it therefore needs an identifier
 * that survives a bot restart. We used to persist a PID, but the PID that
 * Win32_Process.Create returns is the `cmd.exe` wrapper the launch goes through -
 * not the server - so the kill only ever reached the server via taskkill's /T
 * tree walk. The image name is the simpler and more honest identifier: the
 * dedicated server binary has a unique, stable name on disk that the operator's
 * START_CMD points straight at.
 *
 * That name cannot collide with the game client: the server is
 * PalServer-Win64-Shipping.exe and the client is Palworld-Win64-Shipping.exe -
 * different exact-match strings. (Task Manager showing both as "Pal" is a red
 * herring: that is the display name from the binary's version resource, while
 * `taskkill /IM` matches the image name on disk. There is no Pal.exe process.)
 *
 * The one real hazard is an operator pointing START_CMD at the top-level
 * PalServer.exe launcher instead of the real binary. Killing the launcher would
 * leave the actual server alive - still holding the world file and port 8211 -
 * while reporting success, so assertKillableImageName refuses that case loudly
 * rather than letting the kill silently do nothing useful.
 *
 * Every helper here is best-effort and never throws out to callers: a parse or
 * process-query failure degrades to null/false, and the destructive
 * killServerByName() always resolves with a structured result object.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { validateStartCommand, sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import config from './config/index.js';

const logger = createLogger('ServerControl');

/**
 * Shape an image name must have before it may reach a process API. START_CMD is
 * operator-supplied rather than hostile, but the derived name is handed to
 * tasklist/taskkill, so anything exotic is rejected as defence in depth.
 */
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.exe$/i;

/**
 * The top-level launcher that spawns the real server as a separate process.
 * Killing it does NOT stop the server, so it is never a valid kill target.
 */
const LAUNCHER_IMAGE_NAME = 'palserver.exe';

/**
 * Derives the server's Windows image name from the configured START_CMD by
 * reusing the same validator the launch path uses, so the name we kill is parsed
 * exactly like the name we started. Never throws.
 * @returns {string|null} Image name (e.g. 'PalServer-Win64-Shipping.exe'), or
 *   null when START_CMD is unset (the SERVICE_NAME path) or cannot be parsed
 */
export function getServerImageName() {
  const startCommand = config.server.startCommand;
  if (!startCommand) return null;

  try {
    const { executable } = validateStartCommand(startCommand);
    return path.win32.basename(executable);
  } catch (error) {
    logger.warn(`Could not derive server image name from START_CMD: ${sanitizeErrorMessage(error)}`);
    return null;
  }
}

/**
 * Guards an image name before it is used as a kill target. Refuses the
 * PalServer.exe launcher (killing it leaves the real server running) and any
 * name that is not a plain `*.exe` file name.
 * @param {string|null} name - Candidate image name
 * @returns {{ok: boolean, image?: string, reason?: string}} Guard verdict
 */
export function assertKillableImageName(name) {
  if (typeof name !== 'string' || !IMAGE_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `not a usable executable image name: ${name}` };
  }

  if (name.toLowerCase() === LAUNCHER_IMAGE_NAME) {
    return {
      ok: false,
      reason: 'START_CMD points at the PalServer.exe launcher, which only spawns the real server: '
        + 'killing it would leave the server running and holding the world file and port. '
        + 'Point START_CMD at Pal\\Binaries\\Win64\\PalServer-Win64-Shipping.exe instead.'
    };
  }

  return { ok: true, image: name };
}

/**
 * Reports whether any process with the configured server image name exists.
 * Used as the file-lock guard before a SteamCMD update: isUp() only proves the
 * REST API answers, but a hung server that stopped answering REST still holds
 * the install files open. Never throws.
 * @returns {Promise<boolean>} true when at least one matching process is running
 */
export function isServerProcessRunning() {
  const image = getServerImageName();
  if (!image || !IMAGE_NAME_PATTERN.test(image)) return Promise.resolve(false);

  return new Promise((resolve) => {
    try {
      // tasklist lives on PATH; run without a shell with each argument as its own
      // argv entry, so the filter expression needs no quoting of its own.
      const proc = spawn('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));

      proc.on('error', () => resolve(false));

      // tasklist exits 0 and prints "INFO: No tasks are running..." when the
      // filter matches nothing, so the exit code says nothing useful - the
      // presence of the image name in the output is the actual answer.
      proc.on('close', () => resolve(stdout.toLowerCase().includes(image.toLowerCase())));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Force-kills a process TREE via `taskkill /F /T /PID <pid>` - no shell, PID as
 * its own argv entry (injection-safe), /F forces, /T kills the whole tree. Used
 * by the SteamCMD update timeout to kill a wedged steamcmd.exe child the bot
 * spawned itself, where a real Node child PID is available. Never throws: always
 * resolves to a structured result.
 * @param {number} pid - Process ID whose tree should be force-killed
 * @returns {Promise<{killed: boolean, pid?: number, reason?: string}>} Kill result
 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ killed: false, reason: `invalid pid: ${pid}` });
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

/**
 * Force-kills the game server by image name via `taskkill /F /IM <name>`. This is
 * the destructive host-side action behind the tray "Kill Server" item and the
 * escalation path when a graceful REST shutdown does not take.
 *
 * /IM is instance-blind: it kills EVERY process with that image name on the host.
 * That is exactly right for a dedicated server box, but it would also take down a
 * second Palworld server running alongside this one on the same machine.
 *
 * Never throws.
 * @returns {Promise<{killed: boolean, image?: string, reason?: string}>} Kill result
 */
export function killServerByName() {
  const image = getServerImageName();
  if (!image) {
    return Promise.resolve({ killed: false, reason: 'no server image name available from START_CMD' });
  }

  const guard = assertKillableImageName(image);
  if (!guard.ok) {
    return Promise.resolve({ killed: false, reason: guard.reason });
  }

  return new Promise((resolve) => {
    try {
      // Same shape as killTree: no shell, the image name as its own argv entry.
      const proc = spawn('taskkill', ['/F', '/IM', image], {
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
          resolve({ killed: true, image });
        } else if (code === 128) {
          // taskkill's "process not found" code - nothing to kill is not an error.
          resolve({ killed: false, reason: 'no matching server process is running' });
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
