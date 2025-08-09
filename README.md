# Palworld Discord Bot (discord.js) – Safe Start/Stop Control + Auto-Monitor

## Overview
This is NOT a public bot; it's the code for a private bot you'll create for yourself to run on your own PC to manage your Palworld server. This bot allows a trusted Discord role to **start** or **gracefully stop** a Steam-based Palworld dedicated server via Palworld's REST API. You'll want this to run on Windows startup in most cases, but I didn't cover that in the scope of this project. If you end up using my bot, that will be the easy part for you.

---

## Features
- `/palstatus` – Show server state + player count
- `/palplayers` – List connected players (clean names only)
- `/palstart` – Launch server + show status when successful
- `/palstop` – Save world → re-check players → graceful shutdown (only if players == 0)
- `/palhelp` – Show all available commands
- **Auto-monitor** – Background monitoring stops server after 2 consecutive empty checks

---

## Setup

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

### 4. Install & Deploy
```bash
npm install
npm run deploy-commands
npm run dev
```

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

### Auto-Monitor Background Process
1. Runs automatically every 10 minutes (configurable)
2. Checks server status and player count
3. Tracks consecutive empty server checks
4. After 2 consecutive empty checks (20 minutes total) → triggers graceful shutdown
5. Uses same shutdown logic as manual `/palstop`
6. Respects concurrent operation locks to prevent conflicts

---

## Security Notes
- **Never** expose Palworld REST API to the public internet.
- Keep REST bound to localhost and use bot as the only interface for friends.
- Only forward **game ports** (8211/UDP, often 27015/UDP) for player connections.

---

## Files
- `deploy-commands.js` – Registers slash commands
- `src/index.js` – Discord bot main file with command handlers
- `src/palworld.js` – Palworld REST API helpers
- `src/process.js` – Start server helpers (executable or Windows service)
- `src/monitor.js` – Background monitoring and auto-stop functionality
- `.env.example` – Template environment file
- `README.md` – This file

## Auto-Monitor Configuration
The background monitor can be configured via environment variables:

- **`MONITOR_INTERVAL_MS`** (default: 600000 = 10 minutes)  
  How often to check server status

- **`EMPTY_CHECK_THRESHOLD`** (default: 2)  
  Number of consecutive empty checks before auto-stop
