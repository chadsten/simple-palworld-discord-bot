import { SlashCommandBuilder } from 'discord.js';
import { checkAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { doStop } from '../actions.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palstop')
    .setDescription('Gracefully stop (only when 0 players)')
    .toJSON(),

  handler: async (interaction) => {
    // Authorization check - only users with 'palserver' role can start/stop server
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Shared action owns the lock + graceful stop; message matches gracefulShutdown.
    const r = await doStop({ actor: interaction.user.username, originChannelId: interaction.channelId });
    return safeEdit(interaction, r.message);
  }
};
