# depleted-capture

The native helper Depleted runs on macOS for everything video:

- **record**: captures the game window and game audio with ScreenCaptureKit, and encodes
  H.264 (or HEVC) on the hardware encoder through AVAssetWriter, straight to `.mp4`
- **trim**: cuts a recording to the key without re-encoding (AVAssetExportSession passthrough)
- **thumbnail**: grabs a frame for the recording list (AVAssetImageGenerator)

The app spawns it as a child process and reads one JSON event per line from its stdout
(`started`, `kept`, `stopped`, `error`, `done`). Sending `stop` on stdin, closing stdin, or
SIGTERM all stop a recording cleanly. See `src/main/recorder/NativeCaptureRecorder.ts`.

## Rolling buffer

`record --buffer-secs 60` holds only the last 60 seconds. AVAssetWriter writes fragmented
MP4 in 2 second segments, which wait in `<output>.buffer/` and are deleted once they're
older than the buffer. `keep` on stdin writes the buffer into the output file and records
on (the `kept` event says how many seconds before the `keep` the file starts). Stopping
without `keep` saves nothing. Depleted arms this way on entering a dungeon, so waiting for
the key costs a flat 60 seconds of disk (about 600 MB at 80 Mbps) instead of a growing file.

Requires macOS 13 (Ventura) or later.

## Build

```bash
npm run build:native          # → native/bin/depleted-capture (arm64)
```

## Try it by hand

```bash
native/bin/depleted-capture windows
native/bin/depleted-capture record --output /tmp/test.mp4   # type "stop" + Enter to finish
native/bin/depleted-capture record --output /tmp/test.mp4 --buffer-secs 10   # "keep", then "stop"
native/bin/depleted-capture thumbnail --input /tmp/test.mp4 --output /tmp/test.jpg
```

The first run from Terminal asks for Screen Recording permission for Terminal. Inside
the app, the permission belongs to Depleted.
