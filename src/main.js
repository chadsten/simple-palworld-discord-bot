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
 *
 * Before any of that, a first-run bootstrap seeds a starter .env in the launch
 * folder when none exists, so a fresh user gets a template to edit instead of a
 * config-validation crash.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Waits for a single keypress when attached to an interactive terminal so a
 * double-clicked window stays open long enough to read the message. In a piped
 * or CI context (non-TTY) it exits immediately to avoid hanging.
 * @param {number} [exitCode=1] - Process exit code to use once the pause ends.
 */
function pauseIfInteractive(exitCode = 1) {
  if (process.stdin.isTTY) {
    process.stderr.write('\nPress any key to exit...');
    // setRawMode is undefined on non-TTY streams - optional chaining keeps this safe.
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}

/**
 * First-run bootstrap. When no .env exists in the folder the bot is launched
 * from, seeds one (and .env.example) from the bundled template, tells the user
 * what to do next, and exits cleanly without starting the bot - which would
 * otherwise crash on the placeholder config. Returns true when it handled a
 * first run (caller should stop), false when a real .env is already present.
 * @returns {boolean} True if this was a first run and startup must not proceed.
 */
function bootstrapFirstRun() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) return false;

  // The template ships beside the repo root and is bundled into the packaged
  // snapshot via the pkg "assets" list. Resolve to a string path first: under
  // the packaged exe the pkg SEA virtual filesystem patches fs for string paths
  // but NOT for URL objects, so readFileSync(URL) misses the snapshot. From
  // source, fileURLToPath simply yields the real repo path - correct in both.
  const templatePath = fileURLToPath(new URL('../.env.example', import.meta.url));
  let template;
  try {
    template = fs.readFileSync(templatePath, 'utf8');
  } catch {
    process.stderr.write('\n========================================\n');
    process.stderr.write('  Palworld Discord Bot - first run\n');
    process.stderr.write('========================================\n');
    process.stderr.write('  Could not read the bundled .env.example template.\n');
    process.stderr.write('  Create a .env file in this folder from the .env.example\n');
    process.stderr.write('  in the project repository, fill in your values, then rerun.\n');
    process.stderr.write('========================================\n');
    pauseIfInteractive(0);
    return true;
  }

  fs.writeFileSync(envPath, template);

  // Also drop the template alongside as a reference, but never clobber one the
  // user may have already customised.
  const examplePath = path.join(process.cwd(), '.env.example');
  if (!fs.existsSync(examplePath)) fs.writeFileSync(examplePath, template);

  process.stdout.write('\n========================================\n');
  process.stdout.write('  Palworld Discord Bot - first run\n');
  process.stdout.write('========================================\n');
  process.stdout.write('  Created a starter .env (and .env.example) in this folder.\n');
  process.stdout.write('  Open .env, add your Discord token and server info\n');
  process.stdout.write('  (see .env.example for help), then run the bot again.\n');
  process.stdout.write('========================================\n');
  pauseIfInteractive(0);
  return true;
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

// Seed a starter .env on first run. When this handles a first run it schedules
// a clean exit, so we must not fall through to loading the (unconfigured) app.
if (!bootstrapFirstRun()) {
  try {
    // Dynamic import defers config loading into this try block so an import-time
    // throw from src/config/index.js is caught rather than crashing the process.
    await import('./index.js');
  } catch (err) {
    handleFatal(err);
  }
}
