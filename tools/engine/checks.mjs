// The two checks that keep a worker from moving the goalposts (README.md): protected paths and the tuning allowlist.
// Both are pure: they take the list of changes and the files' text, and return { status, lines }. gate.mjs feeds them from git.
import { matches } from './lib.mjs';

/**
 * Protected paths. frozen: no change at all (added, modified or deleted). append: new files may be added, existing ones not changed or removed.
 * A declared re-record (the record env flag set) turns a failure into a pass that says what was re-recorded: a tripwire, not a lock (the lock is CI).
 * writable (enhance.json "writable", docs/adr/0007): when given, a path no protected rule names may change only if it matches one of these globs.
 * Protected rules win over it, and a declared re-record never lets a change outside it pass.
 */
export function protectCheck(changes, rules, { declared = false, allowed = [], writable = [] } = {}) {
  const hits = [], regated = [], outside = [];
  for (const [path, how] of changes) {
    const rule = rules.find(r => matches(path, r.paths));
    if (!rule) { if (writable.length && !matches(path, writable)) outside.push(`${path}: ${{ A: 'added', M: 'changed', D: 'deleted' }[how] ?? how} outside the writable paths (${writable.join(', ')})`); continue; }
    if (allowed.includes(path)) { regated.push(path); continue; }   // re-recorded by the trusted gate after an approved judge verdict (docs/adr/0004)
    if (rule.mode === 'frozen' || how !== 'A') hits.push({ path, how, rule });
  }
  if (outside.length) return { status: 'fail', lines: [...outside, ...hits.map(h => `${h.path}: ${{ A: 'added', M: 'changed', D: 'deleted' }[h.how] ?? h.how} (${h.rule.mode}). ${h.rule.why}`), 'Fix: a round changes only the writable paths in enhance.json. Restore the others to the base commit (git checkout <base> -- <path>).'] };
  if (!hits.length) return { status: 'pass', lines: regated.length ? ['re-recorded by the gate after the judge preferred the change in both orders:', ...regated] : ['no protected path changed'] };
  const lines = hits.map(h => `${h.path}: ${{ A: 'added', M: 'changed', D: 'deleted' }[h.how] ?? h.how} (${h.rule.mode}). ${h.rule.why}`);
  if (declared) return { status: 'pass', lines: ['declared re-record of:', ...lines] };
  return { status: 'fail', lines: [...lines, 'Fix: restore these files to the base commit (git checkout <base> -- <path>). If a re-record is really meant, it is the owner\'s call, or the gate\'s after an approved judge verdict.'] };
}

/**
 * A machine-local override file (enhance.json local_override: git-ignored, so protect cannot see it) may override settings, spend caps included.
 * In the gate's tree only the listed keys may differ (a worker needs at most its own dev port). section: the part of the file checked (whole file when absent).
 */
export function localCheck(local, allowKeys, { file = 'the local override file', section = null } = {}) {
  if (!local) return { status: 'pass', lines: [`no ${file}`] };
  const bad = [...leaves((section ? local[section] : local) ?? {})].map(([k]) => k).filter(k => !allowKeys.includes(k));
  return bad.length ? { status: 'fail', lines: [`${file} overrides ${bad.join(', ')}; in a gated tree it may set only ${allowKeys.join(', ')}. Fix: remove those keys (spend caps and paid services are the owner's).`] } : { status: 'pass', lines: [`${file} sets only ${allowKeys.join(', ') || 'nothing'}`] };
}

/** every leaf of a JSON value, as dotted path -> value; arrays are one leaf (compared whole) */
export function leaves(v, prefix = '', out = new Map()) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) { for (const k of Object.keys(v)) leaves(v[k], prefix ? `${prefix}.${k}` : k, out); }
  else out.set(prefix, v);
  return out;
}

/**
 * Tuning allowlist, default deny. before and after: Map of file name -> parsed JSON (null when the file is absent).
 * A changed, added or removed leaf passes only if "file:path" is in allow, the new value is a finite number, whole if int, and inside [min, max].
 */
export function tuningCheck(before, after, allow, { declared = false } = {}) {
  const bad = [], ok = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const a = leaves(before.get(file) ?? {}), b = leaves(after.get(file) ?? {});
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const was = a.get(key), now = b.get(key);
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      const id = `${file}:${key}`, rule = allow[id];
      if (!rule) { bad.push(`${id}: ${JSON.stringify(was)} -> ${JSON.stringify(now)} is not on the tuning allowlist`); continue; }
      if (typeof now !== 'number' || !Number.isFinite(now)) bad.push(`${id}: ${JSON.stringify(now)} is not a finite number`);
      else if (rule.int && !Number.isInteger(now)) bad.push(`${id}: ${now} must be a whole number`);
      else if (now < rule.min || now > rule.max) bad.push(`${id}: ${now} is outside ${rule.min}..${rule.max}${rule.proposal ? ' (a proposed range, not yet confirmed by the owner)' : ''}`);
      else ok.push(`${id}: ${was} -> ${now}`);
    }
  }
  if (!bad.length) return { status: 'pass', lines: ok.length ? ['tuned within the allowlist:', ...ok] : ['no tuning value changed'] };
  if (declared) return { status: 'pass', lines: ['declared owner config edit:', ...bad, ...ok] };
  return { status: 'fail', lines: [...bad, 'Fix: put these values back, or tune only keys listed in enhance.json tuning.allow, inside their ranges. Adding a key to the list is the owner\'s call.'] };
}
