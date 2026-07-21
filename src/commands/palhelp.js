import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { checkAuthorization } from '../middleware/auth.js';
import { safeReply } from '../utils/interactions.js';
import { commandDefinitions } from './index.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palhelp')
    .setDescription('Show all available Palworld commands')
    .toJSON(),

  handler: async (interaction) => {
    // Authorization check - only users with 'palserver' role can use any commands
    if (!checkAuthorization(interaction)) return;

    // Generated from the command definitions rather than restated here, so the
    // help can never drift from what is actually registered. The definitions
    // already carry the "(admin)" markers, so the help inherits them.
    //
    // commandDefinitions is imported from ./index.js, which in turn imports this
    // module to collect it - a cycle. It is safe because the binding is read
    // here at CALL time, by when ./index.js has finished initializing it; it is
    // never touched at module-init time.
    const embed = new EmbedBuilder()
      .setTitle('Palworld Bot Commands')
      .addFields(commandDefinitions.map(c => ({ name: `/${c.name}`, value: c.description, inline: false })))
      .setColor('#808080');
    return safeReply(interaction, { embeds: [embed] });
  }
};
