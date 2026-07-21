import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isUp } from './palworld.js';
import { validateServiceName, validateStartCommand, validateWorkingDirectory, sanitizeErrorMessage } from './utils/security.js';
import { waitFor } from './utils/async.js';
import { ensureLogDir, logPath, rolloverIfLarge, MAX_LOG_BYTES } from './utils/logfiles.js';
import { createLogger } from './utils/logger.js';
import { isServerProcessRunning } from './servercontrol.js';
import { announceServerEvent } from './monitor.js';
import { runSteamUpdate } from './steamupdate.js';
import config from './config/index.js';

const logger = createLogger('Process');

/**
 * Windows Script Host interpreter, always present at this fixed system path. Used
 * to run the generated hidden-launch VBS so the game server gets no console window.
 */
const WSCRIPT_PATH = 'C:\\Windows\\System32\\wscript.exe';

/**
 * Starts the game server, optionally running a best-effort SteamCMD update first.
 * The onProgress sink (when provided) surfaces the coarse "checking for updates"
 * message; the tray path passes none. updateWarning is a short line the caller
 * appends to its reply when an update check failed but the server was started
 * anyway, and is null when the update was skipped, succeeded, or the server was
 * already running.
 * @param {{ onProgress?: (message: string) => (void|Promise<void>) }} [options]
 * @returns {Promise<{updateWarning: string|null}>}
 */
export async function startServer({ onProgress } = {}) {
  try {
    const already = await isUp();
    if (already) return { updateWarning: null };

    // Best-effort SteamCMD update before launch. The isUp() guard above proves the
    // server isn't answering REST, so it can't hold the install files open - the
    // precondition for SteamCMD to replace them. Never blocks the start.
    const updateWarning = await maybeRunUpdate(onProgress);

    const serviceName = config.server.serviceName;
    const startCmd = config.server.startCommand;

    if (serviceName) {
      // Validate service name before using it
      validateServiceName(serviceName);
      await startWindowsService(serviceName);
    } else if (startCmd) {
      // Validate and parse start command, and the optional working directory,
      // before either reaches the generated launch VBScript.
      const { executable, args } = validateStartCommand(startCmd);
      const workingDir = config.server.startWorkingDirectory
        ? validateWorkingDirectory(config.server.startWorkingDirectory)
        : null;
      await runSecureDetached(executable, args, workingDir);
    } else {
      throw new Error('No SERVICE_NAME or START_CMD configured');
    }

    const ok = await waitFor(async () => await isUp(), config.timing.startTimeoutMs, config.timing.pollIntervalMs);
    if (!ok) throw new Error('Server did not come up in time');
    return { updateWarning };
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    const sanitizedError = new Error(sanitizedMessage);
    sanitizedError.name = error.name;
    throw sanitizedError;
  }
}

/**
 * Runs the best-effort SteamCMD update-on-start before launch, when enabled.
 * Returns a short warning string to append to the caller's reply when the update
 * did NOT succeed, or null when it was skipped or succeeded. Never throws: an
 * update problem must never block the server start.
 *
 * Skipped (returns null) when UPDATE_ON_START is off or STEAMCMD_PATH is unset,
 * and also when a server process is still alive - isUp() probes the REST API,
 * but a hung/zombie server that stopped answering REST can still hold the file
 * locks SteamCMD needs, so we never update while any server process lives.
 * On failure it surfaces loudly in bot.log and the announce channel here, and
 * returns the warning for the Discord reply.
 * @param {(message: string) => (void|Promise<void>)} [onProgress] - Coarse progress sink
 * @returns {Promise<string|null>} Warning text for a failed update, else null
 */
async function maybeRunUpdate(onProgress) {
  if (!config.steam.updateOnStart || !config.steam.steamcmdPath) {
    logger.debug('Update-on-start disabled or STEAMCMD_PATH unset; skipping update');
    return null;
  }

  if (await isServerProcessRunning()) {
    logger.warn('Skipping SteamCMD update: a server process is still alive (REST may be unresponsive)');
    return null;
  }

  const result = await runSteamUpdate({ onProgress });
  if (result.ok) {
    logger.info(result.updated ? 'SteamCMD update applied' : 'Server already up to date');
    return null;
  }

  // Best-effort: start on the current build and surface the failure loudly - here
  // in bot.log and the announce channel; the returned line goes to the reply.
  logger.warn(`SteamCMD update failed: ${result.reason}`);
  await announceServerEvent('⚠️ Server update check failed — starting on the current build. See logs.');
  return '⚠️ Update check failed — starting on the current build. See logs.';
}

