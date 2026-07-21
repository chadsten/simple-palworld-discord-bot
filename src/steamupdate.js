/**
 * SteamCMD update-on-start
 *
 * Runs a SteamCMD app_update for the Palworld dedicated server BEFORE the bot
 * launches it, so /palstart and /palbounce (and the tray Start/Reboot) implicitly
 * update the server. This is best-effort: the caller (process.js startServer)
 * starts the server on the current build regardless of the result and surfaces a
 * failure loudly - so this module NEVER throws and ALWAYS resolves to a structured
 * result. It also must never hang: the bot's shared lock (lock.js) has no deadlock
 * guard, so two independent timeouts forcibly tree-kill SteamCMD and settle.
 *
 * SteamCMD exit codes are unreliable (0 on partial failure, 7/8 on benign
 * conditions), so success is decided by scanning stdout for its completion lines,
 * not by the exit code (see detectSteamUpdateResult).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ensureLogDir, logPath, rolloverIfLarge, MAX_LOG_BYTES } from './utils/logfiles.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { killTree } from './servercontrol.js';
import config from './config/index.js';

const logger = createLogger('SteamUpdate');

/**
 * Log file (inside logs/) that SteamCMD's stdout/stderr is teed to, separate from
 * the bot's own bot.log so a noisy update never drowns the bot's log.
 */
const STEAMCMD_LOG = 'steamcmd.log';

/**
 * Result of a SteamCMD update attempt.
 * @typedef {Object} SteamUpdateResult
 * @property {boolean} ok - True when the server is confirmed on a good build to
 *   start (a real install completed OR it was already up to date).
 * @property {boolean} updated - True only when a download actually completed;
 *   false for an "already up to date" no-op or any failure.
 * @property {string} reason - Human-readable summary for logs and Discord.
 */

/**
 * Decides success from SteamCMD's accumulated output. Exit codes are unreliable,
 * so this is the source of truth: it looks for the two completion phrases SteamCMD
 * prints, case-insensitively and tolerant of the quote style around the app id.
 * Anything else (a network error, a truncated/silent transcript) is a failure.
 * @param {string} output - Combined stdout+stderr captured from SteamCMD
 * @param {number} appId - Steam app id the update was requested for
 * @returns {SteamUpdateResult} The classified result
 */
export function detectSteamUpdateResult(output, appId) {
  const text = String(output || '');
  const idStr = String(appId);

  // "already up to date" - a clean no-op. Checked first so it wins the
  // updated:false classification even when a stray success line also appears.
  if (/already up to date/i.test(text)) {
    return { ok: true, updated: false, reason: 'Server already up to date.' };
  }

  // "Success! App '<id>' fully installed" - a real download completed. Tolerant of
  // the quote style around the id; the id itself must match the app we updated.
  const installed = new RegExp(String.raw`success!\s+app\s+['"]?${idStr}['"]?\s+fully\s+installed`, 'i');
  if (installed.test(text)) {
    return { ok: true, updated: true, reason: 'Server updated to the latest build.' };
  }

  return { ok: false, updated: false, reason: 'No SteamCMD success confirmation in output.' };
}

/**
 * Appends a SteamCMD output chunk to the tee log, normalising the bare carriage
 * returns SteamCMD uses for its in-place progress bar into newlines so the log is
 * readable lines instead of one giant \r-overwritten blob. Best-effort: a write
 * failure is swallowed so logging never disrupts the update.
 * @param {import('node:fs').WriteStream|null} stream - Open log stream, or null
 * @param {string} text - Raw output chunk
 */
