import { SlashCommandBuilder } from 'discord.js';
import { checkAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { getPlayers } from '../palworld.js';
import { formatPlayerList } from '../embeds.js';
import { requireServerUp } from './shared.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palplayers')
    .setDescription('List current players')
    .toJSON(),

  handler: async (interaction) => {
    // Authorization check - only users with 'palserver' role can use any commands
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Use helper function to reduce code duplication
    if (!(await requireServerUp(interaction))) return;

    const players = await getPlayers();
    const list = players.length ? formatPlayerList(players) : 'No players online.';
    return safeEdit(interaction, list);
  }
};
