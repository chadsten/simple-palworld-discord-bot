import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { checkAdminAuthorization } from '../middleware/auth.js';
import { safeEdit } from '../utils/interactions.js';
import { readSamples, summarize } from '../perflog.js';
import { formatUptime } from '../embeds.js';
import config from '../config/index.js';

export const command = {
  definition: new SlashCommandBuilder()
    .setName('palperf')
    .setDescription('Server FPS trend from the current uptime window (admin)')
    .toJSON(),

  handler: async (interaction) => {
    // Admin authorization check - requires the 'palserver-admin' role specifically
    if (!checkAdminAuthorization(interaction)) return;
    await interaction.deferReply();

    // Deliberately NO requireServerUp: this reads the sample log off disk, and
    // inspecting what the frame rate was doing just before a crash is exactly
    // when the command is most useful.
    const summary = summarize(readSamples());
    const pollMinutes = Math.round(config.monitoring.intervalMs / 60000);

    if (summary.count === 0) {
      return safeEdit(interaction,
        `No FPS samples yet. The bot records one every monitor poll (~${pollMinutes} min) while the server is up, `
        + 'and starts a fresh log each time the server restarts — check back after it has been up a while.');
    }

    const embed = new EmbedBuilder()
      .setTitle('Server Performance')
      .addFields(
        { name: 'Average FPS', value: `${summary.averageFps}`, inline: true },
        { name: 'FPS Range', value: `${summary.minFps} – ${summary.maxFps}`, inline: true },
        { name: 'Players', value: `${summary.averagePlayers} avg · ${summary.maxPlayers} peak`, inline: true },
        { name: 'Samples', value: `${summary.count} over ${formatUptime(summary.spanSeconds)} of uptime`, inline: false }
      )
      .setColor('#00ff00')
      .setFooter({ text: 'FPS dropping as players join is normal load. FPS dropping at a flat player count is the memory-leak signature.' });

    // Only rendered once the two one-hour windows are actually distinct; the
    // summary returns them as null until then rather than inviting a false read.
    if (summary.firstHour && summary.recentHour) {
      embed.addFields({
        name: 'First hour vs most recent hour',
        value: `First: **${summary.firstHour.averageFps}** FPS at ${summary.firstHour.averagePlayers} players\n`
          + `Recent: **${summary.recentHour.averageFps}** FPS at ${summary.recentHour.averagePlayers} players`,
        inline: false
      });
    }

    return safeEdit(interaction, { embeds: [embed] });
  }
};
