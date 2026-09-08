#!/usr/bin/env node
/**
 * Claude Context Guardian — settings mutator (zero-dependency).
 *
 * Structurally merges/removes ONLY Guardian-owned hook entries in a Claude
 * Code settings.json while proving the rest of the document is preserved
 * semantically. Used by scripts/install.ps1 / scripts/uninstall.ps1.
 *
 * Design (REV 2.1):
 *   - Identity of a Guardian entry = its canonical command string
 *     (path separators normalized to "/", case-insensitive). No markers are
 *     injected into the user's settings.
 *   - Preservation invariant: post-mutation tree minus Guardian-owned
 *     additions deep-semantically-equals the pre-mutation tree. Validated
 *     immediately after writing; any mismatch restores the backup and exits 1.
 *   - Supported-input preflight (fail closed BEFORE any mutation):
 *       * malformed JSON                    -> abort, file untouched
 *       * duplicate object keys (any depth) -> abort, file untouched
 *       * numeric literals beyond safe integer precision -> abort
 *     Semantic preservation is guaranteed only for validated supported JSON
 *     input; exotic input is rejected rather than silently rewritten.
 *   - Never prints settings content or secret values; diagnostics name paths
 *     and JSON locations only.
 *
 * Usage:
 *   node settings-mutator.js install   --settings <path> --command "<cmd>"
 *   node settings-mutator.js uninstall --settings <path> --command "<cmd>"
 *   node settings-mutator.js selftest
 *
 * Exit codes: 0 ok, 1 rejected input / validation failure (restored),
 * 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------- preflight ----

// Character-level scan of the RAW text for duplicate keys at any depth and
// numeric literals beyond Number safe-integer precision. JSON.parse alone
// cannot prove either (it silently keeps the last duplicate), so both are
// detected mechanically on the raw input with a tokenizer.
function preflight(rawText) {
  const problems = [];
  let i = 0;
  const n = rawText.length;

  // Key-stack: each open object gets a map of its keys + their first offset.
  const stack = [];

  function err(msg) { problems.push(msg); }
  function skipWs() { while (i < n && (rawText[i] === ' ' || rawText[i] === '\t' || rawText[i] === '\n' || rawText[i] === '\r')) i++; }

  function readString() {
    // rawText[i] is the opening quote
    const start = i;
    i++;
    let out = '';
    while (i < n) {
      const c = rawText[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const esc = rawText[i + 1];
        if (esc === 'u') {
          const hex = rawText.substr(i + 2, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) { err('bad \\u escape at offset ' + i); return null; }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' };
        if (!(esc in map)) { err('bad escape at offset ' + i); return null; }
        out += map[esc];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    err('unterminated string at offset ' + start);
    return null;
  }

  function readNumber() {
    const start = i;
    if (rawText[i] === '-') i++;
    while (i < n && /[0-9]/.test(rawText[i])) i++;
    if (rawText[i] === '.') { i++; while (i < n && /[0-9]/.test(rawText[i])) i++; }
    if (rawText[i] === 'e' || rawText[i] === 'E') {
      i++;
      if (rawText[i] === '+' || rawText[i] === '-') i++;
      while (i < n && /[0-9]/.test(rawText[i])) i++;
    }
    const tok = rawText.slice(start, i);
    const num = Number(tok);
    if (!isFinite(num)) { err('non-finite number "' + tok + '" at offset ' + start); return; }
    // Precision guard: any integer-shaped literal whose absolute value exceeds
    // Number.MAX_SAFE_INTEGER cannot round-trip semantically. (Floats that
    // re-serialize differently are caught by the post-write validation.)
    if (/^-?\d+$/.test(tok) && Math.abs(num) > Number.MAX_SAFE_INTEGER) {
      err('integer beyond safe precision "' + tok + '" at offset ' + start);
    }
  }

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const c = rawText[i];
    if (c === '{') {
      stack.push({ keys: new Map() });
      i++;
    } else if (c === '}') {
      stack.pop();
      i++;
    } else if (c === '[') {
      // arrays have no keys; push a marker that ignores key dedupe
      stack.push(null);
      i++;
    } else if (c === ']') {
      stack.pop();
      i++;
    } else if (c === '"') {
      const s = readString();
      if (s === null) break;
      // String followed by ':' is a key in the current object.
      let j = i;
      while (j < n && (rawText[j] === ' ' || rawText[j] === '\t' || rawText[j] === '\n' || rawText[j] === '\r')) j++;
      if (rawText[j] === ':' && stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top) { // null marker = inside array (should not happen for keys)
          if (top.keys.has(s)) {
            err('duplicate object key "' + s + '" at offset ' + i);
          } else {
            top.keys.set(s, i);
          }
        }
      }
    } else if (c === ',' || c === ':') {
      i++;
    } else if (c === 't' && rawText.startsWith('true', i)) { i += 4; }
    else if (c === 'f' && rawText.startsWith('false', i)) { i += 5; }
    else if (c === 'n' && rawText.startsWith('null', i)) { i += 4; }
    else if (c === '-' || /[0-9]/.test(c)) {
      readNumber();
    } else {
      err('unexpected character "' + c + '" at offset ' + i);
      break;
    }
  }
  return problems;
}

// ------------------------------------------------------ canonical helpers ----

function canonicalCommand(cmd) {
  return String(cmd).trim().replace(/\\/g, '/').toLowerCase();
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let k = 0; k < ka.length; k++) {
    if (ka[k] !== kb[k]) return false;
    if (!deepEqual(a[ka[k]], b[kb[k]])) return false;
  }
  return true;
}

// Structurally strip every hook entry whose command matches the canonical
// Guardian command; drop matcher groups that become empty; drop events that
// become empty. Returns the stripped tree (or null if hooks/hooks.E missing).
function stripGuardianHooks(tree, canon) {
  if (!tree || typeof tree !== 'object' || !tree.hooks) return null;
  const hooks = tree.hooks;
  for (const evt of Object.keys(hooks)) {
    const groups = hooks[evt];
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { keptGroups.push(g); continue; }
      const keptInner = g.hooks.filter(h => !(h && typeof h === 'object' && typeof h.command === 'string' && canonicalCommand(h.command) === canon));
      if (keptInner.length === g.hooks.length) { keptGroups.push(g); continue; }
      if (keptInner.length === 0) continue; // group became empty -> drop
      keptGroups.push({ ...g, hooks: keptInner });
    }
    if (keptGroups.length === 0) delete hooks[evt]; // event became empty
    else hooks[evt] = keptGroups;
  }
  return tree;
}

// Normalize the stripped-tree residue for preservation comparison. Two trees
// are the same preserved state when they differ only by "hooks key absent"
// vs "hooks key present but empty": stripGuardianHooks returns null for a
// tree with no hooks, {} for a fully-emptied hooks object, and a tree may
// legitimately carry `hooks: {}` from before. Canonicalize: drop empty
// hooks objects (and normalize null to {}). Applied ONLY at the two
// preservation comparison sites, never recursively inside deepEqual.
function normalizeHookless(tree) {
  if (tree === null || tree === undefined) return {};
  if (tree && typeof tree === 'object' && !Array.isArray(tree) &&
      tree.hooks !== undefined &&
      typeof tree.hooks === 'object' && !Array.isArray(tree.hooks) &&
      Object.keys(tree.hooks).length === 0) {
    const copy = { ...tree };
    delete copy.hooks;
    return copy;
  }
  return tree;
}

function collectGuardianCount(tree, canon) {
  let count = 0;
  if (!tree || typeof tree !== 'object' || !tree.hooks) return 0;
  for (const evt of Object.keys(tree.hooks)) {
    const groups = tree.hooks[evt];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (h && typeof h === 'object' && typeof h.command === 'string' && canonicalCommand(h.command) === canon) count++;
      }
    }
  }
  return count;
}

// ------------------------------------------------------------ operations ----

function fail(msg) {
  process.stderr.write('settings-mutator: ' + msg + '\n');
  process.exit(1);
}

function loadSettings(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    fail('cannot read settings file: ' + e.code);
  }
  // Strip BOM (some editors write one).
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const problems = preflight(raw);
  if (problems.length > 0) {
    // Name the class of problem and the first offset — never the value.
    fail('unsupported JSON input (file unchanged): ' + problems.slice(0, 3).join('; ') +
      (problems.length > 3 ? '; +' + (problems.length - 3) + ' more' : ''));
  }
  let tree;
  try {
    tree = JSON.parse(raw);
  } catch (e) {
    fail('settings is not valid JSON (file unchanged)');
  }
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    fail('settings root must be a JSON object (file unchanged)');
  }
  return tree;
}

function writeSettingsAtomic(settingsPath, tree) {
  const dir = path.dirname(settingsPath);
  const tmp = path.join(dir, '.guardian-mutator.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(tree, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, settingsPath);
}

function opInstall(settingsPath, command) {
  // Retained for direct in-process use; the checked variant below is what
  // run() invokes so the pre-mutation snapshot is always available.
  return installChecked(settingsPath, command, null);
}

function installChecked(settingsPath, command, preTree) {
  if (preTree === null) preTree = loadSettings(settingsPath);
  const canon = canonicalCommand(command);
  const backup = readBackupOrCurrent(settingsPath);
  const tree = loadSettings(settingsPath); // preflighted fresh read
  if (!tree.hooks || typeof tree.hooks !== 'object') tree.hooks = {};

  const EVENTS = ['PostToolBatch', 'Stop', 'PreCompact', 'PostCompact'];
  let added = 0;
  for (const evt of EVENTS) {
    if (!Array.isArray(tree.hooks[evt])) tree.hooks[evt] = [];
    let already = false;
    for (const g of tree.hooks[evt]) {
      if (g && typeof g === 'object' && Array.isArray(g.hooks)) {
        for (const h of g.hooks) {
          if (h && typeof h === 'object' && typeof h.command === 'string' && canonicalCommand(h.command) === canon) already = true;
        }
      }
    }
    if (already) continue;
    const group = { hooks: [{ command: command }] };
    if (evt === 'PreCompact') group.matcher = 'auto';
    tree.hooks[evt] = [...tree.hooks[evt], group];
    added++;
  }

  if (added === 0) {
    process.stdout.write('settings-mutator: guardian hooks already present (idempotent no-op)\n');
    return;
  }

  // Write atomically, then prove preservation: remove ONLY Guardian-owned
  // additions and require deep semantic equality with the pre-mutation tree.
  try {
    writeSettingsAtomic(settingsPath, tree);
  } catch (e) {
    restore(settingsPath, backup);
    fail('write failed: ' + e.code + ' (settings restored)');
  }
  const post = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Preservation: post tree must exactly equal the pre tree with ONLY the
  // Guardian entries added — i.e. pre stripped of any pre-existing guardian
  // entries deep-equals post stripped of them. (Handles re-install over a
  // tree that already contained a stale guardian entry.) Semantic note:
  // "no hooks key at all" and "empty hooks object" are the same preserved
  // state, so the stripped trees are normalized before comparison.
  if (!deepEqual(normalizeHookless(stripGuardianHooks(JSON.parse(JSON.stringify(post)), canon)), normalizeHookless(stripGuardianHooks(JSON.parse(JSON.stringify(preTree)), canon)))) {
    restore(settingsPath, backup);
    fail('semantic preservation validation FAILED (settings restored from backup)');
  }
  process.stdout.write('settings-mutator: install ok (' + added + ' hook groups added, preservation verified)\n');
}

function opUninstall(settingsPath, command, preTree) {
  const canon = canonicalCommand(command);
  const backup = readBackupOrCurrent(settingsPath);
  const tree = loadSettings(settingsPath);
  const had = collectGuardianCount(tree, canon);
  if (had === 0) {
    process.stdout.write('settings-mutator: no guardian hooks found (idempotent no-op)\n');
    return;
  }
  stripGuardianHooks(tree, canon);
  try {
    writeSettingsAtomic(settingsPath, tree);
  } catch (e) {
    restore(settingsPath, backup);
    fail('write failed: ' + e.code + ' (settings restored)');
  }
  const post = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Preservation: post must deep-equal pre minus guardian entries (with the
  // same null/empty-hooks normalization as install).
  if (!deepEqual(normalizeHookless(post), normalizeHookless(stripGuardianHooks(JSON.parse(JSON.stringify(preTree)), canon)))) {
    restore(settingsPath, backup);
    fail('semantic preservation validation FAILED (settings restored from backup)');
  }
  process.stdout.write('settings-mutator: uninstall ok (' + had + ' guardian hook entries removed, preservation verified)\n');
}

function readBackupOrCurrent(settingsPath) {
  try {
    return fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    fail('cannot read settings file: ' + e.code);
  }
}

function restore(settingsPath, backupText) {
  try {
    fs.writeFileSync(settingsPath, backupText, 'utf8');
  } catch (e) {
    fail('CRITICAL: restore of backup failed: ' + e.code);
  }
}

// --------------------------------------------------------------- selftest ----

function selftest() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-mutator-'));
  const results = [];
  const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

  const base = {
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', NESTED: { a: [1, 2, { b: 'ćšž' }] } },
    theme: 'dark',
    mcpServers: { 'server-one': { command: 'mcp1', args: ['--x', 1] } },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ command: 'echo unrelated', timeout: 30 }] },
        { matcher: 'Read', hooks: [{ command: 'echo other2' }] }
      ],
      Stop: [{ hooks: [{ command: 'echo keepme' }] }]
    },
    unknownFutureField: { deep: { deeper: { deepest: [null, true, 1.25, ''] } } }
  };
  const GUARDIAN_CMD = 'node ~/.claude/guardian/guardian.js';

  function writeBase(name, tree, indent) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(tree, null, indent || 2), 'utf8');
    return p;
  }

  // 1. malformed JSON aborts, file unchanged
  {
    const p = path.join(dir, 'malformed.json');
    fs.writeFileSync(p, '{not json', 'utf8');
    let exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', p, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    check('malformed JSON -> abort, file unchanged', exit === 1 && fs.readFileSync(p, 'utf8') === '{not json');
  }
  // 2. nested duplicate key aborts, file unchanged
  {
    const p = path.join(dir, 'dupkey.json');
    fs.writeFileSync(p, '{"a":1,"hooks":{"x":[{"hooks":[{"command":"c"}]}]},"env":{"k":"v","k":"w"}}', 'utf8');
    let exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', p, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    check('duplicate key -> abort, file unchanged', exit === 1 && fs.readFileSync(p, 'utf8') === '{"a":1,"hooks":{"x":[{"hooks":[{"command":"c"}]}]},"env":{"k":"v","k":"w"}}');
  }
  // 3. unsafe numeric literal aborts, file unchanged
  {
    const p = path.join(dir, 'bignum.json');
    fs.writeFileSync(p, '{"a":12345678901234567890123}', 'utf8');
    let exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', p, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    check('unsafe integer -> abort, file unchanged', exit === 1 && fs.readFileSync(p, 'utf8') === '{"a":12345678901234567890123}');
  }
  // 4. install once -> 4 events, unrelated preserved semantically
  const pMain = writeBase('main.json', base);
  let exit = 0;
  try { require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', pMain, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
  catch (e) { exit = e.status; }
  {
    const after = JSON.parse(fs.readFileSync(pMain, 'utf8'));
    check('install once: exit 0', exit === 0);
    check('install once: 4 guardian events present',
      ['PostToolBatch', 'Stop', 'PreCompact', 'PostCompact'].every(e => Array.isArray(after.hooks[e]) && after.hooks[e].length >= 1));
    const pcGroup = after.hooks.PreCompact.find(g => g.hooks.some(h => h.command === GUARDIAN_CMD));
    check('install once: PreCompact has matcher auto', pcGroup && pcGroup.matcher === 'auto');
    // unrelated settings deep-equal
    const strippedAfter = JSON.parse(JSON.stringify(after));
    stripGuardianHooks(strippedAfter, canonicalCommand(GUARDIAN_CMD));
    check('install once: unrelated settings deep-equal', deepEqual(strippedAfter, base));
  }
  // 5. install twice -> idempotent, no duplicates
  {
    exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', pMain, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    const after2 = JSON.parse(fs.readFileSync(pMain, 'utf8'));
    check('install twice: exit 0', exit === 0);
    check('install twice: no duplicate guardian hooks', collectGuardianCount(after2, canonicalCommand(GUARDIAN_CMD)) === 4);
  }
  // 6. uninstall once -> exact pre-image
  {
    exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'uninstall', '--settings', pMain, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    const afterU = JSON.parse(fs.readFileSync(pMain, 'utf8'));
    check('uninstall once: exit 0', exit === 0);
    check('uninstall once: unrelated events kept', Array.isArray(afterU.hooks.PreToolUse) && afterU.hooks.PreToolUse.length === 2 && Array.isArray(afterU.hooks.Stop));
    check('uninstall once: deep-equal to original', deepEqual(afterU, base));
  }
  // 7. uninstall twice -> safe no-op
  {
    exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'uninstall', '--settings', pMain, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    const afterU2 = JSON.parse(fs.readFileSync(pMain, 'utf8'));
    check('uninstall twice: exit 0, still deep-equal', exit === 0 && deepEqual(afterU2, base));
  }
  // 7b. EMPTY first install (regression: preservation compare saw null vs
  // {hooks:{}} and failed closed) -> install + uninstall must both succeed.
  {
    const pEmpty = path.join(dir, 'empty.json');
    fs.writeFileSync(pEmpty, '{}', 'utf8');
    exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', pEmpty, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    check('empty-settings install: exit 0', exit === 0, 'exit=' + exit);
    check('empty-settings install: 4 hooks added',
      collectGuardianCount(JSON.parse(fs.readFileSync(pEmpty, 'utf8')), canonicalCommand(GUARDIAN_CMD)) === 4);
    exit = 0;
    try { require('child_process').execFileSync(process.execPath, [__filename, 'uninstall', '--settings', pEmpty, '--command', GUARDIAN_CMD], { stdio: 'pipe' }); }
    catch (e) { exit = e.status; }
    check('empty-settings uninstall: exit 0, hooks key empty/absent', exit === 0 &&
      deepEqual(normalizeHookless(JSON.parse(fs.readFileSync(pEmpty, 'utf8'))), {}));
  }
  // 8. uninstall keeps other hooks inside a shared matcher group
  {
    const shared = JSON.parse(JSON.stringify(base));
    shared.hooks.PostToolBatch = [{ matcher: 'm', hooks: [{ command: 'echo unrelated' }, { command: GUARDIAN_CMD }] }];
    const pS = writeBase('shared.json', shared);
    require('child_process').execFileSync(process.execPath, [__filename, 'uninstall', '--settings', pS, '--command', GUARDIAN_CMD], { stdio: 'pipe' });
    const afterS = JSON.parse(fs.readFileSync(pS, 'utf8'));
    check('uninstall: shared group keeps unrelated hooks',
      afterS.hooks.PostToolBatch.length === 1 && afterS.hooks.PostToolBatch[0].hooks.length === 1 && afterS.hooks.PostToolBatch[0].hooks[0].command === 'echo unrelated');
  }
  // 9. path-separator/case canonicalization on uninstall
  {
    const variant = JSON.parse(JSON.stringify(base));
    variant.hooks.PostCompact = [{ hooks: [{ command: 'NODE C:\\USERS\\X\\.CLAUDE\\GUARDIAN\\GUARDIAN.JS' }] }];
    const pV = writeBase('variant.json', variant);
    require('child_process').execFileSync(process.execPath, [__filename, 'uninstall', '--settings', pV, '--command', 'node C:/USERS/X/.claude/guardian/guardian.js'.replace('X', 'x')], { stdio: 'pipe' });
    const afterV = JSON.parse(fs.readFileSync(pV, 'utf8'));
    check('uninstall: canonical command match (seps/case)', afterV.hooks.PostCompact === undefined && deepEqual({ ...afterV }, { ...base }));
  }
  // 10. unicode + deep nesting survive install round-trip
  {
    const deep = JSON.parse(JSON.stringify(base));
    let node = deep.unknownFutureField;
    for (let d = 0; d < 8; d++) { node.next = { v: 'cépic-' + d, n: d }; node = node.next; }
    const pD = writeBase('deep.json', deep);
    require('child_process').execFileSync(process.execPath, [__filename, 'install', '--settings', pD, '--command', GUARDIAN_CMD], { stdio: 'pipe' });
    const afterD = JSON.parse(fs.readFileSync(pD, 'utf8'));
    const st2 = JSON.parse(JSON.stringify(afterD));
    stripGuardianHooks(st2, canonicalCommand(GUARDIAN_CMD));
    check('install: depth>=6 + unicode preserved', deepEqual(st2, deep));
  }

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    process.stdout.write((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.pass ? '' : '   [' + r.detail + ']') + '\n');
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
}

// -------------------------------------------------------------------- main --

function run() {
  const argv = process.argv.slice(2);
  if (argv.includes('selftest')) return selftest();
  const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
  const mode = argv[0];
  const settingsPath = get('--settings');
  const command = get('--command');
  if ((mode !== 'install' && mode !== 'uninstall' && mode !== 'check') || !settingsPath) {
    process.stderr.write('usage: settings-mutator.js install|uninstall --settings <path> --command "<cmd>"\n       settings-mutator.js check --settings <path>\n       settings-mutator.js selftest\n');
    process.exit(2);
  }
  if (mode === 'check') {
    loadSettings(settingsPath);
    process.stdout.write('settings-mutator: check ok (supported JSON input)\n');
    return;
  }
  // Pre-mutation snapshot (already preflighted by loadSettings inside ops).
  let preTree = null;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    preTree = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    fail('cannot read/parse settings pre-mutation (file unchanged)');
  }
  if (mode === 'install') return installChecked(settingsPath, command, preTree);
  return opUninstall(settingsPath, command, preTree);
}

run();
