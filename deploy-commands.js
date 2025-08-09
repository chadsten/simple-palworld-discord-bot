/**
 * Discord Slash Commands Registration Utility
 * 
 * This script registers Discord slash commands with the Discord API for the Palworld bot.
 * Must be run whenever commands are added, modified, or removed to sync them with Discord.
 * 
 * Required Environment Variables:
 * - DISCORD_TOKEN: Bot token for authentication with Discord API
 * - CLIENT_ID: Application ID from Discord Developer Portal
 * - GUILD_ID: Discord server ID where commands should be registered
 * 
 * Command Registration:
 * - Uses guild-specific registration for faster deployment during development
 * - For production, consider using global command registration (Routes.applicationCommands)
 * - Commands take up to 1 hour to propagate globally, but are instant for guild registration
 * 
 * Usage: node deploy-commands.js
 */
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

/**
 * Palworld Bot Command Definitions
 * 
 * Each command is built using Discord.js SlashCommandBuilder and converted to JSON
 * for API registration. Commands are designed for role-based access control.
 */
const commands = [
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
    .setName('palhelp')
    .setDescription('Show all available Palworld commands'),
].map(c => c.toJSON());

// Initialize Discord REST client with API version 10 for command registration
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

/**
 * Immediately Invoked Function Expression (IIFE) for command deployment
 * 
 * Performs the following operations:
 * 1. Authenticates with Discord API using bot token
 * 2. Registers commands to the specified guild (server)
 * 3. Provides deployment feedback and error handling
 * 4. Exits with appropriate status code
 */
(async () => {
  try {
    console.log('Deploying commands...');
    
    // Register commands to specific guild for instant availability
    // Alternative: Routes.applicationCommands(CLIENT_ID) for global registration
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    
    console.log('Done.');
  } catch (e) {
    // Log deployment errors and exit with failure status
    // Common errors: Invalid token, missing permissions, network issues
    console.error(e);
    process.exit(1);
  }
})();
