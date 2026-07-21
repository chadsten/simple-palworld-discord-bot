/**
 * Command collector — the single place that assembles every co-located command
 * module into the two shapes the runtime consumes: the definition array
 * registered with Discord (commandDefinitions) and the name->handler dispatch
 * map (commandHandlers).
 *
 * Each command file owns BOTH its definition and its handler, so the two can no
 * longer drift apart. Here they are derived from ONE source object per command:
 * commandHandlers is keyed by each definition's own `name`, so a dispatch key
 * can never disagree with the name that was registered.
 *
 * Modules are imported EXPLICITLY, one per command - NOT directory-scanned.
 * Under a packaged SEA/pkg build the source lives inside a snapshot where a
 * runtime fs.readdirSync would find nothing and silently register zero commands.
 */
import { command as palstatus } from './palstatus.js';
import { command as palplayers } from './palplayers.js';
import { command as palstart } from './palstart.js';
import { command as palstop } from './palstop.js';
import { command as palbounce } from './palbounce.js';
import { command as palhelp } from './palhelp.js';
import { command as palannounce } from './palannounce.js';
import { command as palsave } from './palsave.js';
import { command as palkill } from './palkill.js';
import { command as palperf } from './palperf.js';

// Registration order is fixed here so the Discord command list and /palhelp
// render in the same familiar order across deploys.
const commands = [
  palstatus,
  palplayers,
  palstart,
  palstop,
  palbounce,
  palhelp,
  palannounce,
  palsave,
  palkill,
  palperf
];

/** Slash command JSON definitions, in registration order. */
export const commandDefinitions = commands.map(c => c.definition);

/** name -> handler dispatch map, keyed by each definition's registered name. */
export const commandHandlers = Object.fromEntries(
  commands.map(c => [c.definition.name, c.handler])
);
