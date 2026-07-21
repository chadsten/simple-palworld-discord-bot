import { getInfo } from '../palworld.js';
import { sanitizeErrorMessage } from '../utils/security.js';
import { createLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { ActivityType } from 'discord.js';
import { serverState, SERVER_STATE } from './loop.js';

// Logger instance for this module
const logger = createLogger('Monitor');

// Discord presentation state - owned here, mutated only within this module.
let discordClient = null;
export let lastKnownServerName = 'Palworld Server';

/**
 * Registers the Discord client the presence layer posts through. Called by
 * startMonitoring so the client handle lives beside the code that uses it,
 * keeping this the single owner of discordClient.
 * @param {Client|null} client - Discord client, or null when none is available
 */
export function setDiscordClient(client) {
  discordClient = client;
}

/**
 * Updates the Discord bot's status based on server state
 * @private
 */
export async function updateDiscordStatus() {
  if (!discordClient || !discordClient.user) {
    logger.debug('Discord client not available, skipping status update');
    return;
  }

  try {
    let serverName = lastKnownServerName;

    // Try to get the actual server name if server is up
    if (serverState === SERVER_STATE.KNOWN_UP) {
      try {
        const info = await getInfo();
        if (info.servername) {
          serverName = info.servername;
          lastKnownServerName = serverName; // Store for when server goes down
        }
      } catch {
        // If we can't get server info, use last known name
      }
    }
    // When server is down, we use the last known server name

    const status = serverState === SERVER_STATE.KNOWN_UP ? 'UP' : 'DOWN';
    const activityName = `${serverName} is ${status}`;

    await discordClient.user.setActivity(activityName, {
      type: ActivityType.Custom
    });

    logger.info(`Discord status updated: ${activityName}`);
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    logger.error(`Failed to update Discord status: ${sanitizedMessage}`);
  }
}

/**
 * Sends a message to the configured announcement channel. Used by the monitor's
 * own auto-stop line and by callers outside it (actions.js, process.js) that need
 * to post there. Best-effort: silently disabled when unconfigured, never throws.
 * @param {string} message - Message to post to the channel
 */
export async function announceServerEvent(message) {
  if (!config.discord.announceChannelId) {
    return;
  }

  if (!discordClient) {
    logger.debug('Discord client not available, skipping announcement');
    return;
  }

  try {
    const channel = await discordClient.channels.fetch(config.discord.announceChannelId);
    if (!channel?.isTextBased?.()) {
      logger.warn(`Announce channel not found or not text-based: ${config.discord.announceChannelId}`);
      return;
    }
    await channel.send(message);
  } catch (error) {
    const sanitizedMessage = sanitizeErrorMessage(error);
    logger.warn(`Failed to send announcement: ${sanitizedMessage}`);
  }
}
