# Building FileDrop Installers

---

## Windows

### What you need (on a Windows machine)

1. **Node.js 20 LTS** — nodejs.org
2. **Inno Setup 6** — jrsoftware.org/isinfo.php

### Step 1 — Build the exes

Run from the repo root:

```bat
scripts\build.bat
```

Produces:
```
build\FileDrop-Jason-Setup.exe
build\FileDrop-Editor-Setup.exe
```

### Step 2 — Compile the installers

Open Inno Setup Compiler:

1. File → Open → `installer-scripts\FileDrop-Jason.iss` → F9
2. File → Open → `installer-scripts\FileDrop-Editor.iss` → F9

Output: `build\FileDrop-Jason-Installer.exe` and `build\FileDrop-Editor-Installer.exe`

### What the Windows installer does

| Step | What happens |
|------|-------------|
| Double-click installer | Standard Windows setup wizard |
| Install | Copies exe to `C:\Program Files\FileDrop-Jason\` |
| Post-install | Runs `--install` → registers Windows service |
| Finish | Opens `http://localhost:5050/setup` in browser |
| Uninstall | Runs `--uninstall`, removes files |

---

## macOS

### What you need (on a Mac)

1. **Node.js 20 LTS** — nodejs.org

### Step 1 — Build the macOS binaries

```bash
cd build
npm run pkg:all-mac
```

Produces (in `build/`):
```
FileDrop-Jason-mac-x64      ← Intel Macs
FileDrop-Jason-mac-arm64    ← Apple Silicon (M1/M2/M3)
FileDrop-Editor-mac-x64
FileDrop-Editor-mac-arm64
```

### Step 2 — Distribute

**For Jason (sender):**
1. Copy `FileDrop-Jason-mac-x64` (or arm64) into the same folder as `FileDrop-Jason-Mac-Install.command`
2. Double-click `FileDrop-Jason-Mac-Install.command`
3. Terminal opens, installs the binary and registers the launchd service
4. Browser opens to `http://localhost:5050/setup`

**For the editor (receiver):**
1. Copy `FileDrop-Editor-mac-x64` (or arm64) + `FileDrop-Editor-Mac-Install.command` to a folder
2. Send that folder to your editor
3. They double-click `FileDrop-Editor-Mac-Install.command`

### What the macOS installer does

| Step | What happens |
|------|-------------|
| Double-click `.command` | Terminal opens, runs script |
| Auto-detects Apple Silicon vs Intel | Picks the right binary |
| Copies binary to `~/Applications/FileDrop/` | |
| Runs `--install` | Writes launchd plist to `~/Library/LaunchAgents/` |
| Service auto-starts on login | Crash recovery built in |
| Logs | `~/Library/Logs/FileDrop/filedrop.log` |
| Uninstall | Double-click `FileDrop-Mac-Uninstall.command` |

### Note on Gatekeeper

macOS will quarantine downloaded binaries. The install script calls `chmod +x` automatically. If Gatekeeper blocks the binary, right-click → Open the first time to bypass (or run `xattr -d com.apple.quarantine <binary>` in Terminal).

---

## Manual pick mode (Available tab)

To enable the Available tab so your editor can browse and select files:

In the editor's `filedrop.config.json`, set:

```json
{
  "receiver": {
    "autoDownload": false
  }
}
```

When `autoDownload` is `false`:
- Incoming files appear in the **Available** tab instead of downloading automatically
- The editor sees a folder tree of everything the sender has uploaded
- They check the files/folders they want → click **Download Selected**
- Selected files are queued and appear in the **Transfers** tab with live progress
