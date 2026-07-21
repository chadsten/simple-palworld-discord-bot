/**
 * FPS sample log
 *
 * One CSV row per monitor poll - timestamp, uptime, FPS and player count taken
 * from the SAME /metrics sample - scoped to the server's CURRENT uptime window.
 * That scoping is the point: the question this log answers is whether the frame
 * rate degrades with player count (normal load) or with uptime at a flat player
 * count (the memory-leak signature), and mixing samples from several server
 * lifetimes into one file would destroy the correlation.
 *
 * The file lives beside the running process in logs/ like every other log, so the
 * operator can copy it out and open it in a spreadsheet. Every write is
 * best-effort: this is diagnostics, and a logging failure must never disturb the
 * monitor that produces the samples.
 *
 * Deliberately depends on nothing but the log-file plumbing - no config, no
 * monitor, no actions - so it can be imported from the monitor without closing an
 * import cycle.
 */
import fs from 'node:fs';
import { ensureLogDir, logPath } from './utils/logfiles.js';
import { createLogger } from './utils/logger.js';
import { sanitizeErrorMessage } from './utils/security.js';

const logger = createLogger('PerfLog');

/** Sample log file name, resolved inside the launch folder's logs/ directory. */
const FILE_NAME = 'fps.csv';

/** CSV header, rewritten whenever the file is (re)created. */
const HEADER = 'timestamp,uptime,fps,players';

/** Seconds in the comparison windows used by summarize(). */
const HOUR_SECONDS = 3600;

/**
 * Minimum span before the first-hour/recent-hour comparison is meaningful: with
 * less than two hours of samples the two one-hour windows overlap and would be
 * comparing largely the same rows against themselves.
 */
const MIN_COMPARISON_SPAN_SECONDS = 2 * HOUR_SECONDS;

/**
 * Parses a CSV field as a number, treating blank as invalid. Number('') is 0,
 * which would silently turn a torn line into a legitimate-looking zero row.
 * @param {string} value - Raw CSV field
 * @returns {number} Parsed number, or NaN when blank or unparseable
 * @private
 */
function toNumber(value) {
  const trimmed = value.trim();
  return trimmed.length ? Number(trimmed) : NaN;
}

/**
 * Parses one CSV line into a sample record. Rejects the header, short lines from
 * an interrupted write, and any row whose numeric fields aren't finite.
 * @param {string} line - Raw CSV line
 * @returns {{timestamp: string, uptime: number, fps: number, players: number}|null}
 *   Parsed sample, or null when the line isn't a complete data row
 * @private
 */
function parseRow(line) {
  const parts = line.split(',');
  if (parts.length !== 4) return null;

  const timestamp = parts[0].trim();
  const uptime = toNumber(parts[1]);
  const fps = toNumber(parts[2]);
  const players = toNumber(parts[3]);

  if (!timestamp || !Number.isFinite(uptime) || !Number.isFinite(fps) || !Number.isFinite(players)) {
    return null;
  }

  return { timestamp, uptime, fps, players };
}

/**
 * Reads the file's contents, or null when it is missing or empty.
 * @param {string} file - Path to the sample log
 * @returns {string|null} Raw file contents, or null when there is nothing to read
 * @private
 */
function readText(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return text.length ? text : null;
}

/**
 * Splits raw contents into trimmed, non-empty lines.
 * @param {string} text - Raw file contents
 * @returns {string[]} Non-empty lines
 * @private
 */
function toLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Uptime of the most recent complete row, scanning backwards so a torn final line
 * from an interrupted write doesn't hide the real last sample.
 * @param {string|null} text - Raw file contents from readText()
 * @returns {number|null} Last logged uptime, or null when there is no usable row
 * @private
 */
function lastLoggedUptime(text) {
  if (!text) return null;
  const lines = toLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = parseRow(lines[i]);
    if (row) return row.uptime;
  }
  return null;
}

/**
 * Appends one sample, resetting the file when the server has restarted.
 *
 * Restart detection is based on the UPTIME COLUMN going backwards rather than on
 * the bot starting the server, deliberately: the bot is swapped and restarted far
 * more often than the server is, and the server can equally restart (or crash and
 * be relaunched) while the bot is down. The uptime counter is the only signal
 * that survives both, and a drop in it means the samples above belong to a
 * previous server lifetime.
 *
 * Best-effort: never throws, so the monitor is never disturbed by a failed write.
 * @param {{uptime: number, fps: number, players: number}} sample - Values from a
 *   single /metrics response
 */
