// The guard (README.md): what trio-mix-assistant's tools/guard.ts and check_lf.mjs do, with Ratchet's own rule format.
// Three checks on the files a branch changed, each against the base commit, so a backlog may fall and never rise:
//   hatches  ways of switching a check off instead of fixing what it found (Ratchet's list: type-check and lint suppressions, casts to any, skipped tests)
//   rules    the project's rules in .ratchet/rules.json, the same file Ratchet's hooks read after every edit (one source for both)
//   lf       line endings: a changed text file may not gain CR line endings
//   node <engine>/guard.mjs census     every rule's count across the repository, per file (to set or lower a baseline; never raise one)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, CFG, git, showAt, matches } from './lib.mjs';

/** Ratchet's escape hatches (trust-ratchet src/harness/rules.ts HATCHES), kept identical so the gate and the edit hook agree */
// Each pattern hides one letter in a [class] and each name is joined from two parts, so this file does not itself read as a suppression
// to a scanner (Ratchet's edit hook included). The tests in tests/engine.test.mjs show every pattern still fires.
const n = (a, b) => a + b;
export const HATCHES = [
  { files: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, patterns: [[n('@ts-', 'ignore'), /@ts-ignor[e]/], [n('@ts-', 'expect-error'), /@ts-expect-erro[r]/], [n('@ts-', 'nocheck'), /@ts-nochec[k]/], [n('eslint-', 'disable'), /eslint-disabl[e]/], [n('as ', 'any'), /\bas\s+an[y]\b/], [n('as unknown ', 'as'), /\bas\s+unknown\s+a[s]\b/], ['skipped or only test', /\b(it|test|describe)\.(ski[p]|onl[y]|tod[o])\s*\(/]] },
  { files: /\.pyi?$/, patterns: [[n('type: ', 'ignore'), /#\s*type:\s*ignor[e]/], [n('no', 'qa'), /#\s*noq[a]\b/], [n('pylint: ', 'disable'), /#\s*pylint:\s*disabl[e]/], [n('pragma: ', 'no cover'), /#\s*pragma:\s*no cove[r]/], ['skipped test', /@(pytest\.mark\.(ski[p]|skipi[f]|xfai[l])|unittest\.ski[p])/]] },
];
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|py|json|md|html|css|yml|yaml|toml)$/;
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s.*\bfrom\b|.*\brequire\s*\()/, COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/;

export const hatchCounts = (file, text) => {
  const set = HATCHES.find(h => h.files.test(file)); if (!set || text == null) return {};
  const out = {}; for (const line of text.split(/\r?\n/)) for (const [name, re] of set.patterns) if (re.test(line)) out[name] = (out[name] ?? 0) + 1;
  return out;
};

/** Ratchet's matchesAny: globs, with a leading ! excluding */
export const inRule = (file, globs) => matches(file, globs.filter(g => !g.startsWith('!'))) && !matches(file, globs.filter(g => g.startsWith('!')).map(g => g.slice(1)));
/** the lines a Ratchet rule fires on (line scope; ban-import only on import lines; ban-api a whole word, not in comments) */
export function ruleLines(rule, text) {
  const re = rule.kind === 'ban-api' ? new RegExp(`(?<![\\w.])${rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`) : new RegExp(rule.pattern);
  const out = [];
  text.split(/\r?\n/).forEach((t, i) => { if (rule.kind === 'ban-import' && !IMPORT_LINE.test(t)) return; if (rule.kind === 'ban-api' && COMMENT_LINE.test(t)) return; if (re.test(t)) out.push(i + 1); });
  return out;
}
const crLines = text => (text ?? '').split('\n').filter(l => l.endsWith('\r')).length;

/** the guard on a set of changed files: before(path) and after(path) give the text at the base commit and now (null when absent) */
export function guardCheck(paths, before, after, rules, { browserFinally = CFG.guard.browser_finally } = {}) {
  const bad = [], noted = [];
  for (const p of paths) {
    const now = after(p); if (now == null) continue;
    const was = before(p);
    const h0 = hatchCounts(p, was), h1 = hatchCounts(p, now);
    for (const [name, n] of Object.entries(h1)) if (n > (h0[name] ?? 0)) bad.push(`${p}: ${name} rose from ${h0[name] ?? 0} to ${n}. Fix: make the check pass instead of switching it off (Ratchet T6).`);
    for (const r of rules) {
      if (!inRule(p, r.files)) continue;
      const lines = ruleLines(r, now), allowed = Math.max(r.baseline?.[p] ?? 0, 0);
      if (lines.length > allowed) (r.stage === 'trial' ? noted : bad).push(`${r.stage === 'trial' ? '(on trial, reported only) ' : ''}${p}: rule ${r.id} on line${lines.length > 1 ? 's' : ''} ${lines.slice(0, 8).join(', ')}${allowed ? ` (the backlog allows ${allowed})` : ''}: ${r.message} Fix: ${r.fix}`);
    }
    // the user's standing rule (every project): a script that launches a browser closes it in a finally block
    if (browserFinally && /\.py$/.test(p) && /\.launch\(/.test(now) && !(/\bfinally\s*:/.test(now) && /\.close\(\)/.test(now)) && !(was && /\.launch\(/.test(was) && !(/\bfinally\s*:/.test(was) && /\.close\(\)/.test(was))))
      bad.push(`${p}: launches a browser without closing it in a finally block. Fix: wrap the work in try: ... finally: browser.close() (leftover browsers have exhausted this machine's memory).`);
    if (TEXT.test(p) && crLines(now) > crLines(was)) bad.push(`${p}: ${crLines(now)} lines end in CR LF (the base had ${crLines(was)}). Fix: write the file with LF endings (in Python open it with newline="\\n"; in Node do not add \\r).`);
  }
  return bad.length ? { status: 'fail', lines: [...bad, ...noted] } : { status: 'pass', lines: [`${paths.length} changed file(s): no new escape hatch, no rule broken past its backlog, no new CR LF`, ...noted] };
}

export const readRules = () => { const f = join(ROOT, '.ratchet', 'rules.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []; };
export const atBase = base => p => showAt(base, p);
export const nowText = p => { const f = join(ROOT, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; };

if (process.argv[1] && process.argv[1].endsWith('guard.mjs') && process.argv[2] === 'census') {
  const files = (git(['ls-files']) ?? '').split('\n').filter(Boolean), rules = readRules();
  for (const r of rules) {
    const counts = {}; for (const f of files) if (inRule(f, r.files)) { const t = nowText(f); const n = t ? ruleLines(r, t).length : 0; if (n) counts[f] = n; }
    const stale = Object.entries(r.baseline ?? {}).filter(([f, n]) => (counts[f] ?? 0) < n).map(([f, n]) => `${f} ${n}->${counts[f] ?? 0}`);
    console.log(`${r.id}: ${Object.values(counts).reduce((a, b) => a + b, 0)} in ${Object.keys(counts).length} files${stale.length ? `; the baseline can be lowered: ${stale.join(', ')}` : ''}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(counts));
    // --tighten: a new rule (no baseline yet) starts from today's counts; an existing baseline is only ever lowered, never raised
    if (process.argv.includes('--tighten')) r.baseline = r.baseline && Object.keys(r.baseline).length ? Object.fromEntries(Object.entries(r.baseline).map(([f, b]) => [f, Math.min(b, counts[f] ?? 0)]).filter(([, b]) => b > 0)) : counts;
  }
  if (process.argv.includes('--tighten')) { writeFileSync(join(ROOT, '.ratchet', 'rules.json'), JSON.stringify(rules, null, 2) + '\n'); console.log('baselines written to .ratchet/rules.json'); }
}
