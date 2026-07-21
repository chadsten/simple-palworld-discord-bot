/**
 * Centralized authorization middleware for Palworld Discord bot
 * Eliminates DRY violations by consolidating role checking logic
 */
import { MessageFlags } from 'discord.js';
import config from '../config/index.js';
import { safeReply } from '../utils/interactions.js';

/**
 * Checks if the interacting member has a role by exact name match (case-insensitive)
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @param {string} roleName - Role name to look for
 * @returns {boolean} True if the member has the role, false otherwise
 */
function memberHasRole(interaction, roleName) {
  const member = interaction.member;
  return member?.roles?.cache?.some(r => r.name.toLowerCase() === roleName.toLowerCase());
}

/**
 * Checks if user has the configured role (default 'palserver') to execute server operations.
 * The admin role also passes: admins are a superset of base users, so they never
 * need both roles assigned to use the base commands.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if user has the base or admin role, false otherwise
 */
export function userHasPalserverRole(interaction) {
  return memberHasRole(interaction, config.discord.roleName)
    || memberHasRole(interaction, config.discord.adminRoleName);
}

/**
 * Checks authorization and sends error response if unauthorized
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if authorized, false if unauthorized (and error sent)
 */
export function checkAuthorization(interaction) {
  if (!userHasPalserverRole(interaction)) {
    // Fire-and-forget from this synchronous guard: safeReply swallows an expired
    // interaction, and the trailing catch guards the floating promise so a
    // transient reply failure can't surface as a fatal unhandledRejection.
    safeReply(interaction, { content: `You need the \`${config.discord.roleName}\` role to use this command.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}

/**
 * Checks admin authorization (requires the admin role specifically, default
 * 'palserver-admin') and sends error response if unauthorized
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - Discord interaction
 * @returns {boolean} True if authorized, false if unauthorized (and error sent)
 */
export function checkAdminAuthorization(interaction) {
  if (!memberHasRole(interaction, config.discord.adminRoleName)) {
    // Fire-and-forget from this synchronous guard: safeReply swallows an expired
    // interaction, and the trailing catch guards the floating promise so a
    // transient reply failure can't surface as a fatal unhandledRejection.
    safeReply(interaction, { content: `You need the \`${config.discord.adminRoleName}\` role to use this command.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}
