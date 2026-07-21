import { SlashCommandBuilder } from 'discord.js';
import { checkAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { doStart } from '../actions.js';
import { replyWithResult } from '../embeds.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palstart')
    .setDescription('Start the Palworld server')
    .toJSON(),

  handler: async (interaction) => {
    // Authorization check - only users with 'palserver' role can start/stop server
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Shared action owns the lock + start orchestration; this command just
    // renders the result (embed on success, plain message otherwise).
    // onProgress surfaces the update-on-start "checking for updates" line.
    const r = await doStart({
      actor: interaction.user.username,
      originChannelId: interaction.channelId,
      onProgress: (m) => safeEdit(interaction, m)
    });
    return replyWithResult(interaction, r, 'Launch requested. Server should be up shortly.');
  }
};
