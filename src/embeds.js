/**
 * Presentation helpers shared by the command handlers.
 *
 * Everything that turns server state into something Discord can render lives
 * here, so the command modules in src/commands/ stay about command flow and src/index.js
 * stays about the client lifecycle.
 */
import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { getInfo, getPlayers, getMetrics } from './palworld.js';
import { safeEdit } from './utils/interactions.js';

/**
 * Convert uptime seconds to human-readable format (e.g., "2h 15m 30s")
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime string
 */
export function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Formats player names as a bulleted list capped to Discord's 1024-character
 * embed field limit, ending with "…and N more" when truncated
 * @param {Array<object>} players - Player records from the Palworld API
 * @returns {string} Bulleted player name list
 */
export function formatPlayerList(players) {
  // Handle multiple possible player name formats from different Palworld versions.
  // Names are attacker-controlled by anyone who can join the server, so they are
  // escaped before interpolation: maskedLink is off by default in discord.js and
  // must be requested explicitly, otherwise a player called "[FREE PALS](url)"
  // plants a clickable link in the embed. Escaping runs before the length check
  // so the 1024 cap is measured against the text Discord actually receives.
  const lines = players.map(p => `• ${escapeMarkdown(p.name ?? p.playerName ?? 'Unknown', { maskedLink: true })}`);
  let list = lines.join('\n');
  while (list.length > 1024) {
    lines.pop();
    list = `${lines.join('\n')}\n…and ${players.length - lines.length} more`;
  }
  return list;
}

/**
 * Creates a server status embed with current server information
 * @param {string} title - Title for the embed (e.g., "Server Status", "Server Started")
 * @param {string} color - Hex color for the embed (optional, defaults to '#00ff00' for green)
 * @returns {Promise<EmbedBuilder>} Server status embed
 */
export async function createServerStatusEmbed(title, color = '#00ff00') {
  const [info, metrics, players] = await Promise.all([getInfo(), getMetrics(), getPlayers()]);

  // The count lives in the "Online" field name rather than its own field, so the
  // roster is always rendered - including at 0 players, where the empty list is
  // itself the answer. serverfps is the only frame-rate figure shown: serverframetime
  // is just 1000/serverfps, the same signal in different units.
  return new EmbedBuilder()
    .setTitle(`${info.servername || 'Palworld'} ${title}`)
    .addFields(
      { name: 'State', value: '**UP**', inline: true },
      { name: 'FPS', value: Number.isFinite(metrics.serverfps) ? `${metrics.serverfps}` : 'Unknown', inline: true },
      { name: 'Version', value: `${info.version || 'Unknown'}`, inline: true },
      { name: 'Uptime', value: `${formatUptime(metrics.uptime || 0)}`, inline: true },
      {
        name: `Online (${players.length})`,
        value: players.length ? formatPlayerList(players) : 'Nobody online.',
        inline: false
      }
    )
    .setColor(color);
}

/**
 * Renders a shared-action result to a deferred interaction. On success with an
 * embedTitle it attaches a status embed (falling back to a plain message if the
 * API isn't ready yet to build one); otherwise it edits in the plain message.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{success: boolean, message: string, embedTitle?: string}} result - Action result
 * @param {string} embedFallbackMessage - Message to show if the embed can't be built
 * @returns {Promise<*>} The editReply result
 */
export async function replyWithResult(interaction, result, embedFallbackMessage) {
  if (result.success && result.embedTitle) {
    // Check if API is responding and show status if available
    try {
      const embed = await createServerStatusEmbed(result.embedTitle);
      return safeEdit(interaction, { content: result.message, embeds: [embed] });
    } catch {
      // API not responding yet, fall back to simple message
      return safeEdit(interaction, embedFallbackMessage);
    }
  }
  return safeEdit(interaction, result.message);
}
