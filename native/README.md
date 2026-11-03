# depleted-capture

The native helper Depleted runs on macOS for everything video:

- **record**: captures the game window and game audio with ScreenCaptureKit, and encodes
  H.264 (or HEVC) on the hardware encoder through AVAssetWriter, straight to `.mp4`
- **buffer**: the same capture into a rolling buffer kept in memory (the last 90 s by default, as
  ~1 s fragmented-MP4 segments, older ones deleted). `start <path>` on stdin opens a
  recording that begins with everything in the buffer, `stop` finishes it (rewritten as a
  plain MP4 from zero, no re-encode) and keeps buffering, `quit` exits. This is the
  pre-roll: a key or pull is on video from before the app read the line that started it.
- **trim**: cuts a recording to the key without re-encoding (AVAssetExportSession passthrough)
- **thumbnail**: grabs a frame for the recording list (AVAssetImageGenerator)

The app spawns it as a child process and reads one JSON event per line from its stdout
(`buffering`, `started`, `stopped`, `error`, `done`). Sending `stop` on stdin, closing stdin, or
SIGTERM all stop a recording cleanly. See `src/main/recorder/NativeCaptureRecorder.ts`.

Requires macOS 13 (Ventura) or later.

## Build

```bash
npm run build:native          # → native/bin/depleted-capture (arm64)
```

## Try it by hand

```bash
native/bin/depleted-capture windows
native/bin/depleted-capture record --output /tmp/test.mp4   # type "stop" + Enter to finish
native/bin/depleted-capture buffer --buffer-secs 30
#   then type "start /tmp/pull.mp4", wait, "stop", and "quit"
native/bin/depleted-capture thumbnail --input /tmp/test.mp4 --output /tmp/test.jpg
```

The first run from Terminal asks for Screen Recording permission for Terminal. Inside
the app, the permission belongs to Depleted.
