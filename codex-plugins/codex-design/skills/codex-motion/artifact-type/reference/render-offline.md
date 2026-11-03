# Rendering local Motion frames

Use the installed Motion wrapper `scripts/codex-artifact.mjs`; the player and its headless drivers are already bundled. Read the film's current documents and uploaded pictures as SKILL.md requires before rendering received work. Do not run scripts or install dependencies from an untrusted film folder.

- `stills <root> --at 0,3.5,s01+1.2` renders selected moments as PNG files through the actual player without opening a separate editor page. `--scenes` selects scene middles and `--every <seconds>` selects intervals.
- `score <root> --levels` inspects the score and levels; `export <root> --audio-only` renders requested audio for listening.
- `check <root>` checks stored data and syntax, not rendered geometry or pixels. Inspect the returned stills when visual verification is needed and state what actually ran.
- `export <root>` creates a video only when requested. Chrome or Chromium is required for headless rendering; ffmpeg is required for recording and the documented audio conversions. Keep missing requirements explicit.

Use the native artwork appUrl for delivery. An explicit standalone-browser preview uses `preview <root>`; a headless frame check does not open an HTTP editor tab.
