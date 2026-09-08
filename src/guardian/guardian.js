#!/usr/bin/env node
/**
 * Claude Context Guardian — user-global (~/.claude/guardian)
 *
 * Transport: hook-driven transcript usage sampling. (The VS Code extension
 * does not invoke statusLine, so hooks are the metric transport; the statusLine
 * render path is kept as legacy compat for CLI/terminal usage.)
 *
 * Modes (stdin JSON dispatch on hook_event_name):
 *   PostToolBatch   -> sample latest transcript usage, evaluate thresholds, never print
 *   Stop            -> same sampling; never block; duplicate usage = no-op; never print
 *   PreCompact(auto)-> emergency precompact alert once (replaces a missed 90%
 *                      alert; toast-only by default — set config sounds.precompact
 *                      to also play a sound); never print
 *   PostCompact     -> authoritative per-session reset; never print
 *   statusLine payload (no hook_event_name) -> render one-line ctx (legacy compat)
 *   --notify <70|80|90|precompact> -> manual live toast+sound test
 *   --selftest      -> offline deterministic suite (dry-run, no toasts/sounds)
 *
 * Metric (from the newest valid assistant usage row in the session transcript):
 *   usedTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   pct        = usedTokens / effectiveWindow * 100
 *   effectiveWindow (UI-matching policy, resolved from ~/.claude/settings.json env):
 *     - CLAUDE_CODE_MAX_CONTEXT_TOKENS is required (fail closed otherwise);
 *     - when env.CLAUDE_CODE_AUTO_COMPACT_WINDOW is a valid positive integer,
 *       effectiveWindow = min(maxContext, autoCompactWindow) — this mirrors
 *       Claude Code's Context Usage percentage so Guardian's bands align with
 *       the UI (no hardcoded sizes, no model-name inference);
 *     - otherwise effectiveWindow = maxContext.
 *   Optional pin (fail closed):
 *     - config.expectedContextWindowSize === null (public default):
 *         the resolved effective window is accepted as-is.
 *     - config.expectedContextWindowSize is a positive number:
 *         the RESOLVED effective window must equal it exactly (local pin).
 *     - missing/malformed/out-of-policy value: percentage alerts are disabled;
 *       a one-shot diagnostic toast per session/condition cycle is shown
 *       (no sound, no settings/env values disclosed).
 *
 * No daemon. No polling. No network. Bounded tail read only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- config ----

const DEFAULT_CONFIG = {
  thresholds: { t70: 70, t80: 80, t90: 90 },
  sounds: {
    t70: path.join(__dirname, 'sounds', 'dung.mp3'),
    t80: path.join(__dirname, 'sounds', 'getout.mp3'),
    t90: path.join(__dirname, 'sounds', 'fa.mp3')
    // precompact: intentionally unset — emergency PreCompact alert is
    // toast-only by default. Add e.g. sounds.precompact to play audio too.
  },
  notifier: path.join(__dirname, 'notify.ps1'),
  stateDir: path.join(__dirname, 'state'),
  logsDir: path.join(__dirname, 'logs'),
  settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
  // Denominator pin: null = accept any positive integer from the runtime
  // setting (public default). A positive number = the runtime value must
  // match exactly (local pin).
  expectedContextWindowSize: null,
  transcriptTailMaxBytes: 512 * 1024,
  transcriptChunkBytes: 64 * 1024,
  resetDrop: { enabled: true, fromPct: 50, toPct: 35 },
  lockTimeoutMs: 250,
  debugLog: false,
  toasts: {
    t70: 'Claude Context 70%',
    t80: 'Claude Context 80%',
    t90: 'Claude Context 90%',
    precompact: 'Claude Context: Auto Compact',
    denominator: 'Claude Context Guardian'
  }
};

function loadConfig(overridePath) {
  const p = overridePath || path.join(__dirname, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds || {}) },
      sounds: { ...DEFAULT_CONFIG.sounds, ...(raw.sounds || {}) },
      toasts: { ...DEFAULT_CONFIG.toasts, ...(raw.toasts || {}) },
      resetDrop: { ...DEFAULT_CONFIG.resetDrop, ...(raw.resetDrop || {}) }
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

let CONFIG = loadConfig();

// ---------------------------------------------------------------- state -----

function safeSessionId(sessionId) {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return sessionId;
  return 'h' + crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
}

function statePath(sessionId) {
  return path.join(CONFIG.stateDir, safeSessionId(sessionId) + '.json');
}

function loadState(sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return {
      session_id: String(raw.session_id ?? sessionId),
      last_pct: (typeof raw.last_pct === 'number' && raw.last_pct >= 0 && raw.last_pct <= 100) ? raw.last_pct : null,
      last_used_tokens: (typeof raw.last_used_tokens === 'number' && raw.last_used_tokens >= 0) ? raw.last_used_tokens : null,
      last_usage_id: typeof raw.last_usage_id === 'string' ? raw.last_usage_id : null,
      fired70: !!raw.fired70,
      fired80: !!raw.fired80,
      fired90: !!raw.fired90,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null
    };
  } catch {
    return {
      session_id: sessionId, last_pct: null, last_used_tokens: null, last_usage_id: null,
      fired70: false, fired80: false, fired90: false, updated_at: null
    };
  }
}

// Atomic write: unique temp file in the same dir, then rename-replace.
// Windows note (probe-verified 2026-09): rename-replace can transiently fail
// while ANY reader holds the target open — even with full sharing — because
// the rename itself needs a brief DELETE-access open of the target. A bounded
// retry (25 attempts, 5 ms backoff ≈ worst case ~125 ms, inside the lock
// TTL) fully recovers this race at every measured reader cadence, including
// a reader spinning with no gap. A failure surviving the budget is swallowed:
// the next hook re-samples.
function saveState(state) {
  const dir = CONFIG.stateDir;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + safeSessionId(state.session_id) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  const record = {
    session_id: state.session_id,
    last_pct: state.last_pct,
    last_used_tokens: state.last_used_tokens,
    last_usage_id: state.last_usage_id,
    fired70: state.fired70,
    fired80: state.fired80,
    fired90: state.fired90,
    updated_at: new Date().toISOString()
  };
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
      fs.renameSync(tmp, statePath(state.session_id));
      return;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      if (attempt === 24) return; // race not cleared: next hook re-samples
      const until = Date.now() + 5;
      while (Date.now() < until) { /* 5 ms backoff, like the lock spin */ }
    }
  }
}

// ------------------------------------------------------------ per-session lock ----

// Exclusive-create lock file: state/<safe-id>.lock holding {pid, ts}.
// A crashed process cannot hold it forever: recovered if the owning PID is
// gone or if the lock is older than a conservative TTL.
const LOCK_STALE_TTL_MS = 30000;

function lockPath(sessionId) {
  return path.join(CONFIG.stateDir, safeSessionId(sessionId) + '.lock');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours — treat as alive
  }
}

