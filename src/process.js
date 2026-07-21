/**
 * Server process launch.
 *
 * Split across src/process/ - this file is the barrel that preserves the public
 * import path './process.js' for every consumer:
 *   - launch.js owns the orchestration (startServer + the update-on-start check).
 *   - service.js owns the Windows-service launch path.
 *   - hiddenLaunch.js owns the WMI/VBScript hidden-launch machinery; its
 *     buildHiddenCommandLine / buildLaunchVbs stay exported for the harnesses.
 */
export { startServer } from './process/launch.js';
export { buildHiddenCommandLine, buildLaunchVbs } from './process/hiddenLaunch.js';
