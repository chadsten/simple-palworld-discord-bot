/**
 * Centralized authorization middleware for Palworld Discord bot
 * Eliminates DRY violations by consolidating role checking logic
 */
import config from '../config/index.js';

/**
 * Checks if user has the configured role (default 'palserver') to execute server operations
 * Uses simplified role checking - only looks for exact role name match (case-insensitive)
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if user has the configured role, false otherwise
 */
export function userHasPalserverRole(interaction) {
  const member = interaction.member;
  return member?.roles?.cache?.some(r => r.name.toLowerCase() === config.discord.roleName.toLowerCase());
}

/**
 * Checks authorization and sends error response if unauthorized
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if authorized, false if unauthorized (and error sent)
 */
export function checkAuthorization(interaction) {
  if (!userHasPalserverRole(interaction)) {
    interaction.reply({ content: `You need the \`${config.discord.roleName}\` role to use this command.`, ephemeral: true });
    return false;
  }
  return true;
}