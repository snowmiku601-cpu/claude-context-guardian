# Sounds directory (source repo)

**No audio files are shipped with this project.**

Guardian plays a short sound when your context usage crosses a threshold.
Because audio files are personal, you provide your own after installing:

1. Copy your audio files into `~/.claude/guardian/sounds/` (created by the
   installer).
2. Make sure the filenames match your `config.json` `sounds` section. The
   installer default expects:
   - `dung.mp3` — 70% threshold
   - `getout.mp3` — 80% threshold
   - `fa.mp3` — 90% threshold

Any format Windows MCI can play (`.mp3`, `.wav`, …) works; playback goes
through `winmm.dll!mciSendString` from `notify.ps1`. If a file is missing or
unreadable, the toast still shows — sound failures are silently tolerated and
never block Claude Code.

Threshold percentages and file paths are configurable in
`~/.claude/guardian/config.json` (see `config.example.json`).

> This repository never contains your audio assets: `.gitignore` excludes
> `sounds/*.mp3` and `sounds/*.wav`, and the privacy scanner blocks binary
> audio from entering source control.
