import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands.js';
import { getInfo, getPlayers, getMetrics, isUp } from './palworld.js';
import { startMonitoring } from './monitor.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { safeReply } from './utils/interactions.js';
import { checkAuthorization } from './middleware/auth.js';
import { gracefulShutdown, doStart, doStop, doBounce } from './actions.js';
import config from './config/index.js';

const logger = createLogger('DiscordBot');
const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });


/**
 * Discord API error codes returned when an interaction's 15-minute token has
 * expired - the webhook backing it is gone, so no further edit can land.
 */
const EXPIRED_INTERACTION_CODES = [10015, 50027];

/**
 * editReply that tolerates an expired interaction token.
 *
 * A rejected editReply is unrecoverable and, because discord.js never awaits the
 * interactionCreate listener, would surface as an unhandled rejection - which
 * main.js treats as fatal and exits on, killing the bot over a late reply. Only
 * the expired-token codes are swallowed; every other failure still propagates.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string|import('discord.js').InteractionEditReplyOptions} payload - editReply payload
 * @returns {Promise<*>} The edited message, or undefined when the token had expired
 */
async function safeEdit(interaction, payload) {
  try {
    return await interaction.editReply(payload);
  } catch (err) {
    if (!EXPIRED_INTERACTION_CODES.includes(err?.code)) throw err;
    logger.warn(`Interaction token expired for /${interaction.commandName}; reply dropped`);
  }
}

/**
 * Helper function to check server status and return early if down
 * Reduces code duplication across multiple commands that require server to be running
 */
async function requireServerUp(interaction) {
  const up = await isUp();
  if (!up) {
    await safeEdit(interaction, 'Server appears **DOWN**.');
    return false;
  }
  return true;
}
/**
 * Convert uptime seconds to human-readable format (e.g., "2h 15m 30s")
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime string
 */
function formatUptime(seconds) {
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
function formatPlayerList(players) {
  // Handle multiple possible player name formats from different Palworld versions
  const lines = players.map(p => `• ${p.name ?? p.playerName ?? 'Unknown'}`);
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
async function createServerStatusEmbed(title, color = '#00ff00') {
  const [info, metrics, players] = await Promise.all([getInfo(), getMetrics(), getPlayers()]);

  const embed = new EmbedBuilder()
    .setTitle(`${info.servername || 'Palworld'} ${title}`)
    .addFields(
      { name: 'State', value: '**UP**', inline: true },
      { name: 'Players', value: `${players.length}`, inline: true },
      { name: 'Version', value: `${info.version || 'Unknown'}`, inline: true },
      { name: 'Uptime', value: `${formatUptime(metrics.uptime || 0)}`, inline: true }
    )
    .setColor(color);

  // Name who's online; omitted at 0 players so post-start/post-bounce embeds stay unchanged
  if (players.length > 0) {
    embed.addFields({ name: 'Online', value: formatPlayerList(players), inline: false });
  }

  return embed;
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
async function replyWithResult(interaction, result, embedFallbackMessage) {
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

client.once('ready', async () => {
  logger.info(`Bot logged in as ${client.user.tag}`);

  // Auto-register slash commands on startup so a packaged build is self-sufficient.
  // A failure here must not stop the bot - commands may already be registered from a prior run.
  try {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commandDefinitions }
    );
    logger.info('Slash commands registered');
  } catch (err) {
    logger.error(`Slash command registration failed: ${sanitizeErrorMessage(err)}`);
  }

  // Start background monitoring for auto-stop functionality
  await startMonitoring(gracefulShutdown, client);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Single DRY line naming who ran what, on the happy path for every command.
  // Only the Discord user is available - Discord never exposes Steam identity.
  logger.info(`/${interaction.commandName} invoked by ${interaction.user.username} (${interaction.user.id})`);

  try {
    switch (interaction.commandName) {
      case 'palstatus': {
        // Authorization check - only users with 'palserver' role can use any commands
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();
        
        // Early return if server is down - reduces nesting and improves readability
        if (!(await requireServerUp(interaction))) return;
        
        const embed = await createServerStatusEmbed('Server Status');
        return safeEdit(interaction, { embeds: [embed] });
      }

      case 'palplayers': {
        // Authorization check - only users with 'palserver' role can use any commands
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();
        
        // Use helper function to reduce code duplication
        if (!(await requireServerUp(interaction))) return;
        
        const players = await getPlayers();
        const list = players.length ? formatPlayerList(players) : 'No players online.';
        return safeEdit(interaction, list);
      }

      case 'palstart': {
        // Authorization check - only users with 'palserver' role can start/stop server
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();

        // Shared action owns the lock + start orchestration; this command just
        // renders the result (embed on success, plain message otherwise).
        // onProgress surfaces the update-on-start "checking for updates" line.
        const r = await doStart({
          actor: interaction.user.username,
          onProgress: (m) => safeEdit(interaction, m)
        });
        return replyWithResult(interaction, r, 'Launch requested. Server should be up shortly.');
      }

      case 'palstop': {
        // Authorization check - only users with 'palserver' role can start/stop server
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();

        // Shared action owns the lock + graceful stop; message matches gracefulShutdown.
        const r = await doStop({ actor: interaction.user.username });
        return safeEdit(interaction, r.message);
      }

      case 'palbounce': {
        // Authorization check - only users with 'palserver' role can start/stop server
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();

        // Shared action runs stop+wait+start under one lock; onProgress surfaces the
        // intermediate "Restarting in Ns..." message via editReply, preserving UX.
        const r = await doBounce({
          actor: interaction.user.username,
          onProgress: (m) => safeEdit(interaction, m)
        });
        return replyWithResult(interaction, r, 'Bounce complete. Server should be up shortly.');
      }
      case 'palhelp': {
        // Authorization check - only users with 'palserver' role can use any commands
        if (!checkAuthorization(interaction)) return;
        
        const embed = new EmbedBuilder()
          .setTitle('Palworld Bot Commands')
          .addFields(
            { name: '/palstatus', value: 'Show server status and players', inline: false },
            { name: '/palplayers', value: 'List current players', inline: false },
            { name: '/palstart', value: 'Start the Palworld server', inline: false },
            { name: '/palstop', value: 'Gracefully stop server when 0 players', inline: false },
            { name: '/palbounce', value: 'Graceful stop, wait, then restart the server', inline: false },
          )
          .setColor('#808080');
        return safeReply(interaction, { embeds: [embed] });
      }

    }
  } catch (err) {
    // Global error handler for all command interactions
    // Logs sanitized error details for debugging while providing user-friendly messages
    const sanitizedMessage = sanitizeErrorMessage(err);
    logger.error(`Command error: ${interaction.commandName} by ${interaction.user.tag} - ${sanitizedMessage}`);
    
    // Handle both deferred and non-deferred interactions appropriately
    // Deferred interactions require editReply, while others use reply
    if (interaction.deferred || interaction.replied) {
      return safeEdit(interaction, 'Unexpected error. Check bot logs.');
    } else {
      return safeReply(interaction, { content: 'Unexpected error. Check bot logs.', ephemeral: true });
    }
  }
});

client.login(config.discord.token);

// Log successful startup
logger.info(`Discord bot starting up - Node ${process.version}`);

// Exported so the guarded entry point (main.js) can hand the live client to the
// system-tray so a tray "Quit" can cleanly destroy the Discord connection.
export { client };