function teeToLog(stream, text) {
  if (!stream) return;
  try {
    // Collapse CRLF first, then treat any remaining lone CR as a line break.
    stream.write(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  } catch {}
}

/**
 * Runs a best-effort SteamCMD update for the configured Palworld app and resolves
 * to a {@link SteamUpdateResult}. Never throws and never hangs: a stall timeout
 * (no output for config.steam.stallTimeoutMs) and a wall-clock cap
 * (config.steam.timeoutMs) both tree-kill SteamCMD and settle as a failure.
 *
 * SteamCMD is spawned with an args array and shell:false (so an "(x86)" install
 * dir with spaces needs no quoting) and WITHOUT `validate` (a full validate is
 * slow and unnecessary for a start-time check).
 * @param {{ onProgress?: (message: string) => (void|Promise<void>) }} [options]
 *   onProgress receives ONE coarse "checking for updates" line before the run;
 *   SteamCMD percentages are deliberately NOT streamed (Discord rate limits).
 * @returns {Promise<SteamUpdateResult>} The classified update result
 */
export async function runSteamUpdate({ onProgress } = {}) {
  const steamcmdPath = config.steam.steamcmdPath;
  const appId = config.steam.appId;
  // Empty STEAM_INSTALL_DIR falls back to the server's START_CWD.
  const installDir = config.steam.installDir || config.server.startWorkingDirectory;

  if (!steamcmdPath) {
    return { ok: false, updated: false, reason: 'STEAMCMD_PATH is not configured.' };
  }

  let steamcmdIsFile = false;
  try {
    steamcmdIsFile = fs.existsSync(steamcmdPath) && fs.statSync(steamcmdPath).isFile();
  } catch {
    steamcmdIsFile = false;
  }
  if (!steamcmdIsFile) {
    return { ok: false, updated: false, reason: 'STEAMCMD_PATH does not point to a file.' };
  }

  if (!installDir) {
    return { ok: false, updated: false, reason: 'No install dir configured (set STEAM_INSTALL_DIR or START_CWD).' };
  }

  // ONE coarse pre-run message. Guarded so a Discord reply failure here can never
  // reject and abort the launch - the update is best-effort.
  if (onProgress) {
    try { await onProgress('Checking for server updates...'); } catch {}
  }

  logger.debug(`Starting SteamCMD update (app ${appId})`);

  let steamLogPath = null;
  try {
    ensureLogDir();
    steamLogPath = logPath(STEAMCMD_LOG);
    rolloverIfLarge(steamLogPath, MAX_LOG_BYTES);
  } catch {
    // Log-dir setup is best-effort; if it fails, skip the tee rather than
    // aborting the update (and therefore the server start).
    steamLogPath = null;
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let stallTimer = null;
    let wallTimer = null;

    // Tee stream is best-effort; a logging failure must not abort the update.
    // Only attempt it when log-dir setup above succeeded and gave us a path.
    let logStream = null;
    if (steamLogPath) {
      try {
        logStream = fs.createWriteStream(steamLogPath, { flags: 'a' });
        logStream.on('error', () => { logStream = null; });
        logStream.write(`\n=== SteamCMD update ${new Date().toISOString()} (app ${appId}) ===\n`);
      } catch {
        logStream = null;
      }
    }

    const cleanup = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
      if (logStream) { try { logStream.end(); } catch {} logStream = null; }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    let child;
    try {
      child = spawn(
        steamcmdPath,
        ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(appId), '+quit'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (error) {
      finish({ ok: false, updated: false, reason: `SteamCMD failed to start: ${sanitizeErrorMessage(error)}` });
      return;
    }

    // Tree-kill and settle as a failure. Firing the kill without awaiting it
    // guarantees runSteamUpdate settles now rather than hanging on a wedged child.
    const killAndFail = (reason) => {
      if (settled) return;
      logger.warn(`SteamCMD killed: ${reason}`);
      if (child.pid) void killTree(child.pid);
      finish({ ok: false, updated: false, reason });
    };

    // STALL timer: the real hang detector. SteamCMD emits continuous progress, so
    // no output for stallTimeoutMs means it wedged. Re-armed on every chunk.
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killAndFail(`no SteamCMD output for ${config.steam.stallTimeoutMs}ms (treated as hung)`);
      }, config.steam.stallTimeoutMs);
    };

    // WALL-CLOCK timer: hard cap regardless of output, a backstop for pathological
    // cases where SteamCMD stays chatty but never finishes.
    wallTimer = setTimeout(() => {
      killAndFail(`exceeded the ${config.steam.timeoutMs}ms wall-clock limit`);
    }, config.steam.timeoutMs);

    armStall();

    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      armStall();
      teeToLog(logStream, text);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (error) => {
      // Spawn/runtime error (e.g. ENOENT); report and let the caller start anyway.
      finish({ ok: false, updated: false, reason: `SteamCMD error: ${sanitizeErrorMessage(error)}` });
    });

    child.on('close', (code) => {
      const detected = detectSteamUpdateResult(output, appId);
      if (detected.ok) {
        finish(detected);
        return;
      }
      // Exit code is unreliable, but with no success string it is still the best
      // hint for the logs, so include it in the failure reason.
      const reason = code === 0
        ? 'SteamCMD exited cleanly but printed no success confirmation.'
        : `SteamCMD exited with code ${code} and no success confirmation.`;
      finish({ ok: false, updated: false, reason });
    });
  });
}