export function recordSample({ uptime, fps, players }) {
  try {
    // A malformed /metrics response must not write garbage rows.
    if (!Number.isFinite(uptime) || !Number.isFinite(fps) || !Number.isFinite(players)) {
      return;
    }

    ensureLogDir();
    const file = logPath(FILE_NAME);
    const text = readText(file);
    const previousUptime = lastLoggedUptime(text);

    // Null covers a missing or header-only file; a higher previous uptime means
    // the server restarted underneath us. Either way, start a fresh file.
    if (previousUptime === null || previousUptime > uptime) {
      fs.writeFileSync(file, `${HEADER}\n`);
    } else if (!text.endsWith('\n')) {
      // An interrupted write can leave the file without its trailing newline;
      // close the torn line off first so it can't swallow this sample too.
      fs.appendFileSync(file, '\n');
    }

    fs.appendFileSync(file, `${new Date().toISOString()},${uptime},${fps},${players}\n`);
  } catch (error) {
    logger.warn(`FPS sample not recorded: ${sanitizeErrorMessage(error)}`);
  }
}

/**
 * Reads every complete sample from the log, oldest first. The header and any
 * malformed or partial line - including a torn final line from a write that was
 * interrupted mid-append - are skipped rather than throwing.
 * @returns {Array<{timestamp: string, uptime: number, fps: number, players: number}>}
 *   Parsed samples, empty when the file is missing or unreadable
 */
export function readSamples() {
  try {
    const text = readText(logPath(FILE_NAME));
    if (!text) return [];

    const samples = [];
    for (const line of toLines(text)) {
      const row = parseRow(line);
      if (row) samples.push(row);
    }
    return samples;
  } catch (error) {
    logger.warn(`FPS samples could not be read: ${sanitizeErrorMessage(error)}`);
    return [];
  }
}

/**
 * Rounds an average to one decimal - more precision than that is noise for a
 * frame rate sampled every few minutes.
 * @param {number} value - Value to round
 * @returns {number} Value rounded to one decimal place
 * @private
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Builds a window summary from its accumulators, or null when the window is empty.
 * @param {{fps: number, players: number, count: number}} totals - Window accumulators
 * @returns {{averageFps: number, averagePlayers: number, count: number}|null} Window summary
 * @private
 */
function windowSummary(totals) {
  if (totals.count === 0) return null;
  return {
    averageFps: round1(totals.fps / totals.count),
    averagePlayers: round1(totals.players / totals.count),
    count: totals.count
  };
}

/**
 * Aggregates samples into the figures /palperf renders. Computed in a single pass:
 * the window bounds come from the first and last samples, which are known before
 * the loop starts.
 * @param {Array<{uptime: number, fps: number, players: number}>} samples - Samples
 *   from readSamples(), oldest first
 * @returns {{count: number, averageFps: number, minFps: number, maxFps: number,
 *   averagePlayers: number, maxPlayers: number, spanSeconds: number,
 *   firstHour: ({averageFps: number, averagePlayers: number, count: number}|null),
 *   recentHour: ({averageFps: number, averagePlayers: number, count: number}|null)}}
 *   Summary; a count of 0 with zeroed figures when there are no samples
 */
export function summarize(samples) {
  const count = samples.length;
  if (count === 0) {
    return {
      count: 0,
      averageFps: 0,
      minFps: 0,
      maxFps: 0,
      averagePlayers: 0,
      maxPlayers: 0,
      spanSeconds: 0,
      firstHour: null,
      recentHour: null
    };
  }

  const spanSeconds = samples[count - 1].uptime - samples[0].uptime;

  // Under two hours of data the two one-hour windows overlap, so comparing them
  // would be false precision - suppress both rather than report a bogus trend.
  const comparable = spanSeconds >= MIN_COMPARISON_SPAN_SECONDS;
  const firstHourEnd = samples[0].uptime + HOUR_SECONDS;
  const recentHourStart = samples[count - 1].uptime - HOUR_SECONDS;

  let fpsTotal = 0;
  let playersTotal = 0;
  let minFps = Infinity;
  let maxFps = -Infinity;
  let maxPlayers = 0;
  const first = { fps: 0, players: 0, count: 0 };
  const recent = { fps: 0, players: 0, count: 0 };

  for (const { uptime, fps, players } of samples) {
    fpsTotal += fps;
    playersTotal += players;
    if (fps < minFps) minFps = fps;
    if (fps > maxFps) maxFps = fps;
    if (players > maxPlayers) maxPlayers = players;

    if (!comparable) continue;
    if (uptime <= firstHourEnd) {
      first.fps += fps;
      first.players += players;
      first.count++;
    }
    if (uptime >= recentHourStart) {
      recent.fps += fps;
      recent.players += players;
      recent.count++;
    }
  }

  return {
    count,
    averageFps: round1(fpsTotal / count),
    minFps,
    maxFps,
    averagePlayers: round1(playersTotal / count),
    maxPlayers,
    spanSeconds,
    firstHour: comparable ? windowSummary(first) : null,
    recentHour: comparable ? windowSummary(recent) : null
  };
}
