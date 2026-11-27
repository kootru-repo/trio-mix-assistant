// A game keeps a pinned copy of the engine in its own repository (README.md, docs/adr/0001-vendored-copy.md): no second repository or token
// in the game's CI, and the copy is a protected path, so a worker cannot change the engine that judges its work. VENDOR.json in the copy
// records the engine's version and commit and a hash of every file; the gate's vendor step checks the copy still matches it.
// This file does not import lib.mjs: sync runs from the engine's own repository, where there is no game and no enhance.json.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MANIFEST = 'VENDOR.json';
const SKIP = new Set(['out', '__pycache__', 'node_modules', MANIFEST]);
/** line endings do not count: a checkout that turns LF into CR LF has not edited the engine */
const hash = f => createHash('sha256').update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

/** every engine file under dir, relative, with forward slashes */
export function files(dir) {
  const out = [];
  const walk = d => { for (const n of readdirSync(d)) { if (SKIP.has(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p).split('\\').join('/')); } };
  walk(dir); return out.sort();
}

/** the engine's version and commit, read from its own repository */
export function source(engineDir) {
  const repo = dirname(engineDir), pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const g = args => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  const dirty = (g(['status', '--porcelain', '--', 'engine']) ?? '').length > 0;
  return { engine: pkg.name, version: pkg.version, commit: (g(['rev-parse', '--short', 'HEAD']) ?? 'none') + (dirty ? '-dirty' : '') };
}

/** copy the engine into a game: files the previous copy had and this one does not are removed; out/ is left alone */
export function sync(engineDir, targetDir) {
  const src = source(engineDir), now = files(engineDir), mf = join(targetDir, MANIFEST);
  const before = existsSync(mf) ? Object.keys(JSON.parse(readFileSync(mf, 'utf8')).files ?? {}) : [];
  for (const f of before) if (!now.includes(f)) rmSync(join(targetDir, f), { force: true });
  for (const f of now) { mkdirSync(dirname(join(targetDir, f)), { recursive: true }); copyFileSync(join(engineDir, f), join(targetDir, f)); }
  const manifest = { ...src, synced: new Date().toISOString(), about: 'A pinned copy of the enhancement engine. Never edit it here: change the engine repository and sync again (node <engine repo>/engine/cli.mjs sync <game>).', files: Object.fromEntries(now.map(f => [f, hash(join(targetDir, f))])) };
  writeFileSync(mf, JSON.stringify(manifest, null, 1) + '\n');
  return { ...src, files: now.length, removed: before.filter(f => !now.includes(f)) };
}

/** the gate's vendor step: does this copy still match its manifest? */
export function verifyVendor(dir = import.meta.dirname) {
  const mf = join(dir, MANIFEST);
  if (!existsSync(mf)) {
    if (existsSync(join(dirname(dir), 'package.json')) && JSON.parse(readFileSync(join(dirname(dir), 'package.json'), 'utf8')).name === 'enhance-engine') return { status: 'pass', lines: ['running from the engine\'s own repository, not a vendored copy'] };
    return { status: 'inconclusive', lines: [`no ${MANIFEST} beside the engine: this copy was not made by sync, so nothing says which engine it is`] };
  }
  const m = JSON.parse(readFileSync(mf, 'utf8')), have = files(dir), bad = [];
  for (const [f, h] of Object.entries(m.files)) { if (!have.includes(f)) bad.push(`${f}: missing`); else if (hash(join(dir, f)) !== h) bad.push(`${f}: changed`); }
  for (const f of have) if (!(f in m.files)) bad.push(`${f}: added`);
  if (bad.length) return { status: 'fail', lines: [...bad, `Fix: the engine is never edited inside a game. Restore these files (git checkout <base> -- <path>), or change the engine repository and sync again.`] };
  return { status: 'pass', lines: [`${m.engine} ${m.version} at ${m.commit}: ${have.length} files as synced`] };
}
