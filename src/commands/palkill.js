import { SlashCommandBuilder } from 'discord.js';
import { checkAdminAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { doKill } from '../actions.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palkill')
    .setDescription('Stop the server even with players online, cleanly if possible, force if not (admin)')
    .toJSON(),

  handler: async (interaction) => {
    // Admin authorization check - requires the 'palserver-admin' role specifically
    if (!checkAdminAuthorization(interaction)) return;
    await interaction.deferReply();

    // Deliberately NO requireServerUp: this is the escape hatch and must work
    // even when the REST API is unresponsive. It is no longer an unconditional
    // hard kill - it saves and asks the server to shut down first (which works
    // with players online) and only force-kills if that does not take.
    //
    // That polite path can take the save settle plus the stop timeout, well
    // over a minute, so surface an intermediate line the same way /palbounce
    // does rather than leaving the deferred reply silent.
    await safeEdit(interaction, 'Saving and stopping the server — will force-kill if that does not take...');
    const r = await doKill({ actor: interaction.user.username, originChannelId: interaction.channelId });
    return safeEdit(interaction, r.message);
  }
};
