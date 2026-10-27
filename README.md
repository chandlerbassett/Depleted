# Depleted.app

**A Mythic+ recorder for World of Warcraft on macOS.**

Automatically records your World of Warcraft **Mythic+ keys** on macOS, syncs the video with
the combat log, and puts the moments that matter on a timeline: boss kills, wipes, party
deaths, interrupts. Click a marker to jump straight to it.

The goal is a native-feeling macOS take on what [Warcraft Recorder](https://warcraftrecorder.com/)
does on Windows. Arena recording (2v2, 3v3, Solo Shuffle) from the original project still works.

> 🚧 **Early and in active development.** Mythic+ support is new and hasn't yet been
> verified against a full real-world key. Expect rough edges.

---

## What it does today

**Mythic+**
- Starts recording when the key is activated (`CHALLENGE_MODE_START`) and stops a few seconds
  after it ends (`CHALLENGE_MODE_END`), so the completion screen is included
- Marks every boss pull as a **kill** or **wipe**
- Marks **party deaths**, each with a recap of the last 10 seconds of damage taken
- Marks **interrupts** and counts them per player
- Saves each run with its key level, affixes, outcome (**completed / depleted / abandoned**),
  timer and rating change
- If you leave the dungeon and don't return within 3 minutes, the key is saved as
  *abandoned* rather than thrown away

**Arena** (from the original project)
- 2v2, 3v3 and Solo Shuffle, with CC, defensives, interrupts, trinkets, deaths, meters and a
  "mistakes" panel

Recordings appear in the app under the **Mythic+** tab (or the matching arena tab). Open one
to watch it with its event timeline.

## Roadmap

1. ~~Record M+ keys on the existing capture pipeline~~ ✅
2. Polish the M+ view: run list with timer/upgrade level, per-boss breakdown, damage meters
3. Replace capture with native **ScreenCaptureKit + VideoToolbox** (hardware H.264/HEVC,
   lower CPU on long keys, a pre-roll buffer so the countdown isn't missed)
4. "Good / bad moment" detection: avoidable damage, missed kicks, defensive usage on deaths

---

## Requirements

- macOS 11 (Big Sur) or later, Apple Silicon or Intel
- [FFmpeg](https://ffmpeg.org): `brew install ffmpeg` (used to trim recordings and make thumbnails)
- Screen Recording permission (the app prompts you during onboarding)
- **Advanced Combat Logging** turned on in WoW (see below)

The codebase still builds for Windows, but macOS is the focus and the only platform being tested.

---

## Install (from source)

There are no published releases of this version yet. To build and run it locally:

```bash
npm install
npm run dev              # run with hot reload
npm run build:mac        # or build a .dmg into dist/
```

The build isn't code-signed, so the first time you open a `.dmg` build, clear the quarantine flag:

```bash
sudo xattr -cr "/Applications/Depleted.app"
```

> ⚠️ **After every rebuild you must re-grant Screen Recording permission.** macOS ties the
> permission to the app's code signature, which changes with each build:
> 1. **System Settings → Privacy & Security → Screen Recording**
> 2. Select the app and click **–** to remove it (just toggling it off isn't enough)
> 3. Quit and relaunch the app. It re-adds itself, and you can then turn the toggle **on**

---

## In-game setup

### Advanced Combat Logging (required)

**Esc → Options → System → Network → check "Advanced Combat Logging"**

You only need to set this once. WoW writes combat logs to `_retail_/Logs/WoWCombatLog-*.txt`,
and the app follows the newest one automatically.

### Companion addon (recommended)

The app ships with a small addon, **ArenaRecorderCompanion** (name kept from the original
project), that tells the recorder which
character you're playing. Install it from the onboarding screen or **Settings → Addon**, or
copy `addon/ArenaRecorderCompanion` into
`/Applications/World of Warcraft/_retail_/Interface/AddOns/`, then `/reload` in game.

---

## How recording works

1. Open the app before you start the key (or queue for arena)
2. The app watches the combat log and starts recording on its own
3. When the key or match ends, the app stops recording, trims the video, makes a thumbnail
   and adds the run to the list
4. Click a recording to watch it, and click timeline markers to jump to them

---

## Settings

| Setting | Description |
|---------|-------------|
| WoW Path | Your WoW installation folder (auto-detected) |
| Storage Path | Where recordings are saved (default: `~/Movies/Depleted`) |
| Video Bitrate | Recording quality in kbps (default: 8000) |
| FPS | Frames per second (default: 30) |
| Resolution | Output resolution, or `native` to match your display |
| Capture Window | Which window to record. Auto-detects WoW by default |
| Auto Cleanup | Delete old recordings after N days or once storage passes N GB |

Game audio is captured automatically through system loopback, so no extra audio tools are needed.

---

## Known limitations

- **Big files on long keys.** At the default 8 Mbps, a 35-minute key is roughly 2 GB. Capture
  currently uses Chromium's MediaRecorder with software VP8/WebM encoding, which also costs CPU
  while WoW is running. Step 3 of the roadmap replaces this.
- **The first few seconds of a key can be missed**, because recording starts once the app
  reads the key-start line from the log.
- **No damage-done meter for M+ yet.** The parser currently only tracks damage aimed at players
  (an arena-era filter).
- **The M+ log format hasn't been checked against a real Midnight key yet.** The test log is
  synthetic.
- The build isn't code-signed (see Install above).

---

## Development

```bash
npm install
npm run dev          # dev mode with hot reload
npm test             # vitest
npm run lint
npm run build        # production build (no packaging)
npm run build:mac    # macOS .dmg
```

### Project structure

```
src/
  main/
    combatlog/   — log watcher + parser (arena and Mythic+ events)
    recorder/    — capture, RecorderStateMachine (arena), MythicPlusStateMachine
    storage/     — trimming, thumbnails, metadata, recordings library
    ipc/         — main ↔ renderer channels
  renderer/src/  — Vue 3 + Pinia UI
  shared/        — types and constants shared by main and renderer
addon/
  ArenaRecorderCompanion/  — WoW addon (Lua)
tests/
  fixtures/      — sample combat logs (2v2, Solo Shuffle, Mythic+)
```

---

## Credits

Depleted is built on [**WoW Arena Recorder**](https://github.com/krav559108/wowArenaAnalyzer)
by Aleksandr Kravchenko (MIT licensed), which provides the capture pipeline, combat log
parser, arena analysis and playback UI. Huge thanks to them. If you find the arena side useful,
consider supporting the original project.
