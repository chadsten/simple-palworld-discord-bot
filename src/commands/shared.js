/**
 * Cross-command helpers shared by the co-located command modules.
 *
 * Lives beside the command files so any command that needs the guard imports it
 * from one place rather than each file re-declaring it.
 */
import { isUp } from '../palworld.js';
import { safeEdit } from '../utils/interactions.js';

/**
 * Helper function to check server status and return early if down
 * Reduces code duplication across multiple commands that require server to be running
 */
export async function requireServerUp(interaction) {
  const up = await isUp();
  if (!up) {
    await safeEdit(interaction, 'Server appears **DOWN**.');
    return false;
  }
  return true;
}
