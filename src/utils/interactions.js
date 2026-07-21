/**
 * Interaction-safety helpers shared across the bot.
 *
 * Lives in its own module so both the command handlers and the auth middleware
 * can route replies through the same guard without a circular import: the
 * handlers import the auth middleware, so the middleware cannot import back
 * from them.
 */
import { createLogger } from './logger.js';

const logger = createLogger('DiscordBot');

/**
 * Discord API error codes for an interaction that can no longer be answered with
 * a first response: 10062 (Unknown interaction) once the initial 3-second
 * response window has closed, plus 10015 (Unknown Webhook) / 50027 (Invalid
 * Webhook Token) when the backing webhook is already gone. reply()/deferReply()
 * can raise any of these; editReply cannot raise 10062 (see safeEdit below).
 */
const EXPIRED_REPLY_CODES = [10062, 10015, 50027];

/**
 * Discord API error codes returned when an interaction's 15-minute token has
 * expired - the webhook backing it is gone, so no further edit can land.
 */
const EXPIRED_INTERACTION_CODES = [10015, 50027];

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
export async function safeEdit(interaction, payload) {
  try {
    return await interaction.editReply(payload);
  } catch (err) {
    if (!EXPIRED_INTERACTION_CODES.includes(err?.code)) throw err;
    logger.warn(`Interaction token expired for /${interaction.commandName}; reply dropped`);
  }
}