/**
 * Starts a Windows service via PowerShell (the SERVICE_NAME launch path).
 *
 * THE PARAMETER NAME MUST NOT BE QUOTED. `Start-Service '-Name' 'Foo'` binds a
 * quoted -Name as a positional value, so PowerShell would try to start services
 * literally named "-Name" and "Foo". Only the value is single-quoted, with any
 * embedded single quote doubled - PowerShell's single-quoted literal escape.
 * The name has already passed validateServiceName, so this quoting is defence in
 * depth rather than the only guard. -ExecutionPolicy is deliberately not passed:
 * it has no effect on a -Command invocation.
 * @param {string} serviceName - Validated Windows service name
 * @returns {Promise<void>} Resolves when the service start succeeds
 */
function startWindowsService(serviceName) {
  return new Promise((resolve, reject) => {
    const command = `Start-Service -Name '${serviceName.replace(/'/g, "''")}'`;

    // Nothing reads stdout, so it is discarded rather than piped into a buffer
    // no one drains; stderr is kept because it carries the failure reason.
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    ps.stderr.on('data', d => (stderr += d.toString()));

    ps.on('error', error => reject(new Error(sanitizeErrorMessage(error))));

    ps.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(sanitizeErrorMessage(stderr || `PowerShell exited with code ${code}`)));
      }
    });
  });
}

/**
 * Launches the game server with NO visible console window.
 *
 * Node ignores `windowsHide` whenever `detached:true` is set (nodejs/node#21825,
 * "working as intended"), so a plain detached spawn always flashes a console. We
 * side-step that by generating a tiny VBScript that uses WMI Win32_Process.Create
 * with Win32_ProcessStartup.ShowWindow=SW_HIDE to start the server truly hidden,
 * and run it via wscript.exe (built into every Windows - no dependency).
 *
 * WMI launches the process independently of Node, so a Node fd can't be inherited
 * for logging. The VBS solves that by launching the server through
 * `cmd /c "... >> palserver.log 2>&1"`, with the redirect performed by the hidden
 * cmd itself so the tray keeps reading the same log. Nothing here needs the
 * launched PID: the server is killed by image name (see servercontrol.js).
 *
 * @param {string} executable - Path to the validated server executable
 * @param {string[]} args - Validated argument list
 * @param {string} cwd - Working directory (optional)
 */
async function runSecureDetached(executable, args = [], cwd) {
  if (cwd && typeof cwd !== 'string') {
    throw new Error('Working directory must be a string');
  }

  ensureLogDir();

  const gameLogPath = logPath('palserver.log');
  // Roll first so a fresh run doesn't append onto an already-huge file.
  rolloverIfLarge(gameLogPath, MAX_LOG_BYTES);

  const vbsPath = logPath('launch-server.vbs');

  // Build the hidden cmd command line and the VBS, then write it under the bot's
  // own logs/ directory before handing it to wscript. This is only as trustworthy
  // as the bot's working directory: if logs/ lives somewhere world-writable, the
  // VBS could be swapped between write and execute (a TOCTOU window). We rely on
  // the bot running from a trusted, non-world-writable location rather than an
  // ACL check here (out of scope for a physical-host-trust tool).
  const commandLine = buildHiddenCommandLine(executable, args, gameLogPath);
  const vbs = buildLaunchVbs(commandLine, cwd);
  fs.writeFileSync(vbsPath, vbs);

  await spawnWscript(vbsPath);
}

/**
 * Builds the `cmd /c` command line that launches the server hidden with its
 * stdout+stderr appended to the game log. Both the executable and the log path
 * are quoted, so the whole inner command is wrapped in an extra quote pair - the
 * documented `cmd /c "..."` rule that lets cmd keep the inner quotes intact.
 * @param {string} executable - Server executable path
 * @param {string[]} args - Operator-supplied arg list, already validated to
 *   reject shell metacharacters, control chars, and double quotes
 * @param {string} logPathAbs - Absolute path of the game log to append to
 * @returns {string} A single command-line string for Win32_Process.Create
 */
