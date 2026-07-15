import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isUp } from './palworld.js';
import { validateServiceName, validateStartCommand, sanitizeErrorMessage } from './utils/security.js';
import { waitFor, sleep } from './utils/async.js';
import { ensureLogDir, logPath, rolloverIfLarge, MAX_LOG_BYTES } from './utils/logfiles.js';
import { createLogger } from './utils/logger.js';
import { recordServerPid } from './servercontrol.js';
import config from './config/index.js';

const logger = createLogger('Process');

/**
 * Windows Script Host interpreter, always present at this fixed system path. Used
 * to run the generated hidden-launch VBS so the game server gets no console window.
 */
const WSCRIPT_PATH = 'C:\\Windows\\System32\\wscript.exe';

/**
 * File name (inside logs/) the launch VBS writes the real server PID to, so the
 * bot can read it back and hand it to recordServerPid. Kept separate from the
 * canonical .serverpid file to avoid racing servercontrol's own reads/writes.
 */
const LAUNCH_PID_FILE = '.launchpid';

/**
 * How long to poll for the VBS-written PID before giving up (ms), and how often.
 * WMI Win32_Process.Create returns the PID synchronously inside the VBS, so this
 * is only covering wscript spawn + script execution latency - a few hundred ms.
 */
const PID_WAIT_TIMEOUT_MS = 5000;
const PID_POLL_INTERVAL_MS = 100;

export async function startServer() {
  try {
    const already = await isUp();
    if (already) return { started: false, reason: 'already_running' };

    const serviceName = config.server.serviceName;
    const startCmd = config.server.startCommand;

    if (serviceName) {
      // Validate service name before using it
      validateServiceName(serviceName);
      await runSecurePowerShell('Start-Service', ['-Name', serviceName]);
    } else if (startCmd) {
      // Validate and parse start command
      const { executable, args } = validateStartCommand(startCmd);
      const workingDir = config.server.startWorkingDirectory;
      await runSecureDetached(executable, args, workingDir);
    } else {
      throw new Error('No SERVICE_NAME or START_CMD configured');
    }

    const ok = await waitFor(async () => await isUp(), config.timing.startTimeoutMs, config.timing.pollIntervalMs);
    if (!ok) throw new Error('Server did not come up in time');
    return { started: true };
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    const sanitizedError = new Error(sanitizedMessage);
    sanitizedError.name = error.name;
    throw sanitizedError;
  }
}

/**
 * Secure PowerShell execution using parameterized commands
 * Prevents command injection by using separate command and arguments
 * @param {string} command - PowerShell command (e.g., 'Start-Service')
 * @param {string[]} args - Array of arguments to pass to the command
 */
async function runSecurePowerShell(command, args = []) {
  return new Promise((resolve, reject) => {
    try {
      // Validate command name (whitelist of allowed commands)
      const allowedCommands = ['Start-Service', 'Stop-Service', 'Get-Service'];
      if (!allowedCommands.includes(command)) {
        reject(new Error('PowerShell command not allowed'));
        return;
      }

      // Build the command string with proper escaping
      const escapedArgs = args.map(arg => {
        // Escape single quotes and wrap in single quotes for PowerShell
        const escaped = arg.replace(/'/g, "''");
        return `'${escaped}'`;
      });
      
      const fullCommand = `${command} ${escapedArgs.join(' ')}`;
      
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive', 
        '-ExecutionPolicy', 'Bypass',
        '-Command', fullCommand
      ], { 
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      
      ps.stdout.on('data', d => (stdout += d.toString()));
      ps.stderr.on('data', d => (stderr += d.toString()));
      
      ps.on('close', code => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          const sanitizedError = sanitizeErrorMessage(stderr || `PowerShell exited with code ${code}`);
          reject(new Error(sanitizedError));
        }
      });

      ps.on('error', error => {
        const sanitizedError = sanitizeErrorMessage(error);
        reject(new Error(sanitizedError));
      });

    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error);
      reject(new Error(sanitizedError));
    }
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
 * for logging and Node never sees the real PID. The VBS solves both: it launches
 * the server through `cmd /c "... >> palserver.log 2>&1"` (redirect performed by
 * the hidden cmd itself, keeping the same log the tray reads) and writes the real
 * PID that Create() returns to logs/.launchpid. The bot then polls that file and
 * records the PID via the canonical recordServerPid path, so the tray "Kill
 * Server" (taskkill /F /T /PID) still targets the real server process tree.
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
  const launchPidPath = logPath(LAUNCH_PID_FILE);

  // Stale PID from a previous launch must not be mistaken for this one's.
  try { fs.rmSync(launchPidPath, { force: true }); } catch {}

  // Build the hidden cmd command line and the VBS, then write it to a path the
  // bot controls (logs/) so a user-writable location can't be swapped underneath.
  const commandLine = buildHiddenCommandLine(executable, args, gameLogPath);
  const vbs = buildLaunchVbs(commandLine, cwd, launchPidPath);
  fs.writeFileSync(vbsPath, vbs);

  await spawnWscript(vbsPath);

  // WMI returns the PID synchronously inside the VBS, but wscript runs
  // asynchronously to us; poll briefly for the PID the VBS wrote.
  const pid = await waitForLaunchedPid(launchPidPath);
  if (pid === null) {
    // Launch was still attempted (wscript ran the VBS); we just couldn't confirm
    // the PID, so the tray "Kill Server" may not work for this instance. Surface
    // it as a warning rather than failing - startServer's isUp() poll is the real
    // success gate.
    logger.warn('Could not read launched server PID; tree-kill may be unavailable');
    return;
  }

  // Normalise through the canonical path so the pid file format matches exactly
  // what getTrackedServerPid expects. Best-effort: never fails the launch.
  recordServerPid(pid);
  try { fs.rmSync(launchPidPath, { force: true }); } catch {}
}

