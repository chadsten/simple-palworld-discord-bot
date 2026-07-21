import { SlashCommandBuilder } from 'discord.js';
import { checkAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { doBounce } from '../actions.js';
import { replyWithResult } from '../embeds.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palbounce')
    .setDescription('Graceful stop, then restart the server')
    .toJSON(),

  handler: async (interaction) => {
    // Authorization check - only users with 'palserver' role can start/stop server
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Shared action runs stop+wait+start under one lock; onProgress surfaces the
    // intermediate "Restarting in Ns..." message via editReply, preserving UX.
    const r = await doBounce({
      actor: interaction.user.username,
      originChannelId: interaction.channelId,
      onProgress: (m) => safeEdit(interaction, m)
    });
    return replyWithResult(interaction, r, 'Bounce complete. Server should be up shortly.');
  }
};
