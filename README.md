# Palworld Discord Bot

A private Discord bot that lets a trusted role start, stop, and reboot your own **Palworld** dedicated server from Discord. This is designed for players that use the Palworld dedicated server on their own machine, and want friends to be able to start or stop it without the host being around. As long as the PC is on and this app is running, your night shift friends can catch up on the grind.

This isn't a public bot you invite; it's code you run on the PC that hosts your server.

---

## Commands

All commands require the `palserver` Discord role. Commands marked *(admin)* require the `palserver-admin` role instead (configurable via `PALSERVER_ADMIN_ROLE_NAME`); admins can also use all base commands.

| Command | What it does |
|---|---|
| `/palstatus` | Show server state + player count |
| `/palplayers` | List connected players |
| `/palstart` | Start the server |
| `/palstop` | Gracefully stop (only when 0 players online) |
| `/palbounce` | Graceful stop, wait, then restart — a clean reboot |
| `/palhelp` | List all commands |
| `/palannounce` | Broadcast a message to in-game chat *(admin)* |
| `/palsave` | Force a world save *(admin)* |
| `/palkill` | Stop the server even with players online — saves and shuts down cleanly, force-kills only if that fails *(admin)* |
| `/palperf` | Server FPS trend from the current uptime window *(admin)* |

It also **auto-stops** the server after it's been empty for a while, and shows live server status as the bot's Discord presence.

### Announcements

Set `ANNOUNCE_CHANNEL_ID` and the bot posts a short line there whenever the server is started, stopped, rebooted or killed, when it auto-stops an empty server, and when a scheduled restart runs.

If that's the same channel your commands are run in, the bot **skips** the announcement for those commands — the command's own reply already told that channel what happened, so a second message is just a duplicate. Point `ANNOUNCE_CHANNEL_ID` at a *separate* channel to get both. Tray actions and the background monitor have no channel of their own, so they always announce.

### How stopping works

`/palstop` and `/palbounce` are polite: they refuse while anyone is online, save the world, wait `SAVE_SETTLE_MS` for that save to land on disk, and only then shut the server down. If someone joins during that settle window the stop aborts.

`/palkill` is the override. It never refuses — it works with players connected — but it is not a blind kill either: it saves and asks the server to shut down first, waits up to `STOP_TIMEOUT_MS` for it to actually exit, and only force-kills if that doesn't take (or if the server's REST API is already wedged, in which case it kills immediately). "Actually exited" means the REST API has gone quiet *and* no server process is left running.

> Force-killing works by image name, so **`START_CMD` must point at `PalServer-Win64-Shipping.exe`**, not the top-level `PalServer.exe` launcher — killing the launcher would leave the real server running. The bot refuses that configuration rather than pretending the kill worked.

### Scheduled auto-restart *(optional, off by default)*

Set `AUTO_RESTART_ENABLED=true` in your `.env` and the bot reboots the server every `RESTART_INTERVAL_HOURS` of uptime (default 6, minimum 1). It warns in-game at **30, 20, 10, 5, 3, 2 and 1 minutes** before the restart, then saves the world and shuts the server down cleanly — with players online if need be — force-killing it only if the clean shutdown doesn't take. The warning schedule is fixed. A restart that fails isn't retried until a full interval has passed.

### Performance log

While the server is up, every monitor poll (~10 minutes) appends one row to `logs/fps.csv` — timestamp, uptime, server FPS and player count, all read from the same sample. The log covers the server's **current uptime window only**: whenever the uptime counter goes backwards the bot knows the server restarted and starts the file fresh, so the rows always describe one continuous session. It's plain CSV — copy it out and open it in a spreadsheet whenever you want to plot it yourself.

`/palperf` reads that file and summarises it in Discord: average, min and max FPS, average and peak players, and — once there's more than two hours of data — the first hour compared against the most recent one. That comparison is the point. FPS falling as players join is ordinary load; FPS falling while the player count stays flat is what a memory leak looks like.

---

## Install

You need: **Windows 10/11**, a Palworld dedicated server, its REST API enabled, and a Discord bot (with a `palserver` role for your admins).

Enable the REST API in your Palworld settings:
```ini
RESTAPIEnabled=True
RESTAPIPort=8212
AdminPassword=your_admin_password
```
> The REST API authenticates with your `AdminPassword`. Keep it bound to `127.0.0.1` — never expose it to the internet.

Then:

1. **Download** `exos-palworld-bot.exe` from the [Releases](../../releases) page and drop it in a folder.
2. **Create a `.env`** in that **same folder**: copy [`.env.example`](.env.example), rename it to `.env`, and fill in your values (Discord token, server path, REST API login). `.env.example` documents every setting.
3. **Run it** — double-click the exe. It runs silently in the background with a **system tray icon** (no console window); the bot logs in and registers its commands automatically. Right-click the tray icon to open logs, start/stop/reboot the server, force-kill it, or quit.

That's it. To update, download a newer exe and replace the old one — your `.env` stays put.

> If the window flashes and closes, you're missing a `.env` next to the exe. The bot now prints a clear message telling you so.

Your server path goes in `.env` like this — point it at the **Shipping** binary, not `PalServer.exe` (see [How stopping works](#how-stopping-works)), and wrap the whole value in single quotes:
```
START_CMD='"C:\Program Files (x86)\Steam\steamapps\common\PalServer\Pal\Binaries\Win64\PalServer-Win64-Shipping.exe" -USEALLAVAILABLECORES -NoAsyncLoadingThread'
START_CWD=C:\Program Files (x86)\Steam\steamapps\common\PalServer
```

---

## For developers

Run from source (Node.js 18+):
```bash
npm install
npm run dev
```
Build the exe yourself:
```bash
npm run build   # -> dist/exos-palworld-bot.exe
```
Cut a release: push a `v*` tag and GitHub Actions builds the exe and attaches it to a Release.
```bash
git tag v1.1.0 && git push origin v1.1.0
```
