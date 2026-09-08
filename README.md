# Claude Context Guardian

**Unofficial community tool.** This project is not affiliated with, endorsed
by, or produced by Anthropic. "Claude" and "Claude Code" are trademarks of
their respective owner; this tool merely integrates with the local Claude Code
hook system on your own machine.

A local, offline, hook-driven context-usage guardian for Claude Code on
Windows, plus a lightweight native WPF **liquid-circle overlay** that shows
your current context usage at a glance.

- **No daemon. No polling. No network. No OCR. No Claude API calls.**
- Guardian only ever reads a **bounded tail** of the local session transcript
  (≤ 512 KB from EOF) when a hook fires.
- The overlay only ever reads Guardian's small per-session state files.
  It **never** reads transcripts, Claude settings, or anything remote.

```
Claude Code hooks (PostToolBatch / Stop / PreCompact(auto) / PostCompact)
        |
        v
   Guardian core (Node, per-session lock, bounded tail read)
        |
        v
   per-session state JSON  (~/.claude/guardian/state/<session>.json)
        |
        v
   Liquid Overlay (read-only consumer, WPF, native)
```

If the overlay crashes or is closed, Guardian alerts are unaffected — they are
separate processes with no shared runtime state.

## Status badges / measured resources

Measured on the development machine (i5-7200U, 8 GB RAM, Intel HD 620,
Windows 10 22H2) with `scripts/measure-overlay.ps1` against the real built
executable, fresh non-stale synthetic state, 15–25 s measurement window:

| Metric | Target | Measured (owner machine) |
|---|---|---|
| Overlay RAM (private working set) | ≤ 50 MB | **≈ 36–37 MB** |
| Overlay-process CPU, animated waves | preferably ≤ 3% | **≈ 6–10% of one logical processor** (accepted for this visual MVP) |
| Overlay-process CPU, static fill | preferably ≤ 3% | **≈ 0% of one logical processor** |
| Overlay-process CPU, hidden/converged | ~0–1% | **≈ 0%** (all animation self-stops) |

**CPU unit:** percentages are of **one logical processor** (process
`TotalProcessorTime` delta over wall time; calibrated with a known single-core
workload reading ≈ 99.6%). They are **not** percentages of total machine CPU.

Scope of these numbers:

- DWM/system composition cost was **not** separately attributed or measured;
  the figures cover the overlay process only.
- These are **owner-machine results** (i5-7200U / Intel HD 620), not
  universal guarantees. Layered-window composition cost varies by GPU.
- Animated waves exceed the "preferably ≤ 3%" design target on this machine;
  the owner has explicitly accepted this trade-off for the visual MVP. Users
  who need lower CPU can use the degradation ladder below (static fill
  measures 0%).

The degradation ladder remains available if a machine needs it, applied in
order (percentage text, liquid height, and threshold color remain functional
at every step):

1. 20 FPS → 15 FPS
2. two waves → one wave
3. animated wave → static liquid fill

## Support matrix

MVP support (verified on the development machine; reported elsewhere is
unverified until tested):

- Windows 10 1903+ / Windows 11, x64
- .NET Framework 4.8 runtime (preinstalled on supported Windows)
- Node.js ≥ 18 (Guardian hooks + settings mutator)
- For build-from-source install: one compatible C# compiler — the in-box
  `csc.exe` shipped with .NET Framework 4.x works (source is C# 5-compatible);
  Roslyn (VS/Build Tools) is optional.

The installer **preflight fails clearly before mutating anything** if a
prerequisite is missing.

## Sounds (bring your own)

Guardian plays a sound when context crosses 70% / 80% / 90%. **No audio files
are shipped** — place your own audio files in `~/.claude/guardian/sounds/`
after install:

- `dung.mp3` → 70% threshold (name configurable in `config.json`)
- `getout.mp3` → 80% threshold
- `fa.mp3` → 90% threshold

Any MP3/WAV the Windows MCI subsystem can play works. Default sound paths are
derived from your own home directory; see `config.example.json`.

## Metric definition

Context usage % = used context tokens divided by **Claude Code's effective
context window before auto-compact**, when that window is available from the
configured runtime values:

- used context tokens = `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens` (output tokens are excluded — the same numerator
  the Claude Code Context Usage UI uses);
- effective window = `min(CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW)` when the auto-compact window is a valid
  positive integer, otherwise just `CLAUDE_CODE_MAX_CONTEXT_TOKENS`;
- this mirrors how the Claude Code Context Usage UI computes its percentage,
  so Guardian's 70/80/90 bands line up with what the UI shows. Compatibility
  with future Claude Code versions depends on those runtime semantics
  remaining unchanged — no promise is made;
- if no valid maximum context window is configured, percentage alerts fail
  closed (an actionable one-shot diagnostic is shown; emergency compact
  alerts stay armed). No window size is hardcoded and no model name is ever
  used to infer one.

## Privacy statement

- Guardian stores per-session state locally under `~/.claude/guardian/state/`:
  session id, last percentage, token counts, timestamps. No transcript
  content, no prompt text.
- Nothing is uploaded anywhere. The only file outside the Guardian directory
  that is read is `~/.claude/settings.json` (two env values: the maximum
  context window and the auto-compact window).
- The overlay reads only Guardian state files. It cannot see transcripts.
- Uninstall removes only Guardian-owned files and hook entries; your sounds,
  state, and config are preserved by default.

## Install / uninstall (source)

```powershell
# from an elevated-free, normal user shell:
powershell -ExecutionPolicy Bypass -File scripts\install.ps1            # guardian + overlay
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Autostart # + Startup-folder shortcut
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Purge   # also remove sounds/state/logs
```

`install.ps1` backs up `~/.claude/settings.json` with a timestamp before any
change and validates the result semantically; it fails closed (restoring the
backup) on any inconsistency.

## Overlay

The overlay is a ~150 px borderless, transparent, always-on-top circle showing
the context percentage with an animated liquid fill whose height tracks usage.
Threshold colors: <70 green, 70–79.99 yellow, 80–89.99 orange, ≥90 red.
Draggable; position persists; recovers to a visible position if the saved
position is off-screen. When several Claude sessions are active it shows the
highest-risk live session (risk band first: ≥90, then ≥80, then ≥70; within
the same band the most recently updated session wins), so a fresh low-usage
session cannot hide a still-live high-pressure one. `overlay.config.example.json`
documents the small set of supported settings.

## Measurement

```powershell
powershell -ExecutionPolicy Bypass -File scripts\measure-overlay.ps1
```

Measures the real built executable (private working set, idle CPU over 30 s,
animated CPU over 30 s) against synthetic state only. Numbers are printed;
paste them into the table above.

## Documentation

- [docs/state-contract-v1.md](docs/state-contract-v1.md) — the public
  Guardian→overlay state contract (the overlay's entire data dependency).

## License

[MIT](LICENSE)
