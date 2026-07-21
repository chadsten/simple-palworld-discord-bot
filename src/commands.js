import { SlashCommandBuilder } from 'discord.js';

/**
 * Slash command definitions — single source of truth.
 * Imported by the runtime registrar (src/index.js) and by /palhelp, which
 * generates its listing from these names and descriptions so it cannot drift.
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
  new SlashCommandBuilder()
    .setName('palannounce')
    .setDescription('Broadcast a message to in-game chat (admin)')
    .addStringOption(o => o
      .setName('message')
      .setDescription('Text to announce to all players')
      .setRequired(true)
      .setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('palsave')
    .setDescription('Force a world save (admin)'),
  new SlashCommandBuilder()
    .setName('palkill')
    .setDescription('Stop the server even with players online, cleanly if possible, force if not (admin)'),
  new SlashCommandBuilder()
    .setName('palperf')
    .setDescription('Server FPS trend from the current uptime window (admin)'),
].map(c => c.toJSON());
