# depleted-capture

The native helper Depleted runs on macOS for everything video:

- **record**: captures the game window and game audio with ScreenCaptureKit, and encodes
  H.264 (or HEVC) on the hardware encoder through AVAssetWriter, straight to `.mp4`
- **trim**: cuts a recording to the key without re-encoding (AVAssetExportSession passthrough)
- **thumbnail**: grabs a frame for the recording list (AVAssetImageGenerator)

The app spawns it as a child process and reads one JSON event per line from its stdout
(`started`, `stopped`, `error`, `done`). Sending `stop` on stdin, closing stdin, or
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
native/bin/depleted-capture thumbnail --input /tmp/test.mp4 --output /tmp/test.jpg
```

The first run from Terminal asks for Screen Recording permission for Terminal. Inside
the app, the permission belongs to Depleted.
