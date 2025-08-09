/**
 * Centralized authorization middleware for Palworld Discord bot
 * Eliminates DRY violations by consolidating role checking logic
 */

/**
 * Checks if user has the required 'palserver' role to execute server operations
 * Uses simplified role checking - only looks for exact role name match (case-insensitive)
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if user has palserver role, false otherwise
 */
export function userHasPalserverRole(interaction) {
  const member = interaction.member;
  return member?.roles?.cache?.some(r => r.name.toLowerCase() === 'palserver');
}

/**
 * Checks authorization and sends error response if unauthorized
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if authorized, false if unauthorized (and error sent)
 */
export function checkAuthorization(interaction) {
  if (!userHasPalserverRole(interaction)) {
    interaction.reply({ content: 'You need the `palserver` role to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

/**
 * Authorization middleware wrapper for command handlers
 * Automatically checks authorization before executing the handler
 * @param {Function} handler - The command handler function to wrap
 * @returns {Function} Wrapped handler with authorization checking
 */
export function requirePalserverRole(handler) {
  return async (interaction) => {
    if (!checkAuthorization(interaction)) {
      return; // Authorization failed, error already sent
    }
    
    // User is authorized, proceed with original handler
    return handler(interaction);
  };
}