# Palworld Discord Bot (discord.js) – Private Server Start/Stop Control + Auto-Stop

## Overview
This is NOT a public bot; it's the code for a private bot you'll create for yourself to run on your own PC to manage your Palworld server. This bot allows a trusted Discord role to **start** or **gracefully stop** a Steam-based Palworld dedicated server via Palworld's REST API. You'll want this to run on Windows startup in most cases, but I didn't cover that in the scope of this project. If you end up using my bot, that will be the easy part for you.

---

## Features
- `/palstatus` – Show server state + player count
- `/palplayers` – List connected players (clean names only)
- `/palstart` – Launch server + show status when successful
- `/palstop` – Save world → re-check players → graceful shutdown (only if players == 0)
- `/palbounce` – Graceful stop, wait, then restart the server (clean reboot)
- `/palhelp` – Show all available commands
- **Auto-monitor** – Background monitoring stops server after 2 consecutive empty checks
- **Discord Status Integration** – Bot's Discord presence shows real-time server status
- **Standalone .exe** – Download a prebuilt Windows executable; no Node install required

---

## Quick Start (Prebuilt .exe)

The easiest way to run the bot — no Node.js install needed.

1. Download `palworld-discord-bot.exe` from the [Releases](../../releases) page.
2. Put it in a folder of your choice.
3. Copy `.env.example` to a file named `.env` in that **same folder** and fill in your values (see [Environment Variables](#3-environment-variables-env)).
4. Double-click the exe (or run it from a terminal). It logs in, registers its slash commands automatically, and starts monitoring.

That's it — the exe reads `.env` from whatever folder it's launched in. To update, download the newer exe and replace the old one; your `.env` stays put.

> The exe bundles its own Node.js runtime, so it's ~95 MB. It still shells out to Windows PowerShell to start your server, so it's Windows-only.

---

## Setup (From Source)

### 1. Prerequisites
- **Windows 10/11**
- **Node.js 18+**
- Palworld server installed (Steam or standalone)
- REST API enabled in your Palworld config:
  ```ini
  RESTAPIEnabled=True
  RESTAPIPort=8212
  AdminPassword=your_admin_password
  ```
  **Note:** REST API uses the AdminPassword for authentication, not a separate REST password.
  **Important:** Bind to `127.0.0.1` or firewall to local machine.

### 2. Configure Server Executable Path
Set the direct path to your Palworld server executable with engine optimizations:

**Example for Steam installation:**
```
START_CMD="C:\Program Files (x86)\Steam\steamapps\common\PalServer\PalServer.exe" -EpicApp=PalServer -USEALLAVAILABLECORES -NoAsyncLoadingThread
START_CWD=C:\Program Files (x86)\Steam\steamapps\common\PalServer
```

**All server configuration** (ports, passwords, REST API settings) is still handled by your `PalWorldSettings.ini` file!

### 3. Environment Variables (`.env`)
Copy `.env.example` to `.env` and fill in your specific values:

The `.env.example` file contains comprehensive documentation for all settings including:
- Discord bot credentials and server configuration
- Palworld REST API connection details  
- Server management commands and timing
- Auto-monitoring intervals and thresholds

### 4. Install & Run
```bash
yarn install
yarn dev
```

The bot **auto-registers its slash commands on startup**, so there's no separate deploy step. `yarn deploy-commands` still exists if you ever want to register commands manually without running the bot.

---

## Building & Releasing

### Build the .exe locally
```bash
yarn build
```
Produces `dist/palworld-discord-bot.exe` (via [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) in SEA mode, targeting Node 22 / Windows x64). Ship it alongside a `.env` file.

### Cut a release (automated)
Pushing a version tag triggers a GitHub Actions workflow (`.github/workflows/release.yml`) that builds the exe on a Windows runner and publishes it to a GitHub Release:
```bash
git tag v1.1.0
git push origin v1.1.0
```
A few minutes later, `palworld-discord-bot.exe` is attached to the release, ready to download.

---

## Command Permissions
- **All commands require the `palserver` role** - this is an admin-only bot for trusted users.

---

## Command Flow

### `/palstart`
1. Checks if server is running via REST `/info`
2. If already up → shows current status with "Server is already UP" message  
3. If down → runs server executable, polls until server responds
4. On successful start → displays server status with player count, uptime, and version

### `/palstop`
1. Checks if server is running
2. Gets player list → if >0 players, aborts
3. Saves world (`/save`)
4. Re-checks player list after 1.5 second delay
5. If still 0 players → graceful shutdown with 2-second delay

### `/palbounce`
1. Runs the full `/palstop` graceful-stop sequence
2. If the stop is aborted (players online or server already down) → bounce aborts, server is **not** restarted
3. On a clean stop → waits (default 15s, configurable via `BOUNCE_DELAY_MS`)
4. Starts the server back up and shows status — a combined clean reboot

### Auto-Monitor Background Process
1. Runs automatically every 10 minutes (configurable, minimum 1 minute)
2. Checks server status and player count
3. Updates Discord bot status in real-time ("ServerName is UP/DOWN")
4. Tracks consecutive empty server checks
5. After 2 consecutive empty checks (configurable) → triggers graceful shutdown
6. Respects concurrent operation locks to prevent conflicts
7. Automatically pauses monitoring when server is known to be down

---

## Security Notes
This bot implements some security measures:

- **API Security**: Never expose Palworld REST API to the public internet
- **Network Security**: Keep REST bound to localhost and use bot as the only interface
- **Port Security**: Only forward game ports (8211/UDP, often 27015/UDP) for player connections
- **Input Sanitization**: All user inputs and API responses are sanitized to prevent injection attacks
- **Error Handling**: Sensitive information is filtered from error messages
- **Role-Based Access**: All commands require the `palserver` role for authorization
- **Process Security**: Server commands use parameterized execution to prevent shell injection

---

## Files

### Core Files
- `deploy-commands.js` – Optional manual slash-command registration
- `src/index.js` – Discord bot main file with command handlers (auto-registers commands on startup)
- `src/commands.js` – Slash command definitions (single source of truth)
- `src/palworld.js` – Palworld REST API client
- `src/process.js` – Server management (executable/Windows service)
- `src/monitor.js` – Background monitoring and Discord status updates

### Configuration & Security
- `src/config/index.js` – Centralized configuration management with validation
- `src/middleware/auth.js` – Role-based authorization middleware
- `src/utils/security.js` – Input sanitization and security utilities
- `src/utils/logger.js` – Structured logging system
- `src/utils/async.js` – Shared sleep/poll helpers

### Build & CI
- `.github/workflows/release.yml` – Builds the exe and publishes a Release on version-tag push

### Environment & Documentation
- `.env.example` – Template environment file with comprehensive documentation
- `README.md` – This file

## Configuration Details

### Auto-Monitor Settings
- **`MONITOR_INTERVAL_MS`** (default: 600000 = 10 minutes)  
  How often to check server status. **Minimum: 60000ms (1 minute)** to prevent API rate limiting.

- **`EMPTY_CHECK_THRESHOLD`** (default: 2)  
  Number of consecutive empty checks before auto-stop. With 10-minute intervals = 20 minutes total.

**Note**: Configuration includes built-in validation with minimum/maximum values to ensure system stability and security.
