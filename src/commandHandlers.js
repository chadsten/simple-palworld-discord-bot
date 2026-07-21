/**
 * One handler per slash command, keyed by command name.
 *
 * src/index.js owns the client lifecycle and looks handlers up from here, so
 * adding a command is a matter of adding its definition in src/commands.js and
 * its handler below. Each handler runs inside the listener's try/catch, which
 * owns the user-facing error reply.
 */
import { EmbedBuilder } from 'discord.js';
import { commandDefinitions } from './commands.js';
import { getPlayers, isUp, saveWorld, announce } from './palworld.js';
import { readSamples, summarize } from './perflog.js';
import { safeEdit, safeReply } from './utils/interactions.js';
import { checkAuthorization, checkAdminAuthorization } from './middleware/auth.js';
import { doStart, doStop, doBounce, doKill } from './actions.js';
import { formatUptime, formatPlayerList, createServerStatusEmbed, replyWithResult } from './embeds.js';
import config from './config/index.js';

/**
 * Helper function to check server status and return early if down
 * Reduces code duplication across multiple commands that require server to be running
 */
async function requireServerUp(interaction) {
  const up = await isUp();
  if (!up) {
    await safeEdit(interaction, 'Server appears **DOWN**.');
    return false;
  }
  return true;
}

export const commandHandlers = {
  async palstatus(interaction) {
    // Authorization check - only users with 'palserver' role can use any commands
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Early return if server is down - reduces nesting and improves readability
    if (!(await requireServerUp(interaction))) return;

    const embed = await createServerStatusEmbed('Server Status');
    return safeEdit(interaction, { embeds: [embed] });
  },

  async palplayers(interaction) {
    // Authorization check - only users with 'palserver' role can use any commands
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Use helper function to reduce code duplication
    if (!(await requireServerUp(interaction))) return;

    const players = await getPlayers();
    const list = players.length ? formatPlayerList(players) : 'No players online.';
    return safeEdit(interaction, list);
  },

  async palstart(interaction) {
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
  },

  async palstop(interaction) {
    // Authorization check - only users with 'palserver' role can start/stop server
    if (!checkAuthorization(interaction)) return;
    await interaction.deferReply();

    // Shared action owns the lock + graceful stop; message matches gracefulShutdown.
    const r = await doStop({ actor: interaction.user.username, originChannelId: interaction.channelId });
    return safeEdit(interaction, r.message);
  },

  async palbounce(interaction) {
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
  },

  async palhelp(interaction) {
    // Authorization check - only users with 'palserver' role can use any commands
    if (!checkAuthorization(interaction)) return;

    // Generated from the command definitions rather than restated here, so the
    // help can never drift from what is actually registered. The definitions
    // already carry the "(admin)" markers, so the help inherits them.
    const embed = new EmbedBuilder()
      .setTitle('Palworld Bot Commands')
      .addFields(commandDefinitions.map(c => ({ name: `/${c.name}`, value: c.description, inline: false })))
      .setColor('#808080');
    return safeReply(interaction, { embeds: [embed] });
  },

  async palannounce(interaction) {
    // Admin authorization check - requires the 'palserver-admin' role specifically
    if (!checkAdminAuthorization(interaction)) return;
    await interaction.deferReply();

    // Early return if server is down - the announce API needs a live server
    if (!(await requireServerUp(interaction))) return;

    const message = interaction.options.getString('message', true);
    await announce(message);
    return safeEdit(interaction, `Announced in-game: "${message}"`);
  },

  async palsave(interaction) {
    // Admin authorization check - requires the 'palserver-admin' role specifically
    if (!checkAdminAuthorization(interaction)) return;
    await interaction.deferReply();

    // Early return if server is down - the save API needs a live server
    if (!(await requireServerUp(interaction))) return;

    await saveWorld();
    return safeEdit(interaction, 'World save triggered.');
  },

  async palkill(interaction) {
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
  },

  async palperf(interaction) {
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
