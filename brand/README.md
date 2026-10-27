# Depleted brand assets

Logo "G1": a gold hourglass, top empty, cracked through, on an obsidian macOS squircle.

- `depleted-icon.svg` — 1024 px app icon master (64 px and up)
- `depleted-icon-small.svg` — 16/32 px master with a wider crack and no bevel
- `depleted-menubar-template.svg` — 18 pt menu bar glyph (black on transparent)

Generated files used by the build:

- `build/icon.iconset/` → `build/icon.icns` (`iconutil -c icns build/icon.iconset -o build/icon.icns` on a Mac)
- `build/icon.png` — 1024 px, for other platforms and the README
- `resources/tray/trayTemplate.png` / `@2x` — menu bar template images
- `build/background.png` / `@2x` — DMG window background

Colours: background #2e2d35 → #08080a; gold #fff0bd → #e8bd62 → #b07a26; sand #ffb347 → #cf5f17.
