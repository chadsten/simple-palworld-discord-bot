/**
 * Interaction-safety helpers shared across the bot.
 *
 * Lives in its own module so both src/index.js and the auth middleware can route
 * replies through the same guard without a circular import: index.js imports the
 * auth middleware, so the middleware cannot import back from index.js.
 */
import { createLogger } from './logger.js';

const logger = createLogger('DiscordBot');

/**
 * Discord API error codes for an interaction that can no longer be answered with
 * a first response: 10062 (Unknown interaction) once the initial 3-second
 * response window has closed, plus 10015 (Unknown Webhook) / 50027 (Invalid
 * Webhook Token) when the backing webhook is already gone. reply()/deferReply()
 * can raise any of these; editReply cannot raise 10062 (see safeEdit in index.js).
 */
const EXPIRED_REPLY_CODES = [10062, 10015, 50027];

/**
 * reply that tolerates an expired interaction.
 *
 * Mirrors safeEdit for the pre-acknowledgement path: a rejected reply is
 * unrecoverable and, because discord.js never awaits the interactionCreate
 * listener, would surface as an unhandled rejection - which main.js treats as
 * fatal and exits on, killing the bot over a late reply. Only the expired-
 * interaction codes are swallowed; every other failure still propagates.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string|import('discord.js').InteractionReplyOptions} payload - reply payload
 * @returns {Promise<*>} The reply result, or undefined when the interaction had expired
 */
export async function safeReply(interaction, payload) {
  try {
    return await interaction.reply(payload);
  } catch (err) {
    if (!EXPIRED_REPLY_CODES.includes(err?.code)) throw err;
    logger.warn(`Interaction expired for /${interaction.commandName}; reply dropped`);
  }
}
