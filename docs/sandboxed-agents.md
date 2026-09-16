# BrowserPowers in a sandbox / split FS (WSL, VM, container)

Some agent sandboxes reap child processes per shell call. Others run the caller
on a different filesystem than the core (Windows host ↔ WSL, VM, container).
In both cases screenshots via `filePath` alone break — and daemons die.

## 1. Share ONE dir on ONE mount

Set `BROWSERPOWERS_HOME` to the SAME underlying directory on both sides.
Same text is NOT enough — must be same mount.

```bash
# host (persistent): owns daemon
export BROWSERPOWERS_HOME=/absolute/shared/browserpowers
browserpowers serve
```

```bash
# sandboxed caller: same dir, no auto-start games
export BROWSERPOWERS_HOME=/absolute/shared/browserpowers
browserpowers status
browserpowers doctor
```

PowerShell:

```powershell
$env:BROWSERPOWERS_HOME = 'C:\path\to\shared\browserpowers'
browserpowers status
```

What lives under it: `config/config.yaml`, `audit/`, `daemon.pid`.
Screenshots still go to OS temp — **use base64/image block, not filePath**,
when caller FS differs (MCP `screenshot` always sends both).

## 2. Health = daemon + heartbeat

```bash
browserpowers status --json
browserpowers doctor
GET /api/health → { status, browsers, uptime, wsConnected }
```

Healthy = daemon responds + ≥1 browser + heartbeat <60s.
Stale heartbeat = reload extension, check WS URL + API key.

## 3. Verify split setup

1. `status` from sandboxed call reaches SAME daemon (PID unchanged).
2. `screenshot` without filepath prints base64 JSON — copy works across FS.
3. `doctor` shows `home writable: ok` with `BROWSERPOWERS_HOME=...`.
