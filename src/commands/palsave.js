import { SlashCommandBuilder } from 'discord.js';
import { checkAdminAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { saveWorld } from '../palworld.js';
import { requireServerUp } from './shared.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palsave')
    .setDescription('Force a world save (admin)')
    .toJSON(),

  handler: async (interaction) => {
    // Admin authorization check - requires the 'palserver-admin' role specifically
    if (!checkAdminAuthorization(interaction)) return;
    await interaction.deferReply();

    // Early return if server is down - the save API needs a live server
    if (!(await requireServerUp(interaction))) return;

    await saveWorld();
    return safeEdit(interaction, 'World save triggered.');
  }
};
