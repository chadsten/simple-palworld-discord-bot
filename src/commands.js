import { SlashCommandBuilder } from 'discord.js';

/**
 * Slash command definitions — single source of truth.
 * Imported by both the runtime registrar (src/index.js) and the manual
 * deploy script (deploy-commands.js).
 */
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('palstatus')
    .setDescription('Show server status and players'),
  new SlashCommandBuilder()
    .setName('palplayers')
    .setDescription('List current players'),
  new SlashCommandBuilder()
    .setName('palstart')
    .setDescription('Start the Palworld server'),
  new SlashCommandBuilder()
    .setName('palstop')
    .setDescription('Gracefully stop (only when 0 players)'),
  new SlashCommandBuilder()
    .setName('palbounce')
    .setDescription('Graceful stop, then restart the server'),
  new SlashCommandBuilder()
    .setName('palhelp')
    .setDescription('Show all available Palworld commands'),
].map(c => c.toJSON());
