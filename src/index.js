import { Client, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { commandDefinitions, commandHandlers } from './commands/index.js';
import { startMonitoring } from './monitor.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger } from './utils/logger.js';
import { safeEdit, safeReply } from './utils/interactions.js';
import { gracefulShutdown, doScheduledRestart } from './actions.js';
import config from './config/index.js';

const logger = createLogger('DiscordBot');
// allowedMentions with an empty parse list makes every message the bot sends
// mention-inert. /palannounce echoes operator-supplied text straight back into
// the channel, so without this an "@everyone" in that text would ping the whole
// guild using the BOT's permissions rather than the caller's.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] }
});

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

  // Start background monitoring for auto-stop and scheduled-restart functionality.
  // Both actions are injected rather than imported by monitor.js, which would
  // close an import cycle with actions.js.
  await startMonitoring(gracefulShutdown, client, doScheduledRestart);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Single DRY line naming who ran what, on the happy path for every command.
  // Only the Discord user is available - Discord never exposes Steam identity.
  logger.info(`/${interaction.commandName} invoked by ${interaction.user.username} (${interaction.user.id})`);

  try {
    const handler = commandHandlers[interaction.commandName];
    if (!handler) return;
    return await handler(interaction);
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
      return safeReply(interaction, { content: 'Unexpected error. Check bot logs.', flags: MessageFlags.Ephemeral });
    }
  }
});

client.login(config.discord.token);

// Log successful startup
logger.info(`Discord bot starting up - Node ${process.version}`);

// Exported so the guarded entry point (main.js) can hand the live client to the
// system-tray so a tray "Quit" can cleanly destroy the Discord connection.
export { client };
