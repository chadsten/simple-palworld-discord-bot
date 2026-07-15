/**
 * Windows system-tray integration
 *
 * Adds a tray icon with host-side controls for the bot: open the bot/game logs,
 * restart the bot process, force-kill the game server, and quit cleanly. The
 * tray starts AFTER the bot successfully boots (main.js) and receives the live
 * Discord client so "Quit" can destroy the connection gracefully.
 *
 * trayicon is a CommonJS module; in this ESM project it is loaded via
 * createRequire. Its helper executable is embedded into the packaged snapshot
 * (pkg "assets") and copied to a temp dir at runtime (useTempDir: 'clean'), so
 * tray.kill() MUST be called before exit or the temp copy leaks.
 *
 * Every action is defensive: a tray failure must never take down the bot, which
 * keeps running headless if the tray cannot start.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { logPath, getLogDir, ensureLogDir } from './utils/logfiles.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { killServerTree } from './servercontrol.js';
import { setServerDown, announceServerEvent } from './monitor.js';
import { doStart, doStop, doBounce } from './actions.js';
import config from './config/index.js';

const require = createRequire(import.meta.url);
const Tray = require('trayicon');

const logger = createLogger('Tray');

/**
 * Opens a filesystem path with the OS default handler. When the target file does
 * not exist yet (e.g. palserver.log before the first /palstart), the logs folder
 * is created if needed and opened instead so the click always lands on the real
 * logs location - passing a clean directory path (not a trailing-separator path
 * to a missing dir) stops Windows explorer from bailing to Documents.
 * Detached + unref'd so the spawned viewer never blocks or outlives-block the bot.
 * @param {string} filePath - Path to open
 */
function openPath(filePath) {
  let target = filePath;
  if (!fs.existsSync(filePath)) {
    // Ensure the logs dir exists so explorer opens it rather than falling back to
    // Documents. Best-effort: a mkdir failure must not crash the tray, so still
    // attempt the open with the (possibly missing) dir path.
    try { ensureLogDir(); } catch {}
    target = getLogDir();
  }
  try {
    // explorer.exe resolves both files (default handler) and folders. shell:false
    // with an args array keeps the path injection-safe.
    spawn('explorer', [target], { detached: true, stdio: 'ignore' }).unref();
    logger.debug(`Opened ${target === filePath ? 'file' : 'logs folder'}: ${target}`);
  } catch (error) {
    logger.warn(`Could not open path: ${sanitizeErrorMessage(error)}`);
  }
}

/**
 * Grace period (ms) between tray.kill() and process.exit so trayicon's in-process
 * helper 'exit' handler can run - that handler performs the useTempDir:'clean'
 * unlink of the temp helper copy, which would otherwise leak on an immediate exit.
 */
const TRAY_TEARDOWN_MS = 300;

/**
 * Tears down the tray helper and exits after a short grace period so the temp
 * helper copy is cleaned up (see TRAY_TEARDOWN_MS).
 * @param {object} tray - The active tray instance
 */
function killTrayAndExit(tray) {
  tray.kill();
  setTimeout(() => process.exit(0), TRAY_TEARDOWN_MS);
}

/**
 * Relaunches a fresh instance of the running bot (the packaged exe, or
 * node + this script from source) detached, then tears down the tray and exits.
 * @param {object} tray - The active tray instance
 */
function restartBot(tray) {
  try {
    logger.info('Restart requested from tray');
    // process.execPath is the exe under pkg, or the node binary from source;
    // process.argv.slice(1) carries the script path (empty for the packaged exe).
    spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd()
    }).unref();
  } catch (error) {
    logger.error(`Restart failed to spawn a new instance: ${sanitizeErrorMessage(error)}`);
    return;
  }

  killTrayAndExit(tray);
}

/**
 * Executes the destructive server kill after the user confirms via the submenu.
 * On success it updates monitor state and posts a best-effort announcement.
 */
async function confirmKillServer() {
  logger.warn('Kill Server confirmed from tray');
  const result = await killServerTree();

  if (result.killed) {
    logger.info(`Server process tree killed (PID ${result.pid})`);
    await setServerDown();
    await announceServerEvent('⚠️ The Palworld server was force-killed from the host.');
  } else {
    logger.warn(`Kill Server did not run: ${result.reason}`);
  }
}

