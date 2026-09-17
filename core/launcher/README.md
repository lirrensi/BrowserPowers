# launcher — zero-window daemon spawn (Windows)

`launcher.exe` is a tiny GUI-subsystem binary: `CreateProcess(CREATE_NO_WINDOW)`.
`bp start` uses it so the daemon never flashes a console window.

## The binary is NEVER committed

Build it locally (needs Go, one command):

```bash
cd core/launcher
go build -trimpath -ldflags="-H windowsgui" -o launcher.exe .
```

`-trimpath` strips your absolute source path from DWARF debug info —
without it the binary leaks your username into git. Verify:

```bash
node -e "const b=require('node:fs').readFileSync('launcher.exe');console.log(b.indexOf(Buffer.from('Users'))===-1?'clean':'LEAKED')"
```

## Without it

The daemon falls back to direct spawn (`detached: true, windowsHide: true`).
Works, but a console may flash on some setups.
