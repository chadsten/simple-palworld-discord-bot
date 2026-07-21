import { SlashCommandBuilder } from 'discord.js';
import { checkAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { createServerStatusEmbed } from '../embeds.js';
import { requireServerUp } from './shared.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palstatus')
    .setDescription('Show server status and players')
    .toJSON(),

  handler: async (interaction) => {
    // Authorization check - only users with 'palserver' role can use any commands
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Early return if server is down - reduces nesting and improves readability
    if (!(await requireServerUp(interaction))) return;

    const embed = await createServerStatusEmbed('Server Status');
    return safeEdit(interaction, { embeds: [embed] });
  }
};