function acquireLock(sessionId) {
  const lp = lockPath(sessionId);
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  const deadline = Date.now() + CONFIG.lockTimeoutMs;
  for (;;) {
    const body = JSON.stringify({ pid: process.pid, ts: Date.now() });
    try {
      const fd = fs.openSync(lp, 'wx'); // exclusive create: O_CREAT|O_EXCL|O_WRONLY
      fs.writeFileSync(fd, body, 'utf8');
      fs.closeSync(fd);
      return lp;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    // Lock exists: check staleness (crashed owner / expired TTL).
    try {
      const raw = JSON.parse(fs.readFileSync(lp, 'utf8'));
      const age = Date.now() - (raw.ts || 0);
      const dead = typeof raw.pid === 'number' && raw.pid !== process.pid && !pidAlive(raw.pid);
      if (dead || age > LOCK_STALE_TTL_MS) {
        try { fs.unlinkSync(lp); } catch {}
        continue; // retry exclusive create
      }
    } catch {
      // unreadable lock body: treat as stale if old enough to be safe
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > LOCK_STALE_TTL_MS) {
          try { fs.unlinkSync(lp); } catch {}
          continue;
        }
      } catch {}
    }
    if (Date.now() >= deadline) return null; // active lock, not stolen
    // bounded spin with tiny sleep
    const until = Date.now() + 10;
    while (Date.now() < until) { /* busy-wait 10ms max */ }
  }
}

function releaseLock(lp) {
  if (!lp) return;
  try {
    // Only remove if we still own it (don't clobber someone else's fresh lock)
    const raw = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (raw.pid === process.pid) fs.unlinkSync(lp);
  } catch {}
}

// ----------------------------------------------------------- denominator ----

