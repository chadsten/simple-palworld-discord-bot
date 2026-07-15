import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { isUp } from './palworld.js';
import { validateServiceName, validateStartCommand, sanitizeErrorMessage } from './utils/security.js';
import { waitFor } from './utils/async.js';
import { ensureLogDir, logPath, rolloverIfLarge, MAX_LOG_BYTES } from './utils/logfiles.js';
import { createLogger } from './utils/logger.js';
import { recordServerPid } from './servercontrol.js';
import config from './config/index.js';

const logger = createLogger('Process');

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
 * Secure detached process execution using parameterized commands
 * Prevents command injection by using array arguments instead of shell
 * @param {string} executable - Path to executable
 * @param {string[]} args - Array of arguments
 * @param {string} cwd - Working directory (optional)
 */
async function runSecureDetached(executable, args = [], cwd) {
  return new Promise((resolve, reject) => {
    try {
      // Additional validation of working directory if provided
      if (cwd && typeof cwd !== 'string') {
        reject(new Error('Working directory must be a string'));
        return;
      }

      // Redirect the game server's stdout+stderr to logs/palserver.log so its
      // output is captured rather than discarded (Palworld writes no log itself).
      // The redirect uses a raw file descriptor - NOT a JS pipe - because the
      // child is detached and unref'd: the OS owns the write end via the
      // inherited fd, so output keeps flowing after the parent goes away.
      // If opening the log fails, fall back to the original 'ignore' behaviour
      // so the server launch never fails just because logging couldn't start.
      let out = null;
      try {
        ensureLogDir();
        const gameLogPath = logPath('palserver.log');
        // Roll first so a fresh run doesn't append onto an already-huge file.
        rolloverIfLarge(gameLogPath, MAX_LOG_BYTES);
        out = fs.openSync(gameLogPath, 'a');
      } catch (error) {
        out = null;
        logger.warn(`Game output logging disabled: ${sanitizeErrorMessage(error)}`);
      }

      // Spawn process without shell to prevent injection
      const child = spawn(executable, args, {
        cwd: cwd || undefined,
        shell: false, // Critical: no shell to prevent injection
        detached: true,
        stdio: out === null ? 'ignore' : ['ignore', out, out],
        windowsHide: true
      });

      child.on('error', error => {
        const sanitizedError = sanitizeErrorMessage(error);
        reject(new Error(sanitizedError));
      });

      // Track the spawned PID so the tray "Kill Server" action can force-kill the
      // whole process tree later - name-based killing is unsafe because launcher
      // and server both surface as "Pal.exe". Best-effort: never fail the launch.
      recordServerPid(child.pid);

      // For detached processes, we resolve immediately after spawn
      child.unref();

      // The child inherited its own copy of the fd, so close the parent's copy
      // to avoid leaking the handle; the detached child keeps writing via its
      // inherited handle. Best-effort - a failed close must not break launch.
      if (out !== null) {
        try { fs.closeSync(out); } catch {}
      }

      resolve();

    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(error);
      reject(new Error(sanitizedError));
    }
  });
}
