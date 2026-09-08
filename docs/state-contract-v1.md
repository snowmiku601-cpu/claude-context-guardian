# State Contract v1 (Guardian → Overlay)

This document is the **entire** public data dependency of the Liquid Overlay.
The overlay is a read-only consumer of Guardian per-session state files and
nothing else.

## Guarantees

- The overlay **never** reads Claude transcripts.
- The overlay **never** reads `~/.claude/settings.json` or any Claude config.
- The overlay performs **no network I/O**.

## Location

Guardian state directory: `~/.claude/guardian/state/` (exactly as configured
by `stateDir` in Guardian's `config.json`). One JSON file per session:

    <stateDir>/<session_id>.json

## File semantics (written by Guardian)

- Guardian writes atomically: a unique `*.tmp` file in the same directory,
  then a rename over the target. `*.tmp` files are never valid state.
- A per-session `.lock` file exists transiently while Guardian writes; it is
  not part of this contract and readers must ignore it.
- The contract version is `1`.
- Denominator internals are owned by Guardian core; the overlay never needs
  to know how `last_pct` was computed (effective-window resolution, pins,
  fail-closed rules are all Guardian-side concerns).

## Required fields (v1)

The overlay's contract consists of **exactly three required fields**. Every
other field present in the file is optional, ignored by the overlay, and
treated as forward-compatible extension data:

| Field | Type | Validation |
|---|---|---|
| `session_id` | string | non-empty |
| `last_pct` | number \| null | null, or finite within 0..100 (out-of-range → invalid sample, never clamped) |
| `updated_at` | ISO-8601 UTC string | must parse as a round-trip date/time |

A file that is unreadable, malformed, missing a required field, or violating
a validation rule yields an **invalid sample**: the overlay treats the file
as absent (dim display), never crashes, never guesses.

## Semantics

- `last_pct` — the most recently sampled context-usage percentage
  (0–100). `null` means "no valid sample since the last reset" (e.g. after a
  compact): the overlay shows a dim **awaiting** state rather than jumping to
  0.
- `updated_at` — when that sample was recorded. The overlay treats a file as
  **stale** when `updated_at` is older than a configurable window (default
  15 minutes). A stale session is displayed dimmed and never wins selection
  against a fresher one.
- A timestamp implausibly far in the future (more than 5 minutes ahead of the
  reader's clock) is treated as invalid for selection so clock skew cannot
  capture the display.

## Multi-session policy (v1)

When several non-stale sessions exist, the overlay displays the session with
the **most recently parsed `updated_at`**. A small dot indicator appears when
two or more sessions are non-stale. There is no session picker.

## File-sharing / reading rules (implementations)

- Open with `FileShare.ReadWrite | FileShare.Delete` equivalent so a
  concurrent Guardian atomic replacement is never blocked or corrupted by the
  overlay.
- Open → read → close promptly in a single call; tolerate partial/failed
  reads as invalid samples.
- Directory events (Created/Changed/Renamed/Deleted/Error) are **only
  invalidation hints**: debounce, then rescan the whole directory, parse
  complete `.json` files, and re-select the winner by parsed `updated_at`.
  Never derive correctness from event ordering or event type. Keep a slow
  periodic sweep (default 30 s) as overflow/staleness recovery.
