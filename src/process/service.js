import { spawn } from 'node:child_process';
import { sanitizeErrorMessage } from '../utils/security.js';

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
export function startWindowsService(serviceName) {
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
