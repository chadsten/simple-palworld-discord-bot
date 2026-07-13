/**
 * Guarded Entry Point
 *
 * This thin wrapper exists so that a double-clicked packaged executable never
 * flashes a terminal window closed before the user can read a startup error.
 *
 * The real application lives in ./index.js. That module validates configuration
 * AT IMPORT TIME (src/config/index.js throws when a required environment
 * variable is missing), so we defer loading it via a dynamic import inside a
 * try/catch. This turns an otherwise fatal import-time crash into a friendly,
 * human-readable message.
 *
 * Anything that escapes the try/catch asynchronously - for example a Discord
 * login rejection surfacing after startup - is routed to the same handler via
 * the process-level unhandledRejection / uncaughtException listeners.
 */

/**
 * Waits for a single keypress when attached to an interactive terminal so a
 * double-clicked window stays open long enough to read the error. In a piped
 * or CI context (non-TTY) it exits immediately to avoid hanging.
 */
function pauseIfInteractive() {
  if (process.stdin.isTTY) {
    process.stderr.write('\nPress any key to exit...');
    // setRawMode is undefined on non-TTY streams - optional chaining keeps this safe.
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
}

/**
 * Prints a clearly formatted, secret-free error block and, when a required
 * environment variable is the cause, an extra hint naming the most common
 * reason: no .env file beside the executable.
 * @param {unknown} err - The fatal error to report
 */
function handleFatal(err) {
  const message = err instanceof Error ? err.message : String(err);

  process.stderr.write('\n========================================\n');
  process.stderr.write('  Palworld Discord Bot failed to start\n');
  process.stderr.write('========================================\n');
  process.stderr.write(`  ${message}\n`);

  // Missing configuration is by far the most common cause, and the fix is
  // non-obvious for a packaged exe, so call it out explicitly.
  if (/Required environment variable/.test(message) || /environment variable/i.test(message)) {
    process.stderr.write('\n  A .env file must sit in the SAME folder you launch the bot from.\n');
    process.stderr.write('  Copy .env.example to .env there and fill in your values.\n');
  }

  process.stderr.write('========================================\n');
  pauseIfInteractive();
}

// Route escaped async failures (e.g. a rejected client.login) to the handler.
process.on('unhandledRejection', handleFatal);
process.on('uncaughtException', handleFatal);

try {
  // Dynamic import defers config loading into this try block so an import-time
  // throw from src/config/index.js is caught rather than crashing the process.
  await import('./index.js');
} catch (err) {
  handleFatal(err);
}