// Effective context window policy (P9.1b, owner-approved "UI-matching"):
// Claude Code's Context Usage UI divides the usage numerator by its EFFECTIVE
// auto-compact window, not by the model's maximum context window. Guardian
// mirrors that so the two percentages (and Guardian's 70/80/90 bands) align:
//
//   maxContext      = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS   (required)
//   autoCompact     = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW  (optional)
//
//   maxContext invalid/missing            -> fail closed (null)
//   autoCompact valid positive integer    -> effective = min(maxContext, autoCompact)
//   autoCompact missing/malformed/non-pos -> ignore it, effective = maxContext
//
// No hardcoding of any window size; no model-name inference. The optional
// config pin expectedContextWindowSize validates the FINAL RESOLVED value.
// Fail closed on missing/malformed maxContext or pin mismatch; PreCompact
// emergency stays armed. Never reads any other env value. Never discloses
// the observed values.
function parsePositiveIntEnv(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function resolveEffectiveWindow(env) {
  const maxContext = parsePositiveIntEnv(env ? env.CLAUDE_CODE_MAX_CONTEXT_TOKENS : undefined);
  if (maxContext === null) return null; // fail closed (cases D/F)
  const autoCompact = parsePositiveIntEnv(env ? env.CLAUDE_CODE_AUTO_COMPACT_WINDOW : undefined);
  if (autoCompact === null) return maxContext; // absent/malformed -> use MAX (A/E)
  return Math.min(maxContext, autoCompact); // B: smaller AUTO wins; C: MAX wins
}

function readContextWindowSize() {
  try {
    const s = JSON.parse(fs.readFileSync(CONFIG.settingsPath, 'utf8'));
    const effective = resolveEffectiveWindow(s && s.env ? s.env : undefined);
    if (effective === null) return null;
    const expected = CONFIG.expectedContextWindowSize;
    if (expected === null || expected === undefined) return effective; // auto policy
    if (typeof expected !== 'number' || !isFinite(expected) || expected <= 0) return null;
    if (effective !== expected) return null; // pinned but resolved value mismatched
    return effective;
  } catch {
    return null;
  }
}

// One-shot diagnostic for the fail-closed denominator condition. Semantics
// (approved public-source change): ONE concise toast per session per
// condition cycle — condition appears -> fire once; stays bad -> silent;
// recovers to good -> re-arm so a later recurrence fires once again.
// No sound. Never discloses settings/env values.
const denominatorDiagArmed = new Set(); // sessionIds currently armed

function isDenominatorOk() {
  return readContextWindowSize() !== null;
}

function notifyDenominatorDiagnostic(sessionId) {
  const bad = !isDenominatorOk();
  const wasArmed = denominatorDiagArmed.has(sessionId);
  if (bad && !wasArmed) {
    denominatorDiagArmed.add(sessionId);
    journal('denominator_diagnostic', { session_id: sessionId });
    fireNotification('denominator', sessionId);
  } else if (!bad && wasArmed) {
    // condition recovered -> re-arm for a future recurrence
    denominatorDiagArmed.delete(sessionId);
    journal('denominator_diagnostic_rearm', { session_id: sessionId });
  }
}

// ------------------------------------------------------------- events ------

// Dry-run event journal (offline tests only). Real mode spawns the notifier and
// writes no journal.
let DRYRUN = null; // { logPath, events: [] }

function journal(type, fields) {
  if (!DRYRUN) return;
  const entry = { ts: new Date().toISOString(), type, ...fields };
  DRYRUN.events.push(entry);
  try { fs.appendFileSync(DRYRUN.logPath, JSON.stringify(entry) + '\n', 'utf8'); } catch {}
}

// ------------------------------------------------------------- notifier ----

const MESSAGES = {
  t70: 'Context 70% used.',
  t80: 'Context 80% used — consider /compact soon.',
  t90: 'Context 90% — /compact now or auto-compact will trigger.',
  precompact: 'Context filled before the 90% warning was observed.',
  denominator: 'Context percentage alerts are inactive: the context window size setting is missing or not usable. Guardian emergency compact alerts remain active.'
};

function fireNotification(level, sessionId) {
  const key = level === 'precompact' ? 'precompact' : 't' + level;
  const title = CONFIG.toasts[key] || ('Claude Context ' + level);
  const message = MESSAGES[key] || '';
  const sound = CONFIG.sounds[key] || '';
  const soundPresent = !!sound && fs.existsSync(sound);

  journal('notify', { level, session_id: sessionId, title, sound, soundPresent });

  if (DRYRUN) return; // offline tests: journal only, never spawn real toasts/sounds

  try {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', CONFIG.notifier,
      '-Title', title,
      '-Message', message
    ];
    if (sound) args.push('-SoundPath', sound);
    const child = spawn('powershell.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {}); // never crash the guardian for a notifier failure
    child.unref();
  } catch {
    // never fail the hook because of a notification problem
  }
}

// ------------------------------------------------------- bounded tail read --

// Extracts the newest valid assistant usage record from a JSONL transcript by
// reading backwards in bounded chunks. Never loads the whole conversation.
// Returns null when no valid usage exists inside the bounded region (fail
// closed — no whole-file fallback).
//
// Used-row validation:
//   type === 'assistant', message.usage object, numeric input_tokens and
//   output_tokens; cache fields are optional numeric (measured schema:
//   present on all rows but treated as optional per spec).
// Dedupe id: uuid (row-level) — stable per assistant message.
function extractUsageRecord(obj) {
  if (!obj || obj.type !== 'assistant') return null;
  if (obj.isSidechain) return null; // subagent rows are not the main thread
  const u = obj.message && obj.message.usage;
  if (!u || typeof u !== 'object') return null;
  const inTok = u.input_tokens;
  if (typeof inTok !== 'number' || !isFinite(inTok) || inTok < 0) return null;
  // cache fields optional numeric; absent -> 0 (measured schema shows optional)
  const cc = u.cache_creation_input_tokens;
  const cr = u.cache_read_input_tokens;
  if (cc !== undefined && (typeof cc !== 'number' || !isFinite(cc) || cc < 0)) return null;
  if (cr !== undefined && (typeof cr !== 'number' || !isFinite(cr) || cr < 0)) return null;
  const out = u.output_tokens;
  if (typeof out !== 'number' || !isFinite(out) || out < 0) return null;
  const used = inTok + (typeof cc === 'number' ? cc : 0) + (typeof cr === 'number' ? cr : 0);
  if (!isFinite(used) || used < 0) return null;
  return { used, usageId: typeof obj.uuid === 'string' ? obj.uuid : null, timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null };
}

function sampleTranscriptUsage(transcriptPath) {
  // transcript_path must resolve to an existing file
  let st;
  try { st = fs.statSync(transcriptPath); } catch { return null; }
  if (!st || !st.isFile() || st.size <= 0) return null;

  const maxBytes = Math.max(1024, CONFIG.transcriptTailMaxBytes | 0);
  const chunk = Math.max(1024, Math.min(CONFIG.transcriptChunkBytes | 0, maxBytes));
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    let end = st.size;
    let scanned = 0;
    let carry = ''; // partial line carried to the next (older) chunk
    let carryIsComplete = false; // whether carry ends with \n (complete line)
    while (end > 0 && scanned < maxBytes) {
      const size = Math.min(chunk, end, maxBytes - scanned);
      const start = end - size;
      const buf = Buffer.alloc(size);
      const read = fs.readSync(fd, buf, 0, size, start);
      if (read <= 0) break;
      let text = buf.toString('utf8');
      const firstIsPartial = start > 0 && text[0] !== '\n';
      // Split this chunk + carry into lines. The first line is complete only
      // if the chunk starts at file offset 0 or begins right after a \n.
      let lines = text.split('\n');
      const lastEmpty = lines[lines.length - 1] === '';
      if (lastEmpty) lines.pop();
      // prepend previous carry (older-side partial from the previous iteration)
      if (carry) {
        lines[0] = carry + lines[0];
        if (carryIsComplete) { /* carry was a complete line: keep as-is */ }
      }
      // If this chunk doesn't start at a line boundary, its first line is
      // partial: push it down as the new carry instead of scanning it.
      let scanLines = lines;
      if (firstIsPartial && lines.length > 0) {
        carry = lines[0];
        carryIsComplete = false;
        scanLines = lines.slice(1);
      } else {
        carry = '';
        carryIsComplete = false;
      }
      // scan from newest to oldest; stop at first valid usage
      for (let i = scanLines.length - 1; i >= 0; i--) {
        const ln = scanLines[i].trim();
        if (!ln) continue;
        let obj;
        try { obj = JSON.parse(ln); } catch { continue; } // malformed line: skip
        const rec = extractUsageRecord(obj);
        if (rec) return rec;
      }
      scanned += read;
      end = start;
    }
    // Final carry (only when the loop ended by hitting file start / cap):
    // if the cap stopped us mid-line, that partial line can never be
    // validated without reading further back — fail closed.
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------- evaluation ------

function evaluateUsage(sessionId, rec) {
  if (!isDenominatorOk()) {
    notifyDenominatorDiagnostic(sessionId);
    journal('denominator_fail_closed', { session_id: sessionId });
    return; // no percentage alerts; PreCompact emergency remains armed
  }
  notifyDenominatorDiagnostic(sessionId); // no-op when healthy; re-arms after recovery
  const windowSize = readContextWindowSize();
  const pct = (rec.used / windowSize) * 100;
  if (!isFinite(pct) || pct < 0 || pct > 100) {
    journal('pct_rejected', { session_id: sessionId, pct });
    return;
  }

  const st = loadState(sessionId);
  const prev = st.last_pct;

  // Same-usage dedupe (Stop after PostToolBatch on an unchanged transcript):
  // re-evaluate state but never fire again. fired flags already reflect it.
  if (st.last_usage_id && rec.usageId && st.last_usage_id === rec.usageId) {
    st.last_pct = pct;
    st.last_used_tokens = rec.used;
    saveState(st);
    journal('dedupe_same_usage', { session_id: sessionId, pct });
    return;
  }

  const events = [];

  // Conservative fallback reset: an unmistakable post-compact drop re-arms.
  const rd = CONFIG.resetDrop;
  if (rd.enabled && prev !== null && prev >= rd.fromPct && pct <= rd.toPct) {
    if (st.fired70 || st.fired80 || st.fired90) {
      journal('reset_fallback', { session_id: sessionId, from: prev, to: pct });
      events.push('rearm');
    }
    st.fired70 = false;
    st.fired80 = false;
    st.fired90 = false;
  }

  // Newly crossed thresholds (null prev counts as 0: a first observation that
  // is already high is treated like a jump).
  const prevBase = prev === null ? 0 : prev;
  const t = CONFIG.thresholds;
  const crossed = [];
  if (!st.fired70 && pct >= t.t70 && prevBase < t.t70) crossed.push(70);
  if (!st.fired80 && pct >= t.t80 && prevBase < t.t80) crossed.push(80);
  if (!st.fired90 && pct >= t.t90 && prevBase < t.t90) crossed.push(90);

  if (crossed.length > 0) {
    const highest = Math.max(...crossed);
    if (crossed.includes(70)) st.fired70 = true;
    if (crossed.includes(80)) st.fired80 = true;
    if (crossed.includes(90)) st.fired90 = true;
    fireNotification(highest, sessionId);
    events.push('notify' + highest);
  }

  st.last_pct = pct;
  st.last_used_tokens = rec.used;
  st.last_usage_id = rec.usageId;
  saveState(st);
  journal('state', {
    session_id: sessionId, prev, pct, used: rec.used,
    fired70: st.fired70, fired80: st.fired80, fired90: st.fired90, events
  });
}

// -------------------------------------------------------------- hooks -------

// Shared evaluation path for PostToolBatch and Stop. Never prints. Never blocks.
function handleSampleHook(payload) {
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const transcriptPath = typeof payload.transcript_path === 'string' && payload.transcript_path ? payload.transcript_path : null;
  if (!sessionId || !transcriptPath) return; // nothing to do; exit 0

  const rec = sampleTranscriptUsage(transcriptPath);
  if (!rec) {
    // Absence of a newer usage row (e.g. Stop before final flush) is NOT an error.
    journal('no_usage_found', { session_id: sessionId });
    return;
  }

  // One guardian process per session evaluates at a time. Concurrent hooks:
  // loser skips (no duplicate fire); its next hook run re-samples.
  const lp = acquireLock(sessionId);
  if (!lp) {
    journal('lock_busy_skip', { session_id: sessionId });
    return;
  }
  try {
    evaluateUsage(sessionId, rec);
  } finally {
    releaseLock(lp);
  }
}

function handlePostCompact(payload) {
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  if (!sessionId) return; // nothing to reset; never block, exit 0
  const lp = acquireLock(sessionId);
  if (!lp) return;
  try {
    const st = loadState(sessionId);
    st.fired70 = false;
    st.fired80 = false;
    st.fired90 = false;
    st.last_pct = null;
    st.last_used_tokens = null;
    st.last_usage_id = null;
    saveState(st);
    journal('reset_postcompact', { session_id: sessionId });
  } finally {
    releaseLock(lp);
  }
}

function handlePreCompactAuto(payload) {
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  if (!sessionId) return; // exit 0, do nothing
  const lp = acquireLock(sessionId);
  if (!lp) return;
  try {
    const st = loadState(sessionId);
    if (st.fired90) return; // 90% alert already delivered — no duplicate
    st.fired70 = true;
    st.fired80 = true;
    st.fired90 = true;
    saveState(st);
    fireNotification('precompact', sessionId);
    journal('precompact_emergency', { session_id: sessionId });
  } finally {
    releaseLock(lp);
  }
}

// ------------------------------------------------------------ statusline ----
// Legacy compat path: a statusLine payload carries context_window data
// directly. Kept because the command string may still be reused elsewhere;
// some hosts (e.g. the VS Code extension) do not invoke statusLine, so this
// path is dormant there and the hook transport carries the metric instead.

function renderStatus(pct) {
  if (pct === null || typeof pct !== 'number' || !isFinite(pct) || pct < 0 || pct > 100) {
    return 'ctx: --';
  }
  const p = Math.round(pct);
  const filled = Math.max(0, Math.min(10, Math.round(p / 10)));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  // ANSI: <70 green, 70-79 amber, 80-89 bright yellow (orange-equivalent), >=90 red
  const c = p >= 90 ? '\x1b[91m' : p >= 80 ? '\x1b[93m' : p >= 70 ? '\x1b[33m' : '\x1b[32m';
  return `${c}ctx ${p}% [\u2588\u2588\u2588${bar.slice(3)}\x1b[0m`;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

function handleStatusLine(payload) {
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const cw = payload.context_window && typeof payload.context_window === 'object' ? payload.context_window : {};
  const pct = num(cw.used_percentage);

  if (CONFIG.debugLog) {
    try {
      fs.mkdirSync(CONFIG.logsDir, { recursive: true });
      const sample = {
        ts: new Date().toISOString(),
        version: payload.version ?? null,
        session_id: sessionId,
        context_window_size: cw.context_window_size ?? null,
        used_percentage: cw.used_percentage ?? null,
        remaining_percentage: cw.remaining_percentage ?? null,
        current_usage_is_null: ('current_usage' in cw) ? cw.current_usage === null : null
      };
      fs.appendFileSync(path.join(CONFIG.logsDir, 'payload-sample.jsonl'), JSON.stringify(sample) + '\n', 'utf8');
    } catch {}
  }

  if (!sessionId) {
    console.log(renderStatus(pct));
    return;
  }

  // No valid percentage: safe render only, never mutate state.
  if (pct === null) {
    console.log(renderStatus(null));
    return;
  }

  const st = loadState(sessionId);
  const prev = st.last_pct;
  const events = [];

  const rd = CONFIG.resetDrop;
  if (rd.enabled && prev !== null && prev >= rd.fromPct && pct <= rd.toPct) {
    if (st.fired70 || st.fired80 || st.fired90) {
      journal('reset_fallback', { session_id: sessionId, from: prev, to: pct });
      events.push('rearm');
    }
    st.fired70 = false;
    st.fired80 = false;
    st.fired90 = false;
  }

  const prevBase = prev === null ? 0 : prev;
  const t = CONFIG.thresholds;
  const crossed = [];
  if (!st.fired70 && pct >= t.t70 && prevBase < t.t70) crossed.push(70);
  if (!st.fired80 && pct >= t.t80 && prevBase < t.t80) crossed.push(80);
  if (!st.fired90 && pct >= t.t90 && prevBase < t.t90) crossed.push(90);

  if (crossed.length > 0) {
    const highest = Math.max(...crossed);
    if (crossed.includes(70)) st.fired70 = true;
    if (crossed.includes(80)) st.fired80 = true;
    if (crossed.includes(90)) st.fired90 = true;
    fireNotification(highest, sessionId);
    events.push('notify' + highest);
  }

  st.last_pct = pct;
  saveState(st);
  journal('state', {
    session_id: sessionId, prev, pct,
    fired70: st.fired70, fired80: st.fired80, fired90: st.fired90, events
  });

  console.log(renderStatus(pct));
}

// ---------------------------------------------------------------- main ------

function readStdinJson() {
  try {
    let raw = fs.readFileSync(0, 'utf8');
    // Tolerate a UTF-8 BOM (some Windows pipes prepend U+FEFF).
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);

  // Test-only config override (used by the multi-process race test so spawned
  // children run against the test stateDir/settings, never production ones).
  // Never set in production.
  if (process.env.GUARDIAN_CONFIG) {
    CONFIG = loadConfig(process.env.GUARDIAN_CONFIG);
  }

  // Manual live notification test: guardian.js --notify 70|80|90|precompact
  const notifyIdx = argv.indexOf('--notify');
  if (notifyIdx !== -1) {
    const level = argv[notifyIdx + 1];
    if (!['70', '80', '90', 'precompact'].includes(level)) {
      console.error('usage: guardian.js --notify 70|80|90|precompact');
      process.exit(2);
    }
    fireNotification(level === 'precompact' ? 'precompact' : Number(level), 'manual-test');
    console.log('notifier invoked for ' + level);
    return;
  }

  // Offline deterministic suite.
  if (argv.includes('--selftest')) {
    runSelfTest();
    return;
  }

  // Test-only dry-run journal (used by the multi-process race test): when
  // GUARDIAN_DRYRUN_LOG points at a file, record journal events there instead
  // of spawning real notifications. Never set in production.
  const dryrunLog = process.env.GUARDIAN_DRYRUN_LOG;
  if (dryrunLog) DRYRUN = { logPath: dryrunLog, events: [] };

  const payload = readStdinJson();

  // Malformed / empty input: no output, no state mutation, exit 0 fast.
  if (payload === null || typeof payload !== 'object') {
    return;
  }

  switch (payload.hook_event_name) {
    case 'PostToolBatch':
      handleSampleHook(payload);
      return; // print nothing, exit 0
    case 'Stop':
    case 'SubagentStop':
      handleSampleHook(payload);
      return; // print nothing, exit 0
    case 'PostCompact':
      handlePostCompact(payload);
      return;
    case 'PreCompact':
      if (payload.trigger === 'auto') handlePreCompactAuto(payload);
      return; // manual PreCompact: never interfere
    default:
      // statusLine-style payload (no hook_event_name): legacy render path
      handleStatusLine(payload);
  }
}

// ------------------------------------------------------------- selftest -----

function runSelfTest() {
  const root = path.join(os.tmpdir(), 'claude-context-guardian-selftest-1b');
  fs.rmSync(root, { recursive: true, force: true });
  const stateDir = path.join(root, 'state');
  const fixtDir = path.join(root, 'fixtures');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(fixtDir, { recursive: true });
  const logPath = path.join(root, 'events.jsonl');

  CONFIG = {
    ...CONFIG,
    stateDir,
    logsDir: path.join(root, 'logs'),
    debugLog: false,
    lockTimeoutMs: 250,
    settingsPath: path.join(root, 'settings.json'),
    expectedContextWindowSize: 1000000,
    transcriptTailMaxBytes: 512 * 1024,
    transcriptChunkBytes: 8 * 1024,
    sounds: {
      t70: path.join(__dirname, 'sounds', 'dung.mp3'),
      t80: path.join(__dirname, 'sounds', 'getout.mp3'),
      t90: path.join(__dirname, 'sounds', 'fa.mp3')
    }
  };
  DRYRUN = { logPath, events: [] };

  function writeSettings(v) {
    if (v === null) { try { fs.unlinkSync(CONFIG.settingsPath); } catch {} return; }
    fs.writeFileSync(CONFIG.settingsPath, JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(v) } }));
  }
  writeSettings(1000000);

  // --- fixtures: realistic JSONL rows (uuid/timestamp/type/message.usage) ---
  function usageRow(uuid, ts, inTok, cc, cr, out) {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, userType: 'external', cwd: 'X', sessionId: 'S',
      version: '2.1.263', type: 'assistant', uuid, timestamp: ts,
      message: {
        id: 'msg_' + uuid, type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'text', text: 'REDACTED' }],
        stop_reason: null, usage: {
          input_tokens: inTok, cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
          output_tokens: out
        }
      }
    });
  }
  function noiseRow(i, ts) {
    return JSON.stringify({ type: 'user', uuid: 'u' + i, timestamp: ts, message: { role: 'user', content: 'REDACTED' } });
  }
  function writeFixture(name, rows) {
    const p = path.join(fixtDir, name);
    fs.writeFileSync(p, rows.join('\n') + '\n');
    return p;
  }

  const T = { t70: 70, t80: 80, t90: 90 };

  // A. bounded-tail parser finds newest usage in realistic fixture
  const fxA = writeFixture('A.jsonl', [
    noiseRow(1, '2026-09-07T01:00:00Z'),
    usageRow('a1', '2026-09-07T01:00:10Z', 100000, 5000, 20000, 300),
    noiseRow(2, '2026-09-07T01:00:20Z'),
    usageRow('a2', '2026-09-07T01:00:30Z', 690000, 0, 0, 500), // 69%
    usageRow('a3', '2026-09-07T01:00:40Z', 700000, 10000, 25000, 900) // 73.5%
  ]);
  // B. newest chosen (a3 above; feeding fxA must fire 70 from 69->73.5 via sA)

  // C. malformed final line, prior complete usage found
  const fxC = writeFixture('C.jsonl', [
    usageRow('c1', '2026-09-07T02:00:00Z', 100000, 0, 0, 100),
    '{"type":"assistant","uuid":"c2","message":{"usage":{"input_tokens":',
    noiseRow(9, '2026-09-07T02:00:05Z')
  ]);

  // D. missing cache fields -> treated as zero
  const fxD = writeFixture('D.jsonl', [
    JSON.stringify({ type: 'assistant', uuid: 'd1', timestamp: '2026-09-07T03:00:00Z', isSidechain: false, message: { usage: { input_tokens: 500000, output_tokens: 50 } } })
  ]);

  // E. invalid token types -> reject
  const fxE = writeFixture('E.jsonl', [
    JSON.stringify({ type: 'assistant', uuid: 'e1', timestamp: '2026-09-07T04:00:00Z', isSidechain: false, message: { usage: { input_tokens: 'many', output_tokens: 5 } } })
  ]);

  // F. usage outside bounded region -> fail closed, no whole-file fallback
  const bigNoise = Array.from({ length: 4000 }, (_, i) => noiseRow(1000 + i, '2026-09-07T05:00:00Z')); // > 512KB when serialized
  const fxF = writeFixture('F.jsonl', [
    usageRow('f0', '2026-09-07T04:59:00Z', 800000, 0, 0, 100),
    ...bigNoise,
    noiseRow(99999, '2026-09-07T05:01:00Z')
  ]);

  // H. exact formula synthetic
  const fxH = writeFixture('H.jsonl', [
    usageRow('h1', '2026-09-07T06:00:00Z', 250000, 50000, 150000, 1000) // used=450000 -> 45%
  ]);

  const results = [];
  function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail || '' });
  }

  function feedTranscript(sid, fixturePath) {
    handleSampleHook({ hook_event_name: 'PostToolBatch', session_id: sid, transcript_path: fixturePath });
  }
  function st(sid) { return loadState(sid); }
  function notifyEvents() { return DRYRUN.events.filter(e => e.type === 'notify'); }
  function eventsFor(sid) { return notifyEvents().filter(e => e.session_id === sid); }
  function resetJournal() { DRYRUN.events = []; }

  // A: newest usage found
  {
    const rec = sampleTranscriptUsage(fxA);
    check('A. newest usage row found', !!rec && rec.usageId === 'a3', JSON.stringify(rec));
  }
  // B: newest chosen + threshold eval 69 -> 73.5 fires 70 only
  {
    resetJournal();
    feedTranscript('sB', fxA);
    const ev = eventsFor('sB');
    check('B. newest usage chosen, 70 fires once', ev.length === 1 && ev[0].level === 70, JSON.stringify(ev));
    check('B2. pct precise (73.5)', Math.abs(st('sB').last_pct - 73.5) < 0.001, String(st('sB').last_pct));
  }
  // C: malformed final line skipped, prior usage found
  {
    const rec = sampleTranscriptUsage(fxC);
    check('C. malformed tail line skipped', !!rec && rec.usageId === 'c1', JSON.stringify(rec));
  }
  // D: missing cache fields -> zero, pct = 50
  {
    const rec = sampleTranscriptUsage(fxD);
    check('D. missing cache fields -> used=500000', !!rec && rec.used === 500000, JSON.stringify(rec));
  }
  // E: invalid token type -> no alert, no state mutation
  {
    resetJournal();
    const before = fs.existsSync(statePath('sE')) ? fs.readFileSync(statePath('sE'), 'utf8') : null;
    feedTranscript('sE', fxE);
    const after = fs.existsSync(statePath('sE')) ? fs.readFileSync(statePath('sE'), 'utf8') : null;
    check('E. invalid token types -> no state/no alert', before === after && eventsFor('sE').length === 0);
  }
  // F: usage beyond bounded tail -> fail closed (no whole-file fallback)
  {
    const rec = sampleTranscriptUsage(fxF);
    check('F. usage beyond cap -> fail closed', rec === null, JSON.stringify(rec));
  }
  // G: denominator matrix
  {
    const sidG = 'sG';
    // 1000000 -> pass (already default)
    resetJournal();
    writeSettings(1000000);
    feedTranscript(sidG, fxD);
    check('G1. denominator 1000000 -> alerts evaluated', eventsFor(sidG).length === 0 && st(sidG).last_pct === 50, 'pct=' + st(sidG).last_pct);
    // 200000 -> no percentage alerts (pin active: fail closed). The one-shot
    // denominator diagnostic may fire (once per condition cycle) but no
    // percentage/threshold alert may appear.
    resetJournal();
    writeSettings(200000);
    const before200 = JSON.stringify(st(sidG));
    feedTranscript(sidG, fxD);
    check('G2. denominator 200000 -> fail closed, no alerts',
      notifyEvents().every(e => e.level === 'denominator') && JSON.stringify(st(sidG)) === before200, JSON.stringify(notifyEvents()));
    // missing -> no alerts
    writeSettings(null);
    resetJournal();
    feedTranscript(sidG, fxD);
    check('G3. denominator missing -> fail closed', notifyEvents().every(e => e.level === 'denominator'));
    // malformed -> no alerts
    fs.writeFileSync(CONFIG.settingsPath, '{broken');
    resetJournal();
    feedTranscript(sidG, fxD);
    check('G4. denominator malformed -> fail closed', notifyEvents().length === 0);
    // restore
    writeSettings(1000000);
  }
  // H: exact formula 250000+50000+150000=450000 -> 45%
  {
    const rec = sampleTranscriptUsage(fxH);
    const pct = rec ? (rec.used / 1000000) * 100 : null;
    check('H. formula input+cc+cr, no output', rec && rec.used === 450000 && Math.abs(pct - 45) < 1e-9, JSON.stringify(rec));
  }
  // I: same-session concurrency -> exactly one notify event
  {
    resetJournal();
    const sidI = 'sI';
    const fxI = writeFixture('I.jsonl', [
      usageRow('i1', '2026-09-07T07:00:00Z', 100000, 0, 0, 100),
      usageRow('i2', '2026-09-07T07:00:10Z', 850000, 0, 0, 100) // 85% -> fires 80
    ]);
    // Real concurrency: spawn N actual node processes running guardian in dry-run.
    // Dry-run mode requires in-process DRYRUN, so simulate by racing the lock:
    // pre-acquire the lock (as if another process owns it) -> skip; then release and run.
    const lp = acquireLock(sidI);
    handleSampleHook({ hook_event_name: 'PostToolBatch', session_id: sidI, transcript_path: fxI });
    const evDuringLock = eventsFor(sidI).length;
    releaseLock(lp);
    handleSampleHook({ hook_event_name: 'PostToolBatch', session_id: sidI, transcript_path: fxI });
    const evAfter = eventsFor(sidI).length;
    check('I. lock held -> skip; free -> exactly one notify', evDuringLock === 0 && evAfter === 1, 'during=' + evDuringLock + ' after=' + evAfter);
  }
  // I2: true multi-process race at threshold crossing
  {
    resetJournal();
    const sidI2 = 'sI2race';
    const fxI2 = writeFixture('I2.jsonl', [
      usageRow('i2r1', '2026-09-07T07:10:00Z', 850000, 0, 0, 100)
    ]);
    // Spawned children must write to the test stateDir/settings, not production.
    const raceCfgPath = path.join(root, 'race-config.json');
    fs.writeFileSync(raceCfgPath, JSON.stringify({
      ...CONFIG,
      stateDir,
      settingsPath: CONFIG.settingsPath,
      lockTimeoutMs: CONFIG.lockTimeoutMs
    }));
    // Use a special env-gated dry-run: guardian.js reads GUARDIAN_DRYRUN_LOG
    const procs = [];
    for (let k = 0; k < 6; k++) {
      procs.push(new Promise(resolve => {
        const { spawn } = require('child_process');
        const c = spawn(process.execPath, [path.join(__dirname, 'guardian.js')], {
          env: { ...process.env, GUARDIAN_DRYRUN_LOG: logPath, GUARDIAN_CONFIG: raceCfgPath },
          stdio: ['pipe', 'ignore', 'ignore']
        });
        c.stdin.write(JSON.stringify({ hook_event_name: 'PostToolBatch', session_id: sidI2, transcript_path: fxI2 }));
        c.stdin.end();
        c.on('close', resolve);
      }));
    }
    Promise.all(procs).then(() => {
      try {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const fired = lines.filter(e => e.type === 'notify' && e.session_id === sidI2);
        check('I2. 6-way process race -> exactly one 80', fired.length === 1, JSON.stringify(fired));
        finishTests();
      } catch (e) {
        check('I2. 6-way process race -> exactly one 80', false, String(e));
        finishTests();
      }
    });
  }
  // J/K/L/M/N run after the race resolves (finishTests)

  // J: stale lock recovery
  function testJ() {
    resetJournal();
    const sidJ = 'sJ';
    const lpJ = lockPath(sidJ);
    fs.writeFileSync(lpJ, JSON.stringify({ pid: 999999999, ts: Date.now() - 60000 })); // dead pid, old
    const got = acquireLock(sidJ);
    check('J. stale lock recovered', got === lpJ, String(got));
    releaseLock(got);
  }
  // K: active lock not stolen
  function testK() {
    const sidK = 'sK';
    const lpK = lockPath(sidK);
    fs.writeFileSync(lpK, JSON.stringify({ pid: process.pid, ts: Date.now() })); // alive owner, fresh
    const got = acquireLock(sidK);
    check('K. active lock not stolen', got === null, String(got));
    try { fs.unlinkSync(lpK); } catch {}
  }
  // L: two-session concurrent isolation
  function testL() {
    resetJournal();
    const fxL1 = writeFixture('L1.jsonl', [usageRow('l1', '2026-09-07T08:00:00Z', 700000, 0, 0, 100)]); // 70
    const fxL2 = writeFixture('L2.jsonl', [usageRow('l2', '2026-09-07T08:00:00Z', 900000, 0, 0, 100)]); // 90
    // hold lock on session 1; session 2 must still fire independently
    const lp = acquireLock('sL1');
    feedTranscript('sL2', fxL2);
    const evL2 = eventsFor('sL2');
    check('L. session2 fires while session1 locked', evL2.length === 1 && evL2[0].level === 90, JSON.stringify(evL2));
    releaseLock(lp);
    feedTranscript('sL1', fxL1);
    const evL1 = eventsFor('sL1');
    check('L2. session1 fires after release', evL1.length === 1 && evL1[0].level === 70, JSON.stringify(evL1));
  }
  // M: Stop processing same usage twice -> no duplicate
  function testM() {
    resetJournal();
    const sidM = 'sM';
    const fxM = writeFixture('M.jsonl', [usageRow('m1', '2026-09-07T09:00:00Z', 700000, 0, 0, 100)]);
    handleSampleHook({ hook_event_name: 'PostToolBatch', session_id: sidM, transcript_path: fxM });
    handleSampleHook({ hook_event_name: 'Stop', session_id: sidM, transcript_path: fxM });
    const evM = eventsFor(sidM);
    check('M. same usage twice -> one alert', evM.length === 1, JSON.stringify(evM));
  }
  // N: PostToolBatch then immediate Stop on same usage -> one alert
  function testN() {
    resetJournal();
    const sidN = 'sN';
    const fxN = writeFixture('N.jsonl', [
      usageRow('n1', '2026-09-07T10:00:00Z', 100000, 0, 0, 100),
      usageRow('n2', '2026-09-07T10:00:10Z', 950000, 0, 0, 100) // 95 -> fires 90
    ]);
    handleSampleHook({ hook_event_name: 'PostToolBatch', session_id: sidN, transcript_path: fxN });
    handleSampleHook({ hook_event_name: 'Stop', session_id: sidN, transcript_path: fxN });
    const evN = eventsFor(sidN);
    check('N. PTB+Stop same usage -> exactly one 90', evN.length === 1 && evN[0].level === 90, JSON.stringify(evN));
  }

  // legacy statusline behavior preservation (prior suite, condensed but complete)
  function testLegacy() {
    resetJournal();
    // gradual thresholds with fake session ids via statusline path
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 69 } });
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 70 } });
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 70 } });
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 79 } });
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 80 } });
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 89 } });
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 90 } });
    const e1 = eventsFor('Lg1').map(e => e.level);
    check('Lg. gradual 70/80/90', JSON.stringify(e1) === '[70,80,90]', JSON.stringify(e1));
    // jump 69->83 only-80, mark 70+80
    resetJournal();
    handleStatusLine({ session_id: 'Lg2', context_window: { used_percentage: 69 } });
    handleStatusLine({ session_id: 'Lg2', context_window: { used_percentage: 83 } });
    const s2st = st('Lg2');
    check('Lg. jump 69->83 only-80', JSON.stringify(eventsFor('Lg2').map(e => e.level)) === '[80]' && s2st.fired70 && s2st.fired80 && !s2st.fired90, JSON.stringify(eventsFor('Lg2')));
    // jump 69->95 only-90, all fired
    resetJournal();
    handleStatusLine({ session_id: 'Lg3', context_window: { used_percentage: 69 } });
    handleStatusLine({ session_id: 'Lg3', context_window: { used_percentage: 95 } });
    const s3st = st('Lg3');
    check('Lg. jump 69->95 only-90', JSON.stringify(eventsFor('Lg3').map(e => e.level)) === '[90]' && s3st.fired70 && s3st.fired80 && s3st.fired90, JSON.stringify(eventsFor('Lg3')));
    // PostCompact reset + re-fire
    resetJournal();
    handlePostCompact({ hook_event_name: 'PostCompact', session_id: 'Lg1' });
    const lg1 = st('Lg1');
    check('Lg. PostCompact resets', !lg1.fired70 && !lg1.fired80 && !lg1.fired90 && lg1.last_pct === null, JSON.stringify(lg1));
    handleStatusLine({ session_id: 'Lg1', context_window: { used_percentage: 70 } });
    check('Lg. re-fire 70 after reset', eventsFor('Lg1').filter(e => e.level === 70).length === 1, JSON.stringify(eventsFor('Lg1')));
    // PreCompact auto emergency once
    resetJournal();
    handlePreCompactAuto({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'LgC' });
    handlePreCompactAuto({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'LgC' });
    const evC = eventsFor('LgC');
    check('Lg. PreCompact(auto) once', evC.length === 1 && evC[0].level === 'precompact', JSON.stringify(evC));
    // hooks never print
    const origLog = console.log, captured = [];
    console.log = (...a) => captured.push(a.join(' '));
    handleSampleHook({ hook_event_name: 'PostToolBatch', session_id: 'LgZ', transcript_path: fxD });
    handleSampleHook({ hook_event_name: 'Stop', session_id: 'LgZ2', transcript_path: 'C:/definitely/missing.jsonl' });
    handlePostCompact({ hook_event_name: 'PostCompact', session_id: 'LgZ3' });
    handlePreCompactAuto({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'LgZ4' });
    console.log = origLog;
    check('Lg. hooks never print', captured.length === 0, JSON.stringify(captured));
  }

  let finished = false;
  function finishTests() {
    if (finished) return;
    finished = true;
    testJ();
    testK();
    testL();
    testM();
    testN();
    testLegacy();
    testDenominatorPolicy();
    testEffectiveWindowResolver();
    testThresholdAlignment();
    testPrecompactSoundConfig();
    report();
  }
  if (!DRYRUN.events.some(e => e.type === 'notify' && String(e.session_id).includes('race'))) {
    // race promise chain drives finishTests; if spawn unsupported, fall through
    setTimeout(() => finishTests(), 10000);
  }

  // Denominator policy matrix (public auto policy + pin + diagnostic dedupe).
  function testDenominatorPolicy() {
    const sidD = 'sDenom';
    const fxDenom = writeFixture('Denom.jsonl', [
      usageRow('dn1', '2026-09-07T11:00:00Z', 100000, 0, 0, 100)
    ]);
    // AUTO policy (expected = null): any positive integer accepted.
    CONFIG.expectedContextWindowSize = null;
    resetJournal();
    writeSettings(200000);
    feedTranscript(sidD, fxDenom);
    check('Dp. auto policy: 200000 accepted, alerts evaluated', st(sidD).last_pct === 50, String(st(sidD).last_pct));
    // PIN policy: mismatch -> fail closed (one-shot diagnostic allowed, no
    // percentage alert, no state mutation).
    CONFIG.expectedContextWindowSize = 1000000;
    resetJournal();
    const beforePin = JSON.stringify(st(sidD));
    feedTranscript(sidD, fxDenom);
    check('Dp. pin 1000000 vs runtime 200000 -> fail closed',
      notifyEvents().every(e => e.level === 'denominator') && JSON.stringify(st(sidD)) === beforePin, JSON.stringify(notifyEvents()));
    // Diagnostic toast: exactly one per condition cycle (no sound), not per hook.
    resetJournal();
    CONFIG.expectedContextWindowSize = 200000; // pin matches again -> healthy
    feedTranscript(sidD, fxDenom); // healthy again -> re-arms
    writeSettings(150000); // now bad again
    resetJournal();
    feedTranscript(sidD, fxDenom);
    feedTranscript(sidD, fxDenom);
    feedTranscript(sidD, fxDenom);
    const diag = DRYRUN.events.filter(e => e.type === 'denominator_diagnostic');
    const diagNotify = notifyEvents().filter(e => e.level === 'denominator');
    check('Dp. diagnostic fires once per condition cycle', diag.length === 1 && diagNotify.length === 1, JSON.stringify({ diag: diag.length, notify: diagNotify.length }));
    // ...and a notification event has no sound path (toast-only diagnostic).
    check('Dp. diagnostic toast has no sound', diagNotify.length === 1 && !diagNotify[0].sound, JSON.stringify(diagNotify));
    // Malformed settings -> fail closed without crash, still one diagnostic.
    fs.writeFileSync(CONFIG.settingsPath, '{broken');
    resetJournal();
    feedTranscript(sidD, fxDenom);
    check('Dp. malformed settings -> fail closed, no extra diagnostic', notifyEvents().filter(e => e.level === 'denominator').length === 0 && st(sidD) !== null);
    // restore healthy
    CONFIG.expectedContextWindowSize = 1000000;
    writeSettings(1000000);
    denominatorDiagArmed.clear();
  }

  // Effective-window resolver matrix (P9.1b UI-matching policy). The resolver
  // is a pure function of the settings env object, so these checks are direct.
  function testEffectiveWindowResolver() {
    const save = CONFIG.expectedContextWindowSize;
    CONFIG.expectedContextWindowSize = null; // resolver checks run unpinned

    // A. MAX valid, AUTO missing -> MAX
    check('Rw.A. MAX valid, AUTO absent -> MAX',
      resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000 }) === 1000000);
    // B. MAX valid, AUTO valid smaller -> AUTO
    check('Rw.B. AUTO smaller -> AUTO (1M/950k -> 950k)',
      resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 950000 }) === 950000);
    // C. MAX valid, AUTO valid larger -> MAX
    check('Rw.C. AUTO larger -> MAX (1M/1.2M -> 1M)',
      resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 1200000 }) === 1000000);
    // D. MAX invalid/missing -> fail closed
    check('Rw.D1. MAX missing -> fail closed', resolveEffectiveWindow({}) === null);
    check('Rw.D2. MAX malformed -> fail closed', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 'abc' }) === null);
    check('Rw.D3. MAX zero/negative -> fail closed', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 0 }) === null && resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: -5 }) === null);
    check('Rw.D4. MAX non-integer -> fail closed', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1.5 }) === null);
    // E. malformed/non-positive AUTO with valid MAX -> ignore AUTO, use MAX
    check('Rw.E1. AUTO malformed string -> MAX', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'banana' }) === 1000000);
    check('Rw.E2. AUTO zero -> MAX', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 0 }) === 1000000);
    check('Rw.E3. AUTO negative -> MAX', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: -950000 }) === 1000000);
    check('Rw.E4. AUTO non-integer float -> MAX', resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 950.5 }) === 1000000);
    // numeric-string forms accepted (settings store strings)
    check('Rw.S. numeric strings accepted ("1000000"/"950000" -> 950000)',
      resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000' }) === 950000);

    // Pin semantics validate the RESOLVED effective window:
    // F1. expected=950000 with effective=950000 -> accepted
    CONFIG.expectedContextWindowSize = 950000;
    check('Rw.F1. pin 950000 matches resolved 950000 -> accepted',
      resolveEffectiveWindow({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1000000, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 950000 }) === 950000);
    // F2. expected=1000000 with effective=950000 -> fail closed via readContextWindowSize
    const savedSettings = fs.readFileSync(CONFIG.settingsPath, 'utf8');
    fs.writeFileSync(CONFIG.settingsPath, JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000' } }));
    CONFIG.expectedContextWindowSize = 1000000;
    check('Rw.F2. pin 1000000 vs resolved 950000 -> fail closed', readContextWindowSize() === null);
    CONFIG.expectedContextWindowSize = 950000;
    check('Rw.F3. pin 950000 vs resolved 950000 -> accepted', readContextWindowSize() === 950000);
    CONFIG.expectedContextWindowSize = null;
    check('Rw.F4. expected=null -> resolved accepted', readContextWindowSize() === 950000);
    fs.writeFileSync(CONFIG.settingsPath, savedSettings);
    CONFIG.expectedContextWindowSize = save;
    denominatorDiagArmed.clear();
  }

  // Synthetic threshold alignment under the UI-matching window (950k):
  // 665000/950000=70, 760000/950000=80, 855000/950000=90.
  function testThresholdAlignment() {
    const save = CONFIG.expectedContextWindowSize;
    CONFIG.expectedContextWindowSize = null;
    const savedSettings = fs.readFileSync(CONFIG.settingsPath, 'utf8');
    fs.writeFileSync(CONFIG.settingsPath, JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000' } }));
    const cases = [
      ['Ta. 665000 -> exactly 70 fires dung-level only', 665000, 70],
      ['Ta. 760000 -> exactly 80 fires getout-level only', 760000, 80],
      ['Ta. 855000 -> exactly 90 fires fa-level only', 855000, 90]
    ];
    for (const [name, used, level] of cases) {
      resetJournal();
      const sid = 'sAlign' + level;
      const fx = writeFixture('Align' + level + '.jsonl', [usageRow('al' + level, '2026-09-07T11:20:0' + (level % 10) + ':00Z', used, 0, 0, 100)]);
      feedTranscript(sid, fx);
      const ev = eventsFor(sid);
      check(name, ev.length === 1 && ev[0].level === level, JSON.stringify(ev));
    }
    // output tokens still excluded from the numerator
    resetJournal();
    const sidX = 'sOutTok';
    const fxX = writeFixture('OutTok.jsonl', [usageRow('ot1', '2026-09-07T11:30:00Z', 500000, 0, 0, 400000)]);    feedTranscript(sidX, fxX);
    check('Ta. output tokens excluded (500000 used -> pct 500000/950000)', Math.abs(st(sidX).last_pct - (500000 / 950000 * 100)) < 1e-9, String(st(sidX).last_pct));
    fs.writeFileSync(CONFIG.settingsPath, savedSettings);
    CONFIG.expectedContextWindowSize = save;
    denominatorDiagArmed.clear();
  }

  // PreCompact sound policy: default toast-only; configured sound honored;
  // fired90 suppresses duplicates in both modes.
  function testPrecompactSoundConfig() {
    resetJournal();
    const sidP = 'sPc';
    handlePreCompactAuto({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sidP });
    const ev1 = notifyEvents().filter(e => e.session_id === sidP && e.level === 'precompact');
    check('Pc. default: precompact fires once, toast-only (no sound key)', ev1.length === 1 && !ev1[0].sound, JSON.stringify(ev1));
    handlePreCompactAuto({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sidP });
    check('Pc. fired90 -> no duplicate precompact', notifyEvents().filter(e => e.session_id === sidP).length === 1, JSON.stringify(notifyEvents()));
    // Configured sound mode (owner-local option): key present -> sound passed.
    const savedSounds = { ...CONFIG.sounds };
    const savedSt = loadState(sidP);
    savedSt.fired90 = false; // re-arm to test the configured path
    saveState(savedSt);
    CONFIG.sounds.precompact = 'EXAMPLE-NOSUCH-FILE.mp3'; // path is existence-checked, not played (DRYRUN)
    resetJournal();
    handlePreCompactAuto({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sidP });
    const ev2 = notifyEvents().filter(e => e.session_id === sidP && e.level === 'precompact');
    check('Pc. configured sounds.precompact -> sound key honored', ev2.length === 1 && ev2[0].sound === 'EXAMPLE-NOSUCH-FILE.mp3', JSON.stringify(ev2));
    CONFIG.sounds = savedSounds;
    denominatorDiagArmed.clear();
  }

  function report() {
    // cleanup own fixtures/state regardless of result
    let failed = 0;
    for (const r of results) {
      if (!r.pass) failed++;
      process.stdout.write((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.pass ? '' : '   [' + r.detail + ']') + '\n');
    }
    process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
}

main();