/**
 * Builds the `cmd /c` command line that launches the server hidden with its
 * stdout+stderr appended to the game log. Both the executable and the log path
 * are quoted, so the whole inner command is wrapped in an extra quote pair - the
 * documented `cmd /c "..."` rule that lets cmd keep the inner quotes intact.
 * @param {string} executable - Server executable path
 * @param {string[]} args - Argument list (already validated, injection-safe)
 * @param {string} logPathAbs - Absolute path of the game log to append to
 * @returns {string} A single command-line string for Win32_Process.Create
 */
export function buildHiddenCommandLine(executable, args, logPathAbs) {
  // Native Windows path form for cmd. args were validated to contain no shell
  // metacharacters, so quoting each is sufficient to keep them as single tokens.
  const quotedExe = `"${path.win32.normalize(executable)}"`;
  const quotedArgs = args.map(a => `"${a}"`).join(' ');
  const quotedLog = `"${path.win32.normalize(logPathAbs)}"`;
  const inner = `${quotedExe}${quotedArgs ? ' ' + quotedArgs : ''} >> ${quotedLog} 2>&1`;
  return `cmd.exe /c "${inner}"`;
}

/**
 * Escapes a string for embedding inside a double-quoted VBScript string literal.
 * VBScript escapes a double quote by doubling it; there is no backslash escaping.
 * @param {string} value - Raw string
 * @returns {string} VBScript-safe string (without surrounding quotes)
 */
function vbsEscape(value) {
  return String(value).replace(/"/g, '""');
}

/**
 * Generates the hidden-launch VBScript. It starts the given command through WMI
 * with a hidden window (SW_HIDE) and writes the created process PID to pidPath.
 * @param {string} commandLine - Full command line to launch (cmd /c "...")
 * @param {string} cwd - Working directory, or falsy for the caller's default
 * @param {string} pidPath - Absolute path the PID is written to on success
 * @returns {string} VBScript source
 */
export function buildLaunchVbs(commandLine, cwd, pidPath) {
  // Null tells WMI to use the default working directory; otherwise a quoted path.
  const cwdLiteral = cwd ? `"${vbsEscape(path.win32.normalize(cwd))}"` : 'Null';

  return [
    'Option Explicit',
    'Const SW_HIDE = 0',
    'Dim objWMI, objStartup, objConfig, objProcess, intPID, errReturn',
    'Set objWMI = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
    'Set objStartup = objWMI.Get("Win32_ProcessStartup")',
    'Set objConfig = objStartup.SpawnInstance_',
    'objConfig.ShowWindow = SW_HIDE',
    'Set objProcess = objWMI.Get("Win32_Process")',
    `errReturn = objProcess.Create("${vbsEscape(commandLine)}", ${cwdLiteral}, objConfig, intPID)`,
    'If errReturn = 0 Then',
    '  Dim fso, f',
    '  Set fso = CreateObject("Scripting.FileSystemObject")',
    `  Set f = fso.CreateTextFile("${vbsEscape(pidPath)}", True)`,
    '  f.Write intPID',
    '  f.Close',
    'End If',
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
      // hand control back and let the PID poll confirm the real launch.
      if (!settled) {
        settled = true;
        resolve();
      }
    } catch (error) {
      reject(new Error(sanitizeErrorMessage(error)));
    }
  });
}

/**
 * Polls the launch PID file the VBS writes, returning the parsed PID once present
 * or null if it never appears within the timeout. Never throws.
 * @param {string} pidPath - Path the VBS writes the PID to
 * @returns {Promise<number|null>} The launched PID, or null on timeout
 */
async function waitForLaunchedPid(pidPath) {
  const until = Date.now() + PID_WAIT_TIMEOUT_MS;
  while (Date.now() < until) {
    try {
      const raw = fs.readFileSync(pidPath, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await sleep(PID_POLL_INTERVAL_MS);
  }
  return null;
}
