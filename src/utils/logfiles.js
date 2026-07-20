/**
 * Shared log-file utilities
 *
 * Plumbing for writing runtime logs to a `logs/` folder beside the running
 * process (the launch folder resolved by getBaseDir, so the exe and
 * `node src/main.js` both land here). Provides directory setup, path
 * resolution, and size-based rollover. All helpers are best-effort: a logging
 * failure must never crash the bot or the game server it manages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBaseDir } from './paths.js';

/**
 * Maximum size a log file may reach before rollover (5 MB).
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Absolute path to the `logs/` folder beside the running process.
 * @returns {string} Resolved logs directory path
 */
export function getLogDir() {
  return path.join(getBaseDir(), 'logs');
}

/**
 * Ensures the logs directory exists. Idempotent and safe if it already exists.
 */
export function ensureLogDir() {
  fs.mkdirSync(getLogDir(), { recursive: true });
}

/**
 * Resolves a file name to its path inside the logs directory.
 * @param {string} name - Log file name (e.g. 'bot.log')
 * @returns {string} Absolute path to the log file
 */
export function logPath(name) {
  return path.join(getLogDir(), name);
}

/**
 * Rolls a log file over when it reaches the size limit by renaming it to
 * `${filePath}.old` (replacing any prior `.old`). Best-effort: a rollover
 * failure - for example the game process still holding an open write handle on
 * Windows - is swallowed so the caller is never disrupted; the file simply
 * keeps growing until the next check succeeds.
 * @param {string} filePath - Path to the log file to check
 * @param {number} maxBytes - Size threshold in bytes
 */
export function rolloverIfLarge(filePath, maxBytes) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxBytes) {
      fs.renameSync(filePath, `${filePath}.old`);
    }
  } catch {}
}
