/**
 * Self-healing .env
 *
 * On boot, restores config keys the current build knows about but the user's
 * .env is missing. Any key present in the bundled .env.example yet absent from
 * the launch-folder .env is appended verbatim - its explanatory comment block
 * and example default value - so a deleted or never-added key (e.g. a newly
 * shipped ANNOUNCE_CHANNEL_ID) comes back automatically without a manual edit.
 *
 * The operation is append-only and best-effort: existing lines are preserved
 * byte-for-byte, only new content is added at the end, and any failure resolves
 * to a no-op rather than throwing - a heal problem must never stop the bot.
 *
 * This runs BEFORE dotenv has necessarily loaded, so it reads the .env FILE
 * directly (never process.env) and, after appending, also seeds the restored
 * values into process.env so the current boot sees them without a restart.
 */
import fs from 'node:fs';

/** Matches an assignment line and captures the key name (the part before the first `=`). */
const KEY_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=/;

/**
 * Collects the set of key NAMES assigned in a .env file's text. Only the name
 * matters, not the value, so `KEY=` (blank value) counts as present. Comment
 * and blank lines are ignored.
 * @param {string} text - Raw .env file contents
 * @returns {Set<string>} Set of assigned key names
 */
function parseKeyNames(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * Parses .env.example into an ordered list of blocks, one per key. Consecutive
 * comment and blank lines accumulate as a pending block; when an assignment line
 * is reached, the key is associated with (its pending comment lines) + (the
 * verbatim assignment line), and the pending block resets. Section headers that
 * precede a key ride along with that key's block, which is acceptable.
 * @param {string} text - Raw .env.example contents
 * @returns {Array<{key: string, value: string, comments: string[], line: string}>}
 *   Ordered blocks in file order.
 */
function parseExampleBlocks(text) {
  const blocks = [];
  let pending = [];

  for (const line of text.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    if (match) {
      // Value is everything after the first `=`, verbatim (may itself contain `=`).
      const value = line.slice(line.indexOf('=') + 1);
      blocks.push({ key: match[1], value, comments: pending, line });
      pending = [];
    } else {
      // Comment or blank line - part of the next key's pending block.
      pending.push(line);
    }
  }

  return blocks;
}

/**
 * Trims leading and trailing blank lines from a comment block, keeping the inner
 * lines intact, so the appended section stays tidy.
 * @param {string[]} lines - Raw comment/blank lines preceding a key
 * @returns {string[]} Trimmed comment lines
 */
function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/**
 * Restores keys missing from the user's .env using the bundled .env.example as
 * the source of truth. Append-only, idempotent, and never throws.
 * @param {string} envPath - Path to the user's .env file
 * @param {string} examplePath - Path to the bundled .env.example template
 * @returns {{healed: string[], error?: Error}} Names of keys added (empty when
 *   nothing was missing or on failure), plus the error when a read failed.
 */
export function healEnv(envPath, examplePath) {
  let envText;
  let exampleText;
  try {
    envText = fs.readFileSync(envPath, 'utf8');
    exampleText = fs.readFileSync(examplePath, 'utf8');
  } catch (error) {
    return { healed: [], error };
  }

  const present = parseKeyNames(envText);
  const blocks = parseExampleBlocks(exampleText);
  const missing = blocks.filter((block) => !present.has(block.key));

  if (missing.length === 0) return { healed: [] };

  // Match the user file's dominant newline style so the appended block blends in.
  const newline = envText.includes('\r\n') ? '\r\n' : '\n';

  const sections = missing.map((block) => {
    const comments = trimBlankEdges(block.comments);
    return [...comments, block.line].join(newline);
  });

  let appended = envText;
  if (appended.length > 0 && !appended.endsWith('\n')) appended += newline;
  appended +=
    `${newline}# --- Added by self-heal (missing keys restored from .env.example) ---${newline}` +
    sections.join(`${newline}${newline}`) +
    newline;

  fs.writeFileSync(envPath, appended);

  // Seed the restored values so the current boot sees them without a restart.
  // Only fill gaps - never clobber a value already present in process.env.
  for (const block of missing) {
    if (process.env[block.key] === undefined) process.env[block.key] = block.value;
  }

  return { healed: missing.map((block) => block.key) };
}
