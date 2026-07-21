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
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { healEnv } from './env-heal.js';
import { createLogger } from './utils/logger.js';
import { getBaseDir } from './utils/paths.js';

/**
 * Pops a native Windows message box so a windowless (GUI-subsystem) exe can
 * surface a startup problem the user would otherwise never see - under the
 * packaged exe stdout/stderr are a black hole. Shelled out via PowerShell to
 * avoid a native dependency; blocking, so the launch path waits for the click.
 * Best-effort: a dialog failure must never derail the exit path.
 *
 * NOTHING IS INTERPOLATED INTO THE SCRIPT. The body text comes from arbitrary
 * error messages (handleFatal is wired to unhandledRejection), and PowerShell's
 * double-quoted strings honour no backslash escaping while still expanding
 * $(...) and $var - so any JS-side quoting is the wrong escaper. Both strings are
 * handed over as environment variables and referenced as bare $env: expressions
 * in expression position, which leaves no quoting problem to get wrong.
 * @param {string} title - Message box caption
 * @param {string} text - Message box body text
 */
function showDialog(title, text) {
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '[System.Windows.Forms.MessageBox]::Show($env:PALBOT_DIALOG_TEXT, $env:PALBOT_DIALOG_TITLE) | Out-Null'
    ], {
      windowsHide: true,
      env: { ...process.env, PALBOT_DIALOG_TEXT: text, PALBOT_DIALOG_TITLE: title }
    });
  } catch { /* dialog is best-effort; never let it crash the exit path */ }
}

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
  const envPath = path.join(getBaseDir(), '.env');
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
  const examplePath = path.join(getBaseDir(), '.env.example');
  if (!fs.existsSync(examplePath)) fs.writeFileSync(examplePath, template);

  process.stdout.write('\n========================================\n');
  process.stdout.write('  Palworld Discord Bot - first run\n');
  process.stdout.write('========================================\n');
  process.stdout.write('  Created a starter .env (and .env.example) in this folder.\n');
  process.stdout.write('  Open .env, add your Discord token and server info\n');
  process.stdout.write('  (see .env.example for help), then run the bot again.\n');
  process.stdout.write('========================================\n');

  // When there is no console (windowless exe) the message above is invisible, so
  // surface it as a native dialog. From a terminal (TTY) the text above suffices.
  if (!process.stdout.isTTY) {
    showDialog(
      'Palworld Discord Bot - first run',
      'Created a starter .env in this folder. Open it, add your Discord token and server info, then run the bot again.'
    );
  }

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

  const isEnvError =
    /Required environment variable/.test(message) || /environment variable/i.test(message);

  process.stderr.write('\n========================================\n');
  process.stderr.write('  Palworld Discord Bot failed to start\n');
  process.stderr.write('========================================\n');
  process.stderr.write(`  ${message}\n`);

  // Missing configuration is by far the most common cause, and the fix is
  // non-obvious for a packaged exe, so call it out explicitly.
  if (isEnvError) {
    process.stderr.write('\n  A .env file must sit in the SAME folder you launch the bot from.\n');
    process.stderr.write('  Copy .env.example to .env there and fill in your values.\n');
  }

  process.stderr.write('========================================\n');

  // Under the windowless exe the stderr block above is invisible, so surface the
  // same human-readable text as a native dialog before exiting. spawnSync blocks
  // until the user clicks OK, so it must run before pauseIfInteractive()'s exit.
  if (!process.stdout.isTTY) {
    const dialogText = isEnvError
      ? `${message}\n\nA .env file must sit in the SAME folder you launch the bot from. ` +
        'Copy .env.example to .env there and fill in your values.'
      : message;
    showDialog('Palworld Discord Bot - failed to start', dialogText);
  }

  pauseIfInteractive();
}

// Route escaped async failures (e.g. a rejected client.login) to the handler.
process.on('unhandledRejection', handleFatal);
process.on('uncaughtException', handleFatal);

// Seed a starter .env on first run. When this handles a first run it schedules
// a clean exit, so we must not fall through to loading the (unconfigured) app.
if (!bootstrapFirstRun()) {
  // A real .env exists - restore any keys this build knows about that the user's
  // .env is missing, appending them (with comments and example defaults) from the
  // bundled template. Best-effort: a heal failure must never block boot. Runs
  // before the dotenv load below so it picks up the restored values.
  try {
    const { healed } = healEnv(
      path.join(getBaseDir(), '.env'),
      fileURLToPath(new URL('../.env.example', import.meta.url))
    );
    if (healed.length > 0) {
      createLogger('EnvHeal').info(
        `Added ${healed.length} missing key(s) to .env from .env.example: ${healed.join(', ')}`
      );
    }
  } catch { /* self-heal is best-effort; never let it block startup */ }

  // Load the .env from the launch folder explicitly, BEFORE the dynamic import of
  // ./index.js below pulls in config/index.js and validates the environment. The
  // default dotenv path is process.cwd() - the wrong folder when the bot is
  // started by Task Scheduler or a shortcut with no "Start in" - so config must
  // not be allowed to load until this explicit, base-dir load has run. Nothing
  // main.js imports statically pulls in config/index.js, which keeps that order.
  dotenv.config({ path: path.join(getBaseDir(), '.env') });

  try {
    // Dynamic import defers config loading into this try block so an import-time
    // throw from src/config/index.js is caught rather than crashing the process.
    const { client } = await import('./index.js');

    // Start the system tray only after the bot has booted, and never let a tray
    // failure take the bot down - it keeps running headless if the tray can't
    // start. The tray receives the live client so "Quit" can destroy it cleanly.
    try {
      const { startTray } = await import('./tray.js');
      await startTray(client);
    } catch (trayErr) {
      // handleFatal would exit the process; the tray is non-essential, so just log.
      process.stderr.write(`\n  System tray unavailable: ${trayErr instanceof Error ? trayErr.message : String(trayErr)}\n`);
    }
  } catch (err) {
    handleFatal(err);
  }
}
