# phantom-process-collector
Phantom answers one question: **which processes on this machine have no plausible reason to still be running?**  It detects *contextual orphans* — processes that are alive, consuming resources, and possibly communicating with external endpoints, but whose behavioral profile is inconsistent with any active user workflow.

## Setup

### Prerequisites
- [Rust / cargo](https://rustup.rs/)
- [Python 3.11+](https://www.python.org/) with [uv](https://github.com/astral-sh/uv)
- [Node.js](https://nodejs.org/) (via [fnm](https://github.com/Schniz/fnm) or installed directly)

Prerequisites can be installed using 
```
.\scripts\install-prereqs.ps1
```

### Running
```powershell
.\scripts\run.ps1
```
Open `http://localhost:5173` in a browser. To stop all services:
```powershell
.\scripts\reset.ps1
```

### Permissions
The collector reads process paths and spawn times for all running processes, which requires elevated access on Windows. There are two ways to grant this:

**Option A — Grant SeDebugPrivilege (recommended, no UAC prompts)**

This lets the scripts run in your normal terminal without a UAC prompt:

1. Press `Win + R`, type `secpol.msc`, press Enter.
2. Navigate to **Local Policies → User Rights Assignment**.
3. Double-click **Debug programs**.
4. Click **Add User or Group**, add your Windows account, click OK.
5. Log out and back in (or restart) for the policy to take effect.

After this, `run.ps1` and `reset.ps1` detect the privilege automatically and skip the UAC re-launch.

**Option B — Run as Administrator (UAC prompt each time)**

If you skip Option A, both scripts will trigger a UAC prompt and re-launch themselves elevated. Everything works the same way — you just confirm the prompt each time.

> **Note:** Without either option, the collector cannot read `exe_path` or `spawn_time` for system-owned processes, causing them to score artificially high (near 100).
