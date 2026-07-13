# Palworld Discord Bot

A private Discord bot that lets a trusted role start, stop, and reboot your own **Palworld** dedicated server from Discord. This is designed for players that use the Palworld dedicated server on their own machine, and want friends to be able to start or stop it without the host being around. As long as the PC is on and this app is running, your night shift friends can catch up on the grind.

This isn't a public bot you invite; it's code you run on the PC that hosts your server.

---

## Commands

All commands require the `palserver` Discord role.

| Command | What it does |
|---|---|
| `/palstatus` | Show server state + player count |
| `/palplayers` | List connected players |
| `/palstart` | Start the server |
| `/palstop` | Gracefully stop (only when 0 players online) |
| `/palbounce` | Graceful stop, wait, then restart — a clean reboot |
| `/palhelp` | List all commands |

It also **auto-stops** the server after it's been empty for a while, and shows live server status as the bot's Discord presence.

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

1. **Download** `palworld-discord-bot.exe` from the [Releases](../../releases) page and drop it in a folder.
2. **Create a `.env`** in that **same folder**: copy [`.env.example`](.env.example), rename it to `.env`, and fill in your values (Discord token, server path, REST API login). `.env.example` documents every setting.
3. **Run it** — double-click the exe. A window opens and stays open; the bot logs in and registers its commands automatically.

That's it. To update, download a newer exe and replace the old one — your `.env` stays put.

> If the window flashes and closes, you're missing a `.env` next to the exe. The bot now prints a clear message telling you so.

Your server path goes in `.env` like this:
```
START_CMD="C:\Program Files (x86)\Steam\steamapps\common\PalServer\PalServer.exe" -EpicApp=PalServer -USEALLAVAILABLECORES -NoAsyncLoadingThread
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
npm run build   # -> dist/palworld-discord-bot.exe
```
Cut a release: push a `v*` tag and GitHub Actions builds the exe and attaches it to a Release.
```bash
git tag v1.1.0 && git push origin v1.1.0
```