export function buildHiddenCommandLine(executable, args, logPathAbs) {
  // Native Windows path form for cmd. Each arg is wrapped in one quote pair;
  // validateCommandArgument already rejected shell metacharacters, control
  // chars, and the double quote that could break out of that quoting, so a
  // single quote pair keeps each arg as one token. This assumes the operator-
  // controlled START_CMD was validated, not that arbitrary input is safe.
  const quotedExe = `"${path.win32.normalize(executable)}"`;
  const quotedArgs = args.map(a => `"${a}"`).join(' ');
  const quotedLog = `"${path.win32.normalize(logPathAbs)}"`;
  const inner = `${quotedExe}${quotedArgs ? ' ' + quotedArgs : ''} >> ${quotedLog} 2>&1`;
  return `cmd.exe /c "${inner}"`;
}

/**
 * Escapes a string for embedding inside a double-quoted VBScript string literal.
 * VBScript escapes a double quote by doubling it; there is no backslash escaping.
 * This only makes the value a safe single-line literal for inputs that carry no
 * control characters - the VBS is line-based (joined by CR/LF), so a raw CR/LF
 * would still start a new script line. Callers therefore validate operator input
 * (START_CMD via validateStartCommand, START_CWD via validateWorkingDirectory)
 * to reject control chars before it reaches here; this is not a general escaper.
 * @param {string} value - Raw string
 * @returns {string} VBScript-safe string (without surrounding quotes)
 */
function vbsEscape(value) {
  return String(value).replace(/"/g, '""');
}

/**
 * Generates the hidden-launch VBScript. It starts the given command through WMI
 * with a hidden window (SW_HIDE) and then exits; the Create() return value is not
 * inspected, because a failed launch is caught anyway - startServer's
 * waitFor(isUp, startTimeoutMs) is the real success gate, and always was.
 * @param {string} commandLine - Full command line to launch (cmd /c "...")
 * @param {string} cwd - Working directory, or falsy for the caller's default
 * @returns {string} VBScript source
 */
export function buildLaunchVbs(commandLine, cwd) {
  // Null tells WMI to use the default working directory; otherwise a quoted path.
  const cwdLiteral = cwd ? `"${vbsEscape(path.win32.normalize(cwd))}"` : 'Null';

  return [
    'Option Explicit',
    'Const SW_HIDE = 0',
    'Dim objWMI, objStartup, objConfig, objProcess, intPID',
    'Set objWMI = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
    'Set objStartup = objWMI.Get("Win32_ProcessStartup")',
    'Set objConfig = objStartup.SpawnInstance_',
    'objConfig.ShowWindow = SW_HIDE',
    'Set objProcess = objWMI.Get("Win32_Process")',
    // Call lets the parenthesised form stand without capturing a return value.
    // intPID is still passed because Create's [out] PID parameter needs a
    // declared variable under Option Explicit; nothing reads it back.
    `Call objProcess.Create("${vbsEscape(commandLine)}", ${cwdLiteral}, objConfig, intPID)`,
    ''
  ].join('\r\n');
}

/**
 * Spawns wscript.exe on the generated VBS. wscript has no window of its own and
 * exits as soon as the VBS finishes launching the server, so it is spawned
 * detached + hidden and unref'd. Resolves once the process is handed off.
 * @param {string} vbsPath - Path to the VBS to execute
 * @returns {Promise<void>} Resolves on successful spawn, rejects on spawn error
 */
function spawnWscript(vbsPath) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(WSCRIPT_PATH, [vbsPath], {
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });

      let settled = false;
      child.on('error', error => {
        if (settled) return;
        settled = true;
        reject(new Error(sanitizeErrorMessage(error)));
      });

      child.unref();

      // wscript is fire-and-forget; once spawned without an immediate error we
      // hand control back and let startServer's isUp() poll confirm the launch.
      if (!settled) {
        settled = true;
        resolve();
      }
    } catch (error) {
      reject(new Error(sanitizeErrorMessage(error)));
    }
  });
}