/**
 * Runs a shared server action from the tray as the configured host actor and logs
 * its structured result. Defensive: a failing action is logged, never thrown, so
 * a bad command can never crash the tray. The action already owns the shared lock
 * and its own announcement, so this wrapper only has to report the outcome.
 * @param {string} label - Human label for logging (e.g. 'Start Server')
 * @param {(options: {actor: string}) => Promise<{success: boolean, message: string}>} action - Shared action to run
 */
async function runTrayCommand(label, action) {
  try {
    logger.info(`${label} requested from tray`);
    const result = await action({ actor: config.discord.hostActorName });
    logger.info(result.message);
  } catch (error) {
    logger.error(`${label} failed from tray: ${sanitizeErrorMessage(error)}`);
  }
}

/**
 * Performs the clean tray shutdown: tear down the tray helper, destroy the
 * Discord client, then exit.
 * @param {object} tray - The active tray instance
 * @param {import('discord.js').Client} [client] - Discord client to destroy
 */
async function quit(tray, client) {
  logger.info('Quit requested from tray');
  tray.kill();
  try {
    await client?.destroy?.();
  } catch (error) {
    logger.warn(`Error destroying Discord client on quit: ${sanitizeErrorMessage(error)}`);
  }
  // Delay the exit so trayicon's helper 'exit' handler can clean the temp copy.
  setTimeout(() => process.exit(0), TRAY_TEARDOWN_MS);
}

/**
 * Loads the tray icon buffer from the bundled app.ico (embedded into the pkg
 * snapshot). Resolved as a string path because pkg's virtual filesystem patches
 * fs for string paths but not URL objects.
 * @returns {Buffer|undefined} The icon buffer, or undefined to fall back to the
 *   library's bundled default icon
 */
function loadIcon() {
  try {
    return fs.readFileSync(fileURLToPath(new URL('../assets/app.ico', import.meta.url)));
  } catch (error) {
    logger.warn(`Tray icon unavailable, using default: ${sanitizeErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Creates the system-tray icon and its menu. Must be called after the bot boots.
 * The Discord client is passed through so "Quit" can destroy it cleanly.
 * @param {import('discord.js').Client} [client] - Live Discord client
 * @returns {Promise<object>} The created tray instance
 */
export async function startTray(client) {
  const icon = loadIcon();
  const tray = await Tray.create({ title: "Exo's Palworld Bot", icon, useTempDir: 'clean' });

  // The helper can die abnormally (emits 'error' with "Invalid exit code N").
  // Log it rather than letting an unhandled 'error' event crash the process.
  tray.on('error', (e) => {
    logger.error(`Tray helper error: ${sanitizeErrorMessage(String(e))}`);
  });

  // "Commands" groups the same server controls as the Discord slash commands,
  // run host-side as the configured actor. Each child runs its shared action
  // defensively so a failure only logs and never crashes the tray.
  const commands = tray.item('Commands');
  commands.add(tray.item('Start Server', () => { void runTrayCommand('Start Server', doStart); }));
  commands.add(tray.item('Reboot Server', () => { void runTrayCommand('Reboot Server', doBounce); }));
  commands.add(tray.item('Stop Server', () => { void runTrayCommand('Stop Server', doStop); }));

  // "Kill Server" is destructive, so it lives behind a two-step submenu: the top
  // item is inert and only its "Confirm Kill Server" child actually kills.
  const killConfirm = tray.item('Confirm Kill Server', () => { void confirmKillServer(); });
  const killServer = tray.item('Kill Server');
  killServer.add(killConfirm);

  tray.setMenu(
    tray.item('Open Bot Logs', () => openPath(logPath('bot.log'))),
    tray.item('Open Game Logs', () => openPath(logPath('palserver.log'))),
    tray.separator(),
    commands,
    tray.item('Restart Bot', () => restartBot(tray)),
    killServer,
    tray.separator(),
    tray.item('Quit', () => { void quit(tray, client); })
  );

  logger.info('System tray started');
  return tray;
}
