/**
 * Launch-folder resolution
 *
 * Everything the operator owns - .env, .env.example, logs/ - lives beside the
 * thing they launched. `process.cwd()` is only the same folder when the bot is
 * started FROM it; Task Scheduler and bare shortcuts leave the working directory
 * at C:\Windows\System32, which would send the config lookup and the log writes
 * somewhere the user will never look.
 *
 * Under the packaged executable the exe's own folder is the launch folder, so we
 * derive it from process.execPath. From source `node src/main.js` there is no
 * meaningful "install folder", so process.cwd() stays correct and unchanged.
 */
import path from 'node:path';

/**
 * Whether this process is a packaged binary rather than plain `node script.js`.
 *
 * The build is @yao-pkg/pkg with `sea: true`, whose bootstrap defines
 * `process.pkg` (prelude/sea-bootstrap.bundle.js -> setupProcessPkg). Because it
 * is also a genuine Node SEA, node:sea's isSea() is checked as well so the
 * answer stays correct if a future build drops the pkg compatibility object.
 * `process.getBuiltinModule` (Node 22.3+) keeps this a synchronous check and is
 * simply absent on older runtimes, where only the source path is possible.
 * @returns {boolean} True when running from a packaged executable
 */
function isPackaged() {
  if (process.pkg) return true;

  try {
    return process.getBuiltinModule?.('node:sea')?.isSea() === true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the folder the bot was launched from - the executable's
 * folder when packaged, otherwise the current working directory.
 * @returns {string} Resolved launch folder path
 */
export function getBaseDir() {
  return isPackaged() ? path.dirname(process.execPath) : process.cwd();
}
