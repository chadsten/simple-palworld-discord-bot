import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder } from 'discord.js';
import { getInfo, getPlayers, getMetrics, saveWorld, shutdown, isUp } from './palworld.js';
import { startServer } from './process.js';
import { startMonitoring, setServerUp, setServerDown } from './monitor.js';
import { sanitizeErrorMessage } from './utils/security.js';
import { createLogger, createPerformanceLogger } from './utils/logger.js';
import { checkAuthorization } from './middleware/auth.js';
import config from './config/index.js';

const logger = createLogger('DiscordBot');
const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });

// Global lock mechanism to prevent concurrent server operations
// This is critical because multiple users could trigger start/stop simultaneously,
// leading to race conditions and unpredictable server state
let busy = false;
const withLock = async (fn) => {
  if (busy) throw new Error('Another operation is in progress.');
  busy = true;
  try { return await fn(); } finally { busy = false; }
};


/**
 * Helper function to check server status and return early if down
 * Reduces code duplication across multiple commands that require server to be running
 */
async function requireServerUp(interaction) {
  const up = await isUp();
  if (!up) {
    await interaction.editReply('Server appears **DOWN**.');
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
  
  return embed;
}

client.once('ready', async () => {
  logger.info(`Bot logged in as ${client.user.tag}`);
  
  // Start background monitoring for auto-stop functionality
  await startMonitoring(gracefulShutdown, withLock, client);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'palstatus': {
        // Authorization check - only users with 'palserver' role can use any commands
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();
        
        // Early return if server is down - reduces nesting and improves readability
        if (!(await requireServerUp(interaction))) return;
        
        const embed = await createServerStatusEmbed('Server Status');
        return interaction.editReply({ embeds: [embed] });
      }

      case 'palplayers': {
        // Authorization check - only users with 'palserver' role can use any commands
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();
        
        // Use helper function to reduce code duplication
        if (!(await requireServerUp(interaction))) return;
        
        const players = await getPlayers();
        // Handle multiple possible player name formats from different Palworld versions
        const list = players.length
          ? players.map(p => `• ${p.name ?? p.playerName ?? 'Unknown'}`).join('\n')
          : 'No players online.';
        return interaction.editReply(list);
      }

      case 'palstart': {
        // Authorization check - only users with 'palserver' role can start/stop server
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();
        
        // Use lock to prevent concurrent start operations which could cause issues
        return withLock(async () => {
          const up = await isUp();
          if (up) {
            const embed = await createServerStatusEmbed('Server Status');
            return interaction.editReply({ content: 'Server is already **UP**.', embeds: [embed] });
          }
          
          try {
            await startServer();
            
            // Notify monitor that server is now up
            await setServerUp();
            
            // Check if API is responding and show status if available
            try {
              const embed = await createServerStatusEmbed('Server Started');
              return interaction.editReply({ content: 'Server started successfully!', embeds: [embed] });
            } catch {
              // API not responding yet, fall back to simple message
              return interaction.editReply('Launch requested. Server should be up shortly.');
            }
          } catch (e) {
            // Provide specific error feedback to help with troubleshooting
            const sanitizedMessage = sanitizeErrorMessage(e);
            return interaction.editReply(`Start failed: \`${sanitizedMessage}\``);
          }
        }).catch(err => interaction.editReply(sanitizeErrorMessage(err)));
      }

      case 'palstop': {
        // Authorization check - only users with 'palserver' role can start/stop server
        if (!checkAuthorization(interaction)) return;
        await interaction.deferReply();
        
        // Use lock to prevent concurrent stop operations which could cause corruption
        return withLock(async () => {
          const result = await gracefulShutdown();
          return interaction.editReply(result.message);
        }).catch(err => interaction.editReply(sanitizeErrorMessage(err)));
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
          )
          .setColor('#808080');
        return interaction.reply({ embeds: [embed] });
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
      return interaction.editReply('Unexpected error. Check bot logs.');
    } else {
      return interaction.reply({ content: 'Unexpected error. Check bot logs.', ephemeral: true });
    }
  }
});

/**
 * Safely converts objects to JSON strings with fallback to string conversion
 * Prevents crashes when trying to display non-serializable objects
 */
function safeStringify(x) { 
  try { 
    return JSON.stringify(x, null, 2); 
  } catch { 
    return String(x); 
  } 
}

/**
 * Executes graceful server shutdown with player checks and world save
 * Used by both manual /palstop command and auto-monitoring system
 * @returns {Promise<{success: boolean, message: string}>} Result of shutdown attempt
 */
async function gracefulShutdown() {
  // Check if server is up
  const up = await isUp();
  if (!up) return { success: false, message: 'Server already appears **DOWN**.' };
  
  // First player count check - don't stop if players are online
  let players = await getPlayers();
  if (players.length > 0) {
    return { success: false, message: `Cannot stop: **${players.length}** player(s) online.` };
  }
  
  try {
    // Save world state before shutdown to prevent data loss
    await saveWorld();
    
    // Wait after saving to allow any last-second player connections
    // This prevents stopping the server right as someone joins
    await sleep(config.timing.saveWorldDelayMs);
    
    // Second player count check - abort if players connected during save operation
    // This double-check prevents accidentally stopping server with active players
    players = await getPlayers();
    if (players.length > 0) {
      return { success: false, message: `Abort: **${players.length}** player(s) just connected.` };
    }
    
    // Graceful shutdown with configured delay allows server to clean up properly
    // The delay gives the server time to finish any pending operations
    await shutdown(config.timing.shutdownDelaySeconds, 'Stopping (admin request).');
    
    // Wait for server to actually go down before confirming
    const serverDown = await waitForShutdown(config.timing.startTimeoutMs, config.timing.pollIntervalMs);
    if (!serverDown) {
      return { success: false, message: 'Server shutdown timed out - may still be running.' };
    }
    
    // Notify monitor that server is now down
    await setServerDown();
    
    return { success: true, message: 'Graceful server stop completed.' };
  } catch (e) {
    // Provide specific error feedback for debugging server issues
    const sanitizedMessage = sanitizeErrorMessage(e);
    return { success: false, message: `Stop failed: \`${sanitizedMessage}\`` };
  }
}

/**
 * Promise-based sleep utility for adding delays
 * Used in shutdown sequence to allow proper timing between operations
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Waits for server to shut down by polling isUp() until it returns false
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {Promise<boolean>} true if server went down, false if timeout
 */
async function waitForShutdown(timeoutMs, intervalMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (!(await isUp())) return true; // Server is down
    } catch {}
    await sleep(intervalMs);
  }
  return false; // Timeout
}

client.login(config.discord.token);

// Log successful startup
logger.info(`Discord bot starting up - Node ${process.version}`);
