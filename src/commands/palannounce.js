import { SlashCommandBuilder } from 'discord.js';
import { checkAdminAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { announce } from '../palworld.js';
import { requireServerUp } from './shared.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palannounce')
    .setDescription('Broadcast a message to in-game chat (admin)')
    .addStringOption(o => o
      .setName('message')
      .setDescription('Text to announce to all players')
      .setRequired(true)
      .setMaxLength(200))
    .toJSON(),

  handler: async (interaction) => {
    // Admin authorization check - requires the 'palserver-admin' role specifically
    if (!checkAdminAuthorization(interaction)) return;
    await interaction.deferReply();

    // Early return if server is down - the announce API needs a live server
    if (!(await requireServerUp(interaction))) return;

    const message = interaction.options.getString('message', true);
    await announce(message);
    return safeEdit(interaction, `Announced in-game: "${message}"`);
  }
};
