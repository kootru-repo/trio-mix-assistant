// The coverage map (README.md): every facet the engine can check, built from what the game's repository already lists (coverage.sources in
// enhance.json: an aspects file, a folder of target pictures, a file listing scenes; plus the probes and the mutation targets), with when each
// was last verified and how. The scheduler hands out the weakest cells first: failing, then never judged against its target, then stale,
// then aspects not done.
//   node <engine>/coverage.mjs map            the cells, by kind, with their last result
//   node <engine>/coverage.mjs next [--n 3]   work orders for the next cells (what to do, how it is accepted, what not to touch)
// Its state is derived from the shared records (state.mjs): every gate run, judge verdict, claim and outcome, whichever worktree made it.
// A claimed cell is not handed out again; a cell rejected park_after times since its last success is parked for the owner; a worker is
// told why the last attempts on its cell were rejected (the lessons). Cells in one round are picked from different areas, so their
// branches do not collide when they are integrated.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, CFG, ENGINE_REL, STATE as SHARED, globRe, matches } from './lib.mjs';
import { records, outcomes, claims, history } from './state.mjs';
import { open as openRequests, cellId as requestCell } from './requests.mjs';

const SRC = CFG.coverage.sources ?? {};

/** probes.glob has exactly one *, standing for a probe's name: its two sides, so a name goes in and comes out without a replace */
export function probeGlob() {
  const g = CFG.probes?.glob; if (!g) return null;
  const parts = g.split('*'); if (parts.length !== 2) throw new Error(`enhance.json probes.glob must hold exactly one * (the probe's name), not ${JSON.stringify(g)}`);
  return { glob: g, before: parts[0], after: parts[1], file: n => parts[0] + n + parts[1] };
}

/** the probes named by enhance.json probes.glob */
export function probeNames() {
  const pg = probeGlob(); if (!pg) return [];
  const g = pg.glob, dir = dirname(g), re = globRe(g), a = pg.before, b = pg.after;
  return existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).map(f => `${dir}/${f}`).filter(f => re.test(f)).map(f => f.slice(a.length, f.length - b.length)).sort() : [];
}

export function cells() {
  const out = [];
  // the owner's requests (requests.mjs, docs/adr/0006): first in the queue, in the order they were added
  for (const r of openRequests()) out.push({ id: requestCell(r.n), kind: 'request', title: r.text.length > 70 ? r.text.slice(0, 67) + '...' : r.text, detail: r.text, files: r.files ?? [], check: r.check ?? null });
  if (SRC.aspects) {
    // aspects: a JSON file with { aspects: [{ id, aspect, what, status, notes }] }; files named in the notes are where a worker starts
    const aspects = JSON.parse(readFileSync(join(ROOT, SRC.aspects), 'utf8')).aspects;
    for (const a of aspects) out.push({ id: `A:${a.id}`, kind: 'aspect', title: a.aspect, detail: a.what, status: a.status, files: (a.notes ?? '').match(/src\/[\w/.-]+/g) ?? [] });
  }
  if (SRC.targets && existsSync(join(ROOT, SRC.targets))) for (const f of readdirSync(join(ROOT, SRC.targets)).filter(f => f.endsWith('.png')).sort()) out.push({ id: `T:${f.slice(0, -4)}`, kind: 'target', title: f.slice(0, -4).replace(/_/g, ' '), target: `${SRC.targets}/${f}` });
  if (SRC.scenes) {
    // scenes: { file, block, name }: block is a regex whose first group holds the scene list, name a regex whose first group is one scene's name
    const sc = readFileSync(join(ROOT, SRC.scenes.file), 'utf8').match(new RegExp(SRC.scenes.block));
    for (const m of (sc ? sc[1] : '').matchAll(new RegExp(SRC.scenes.name, 'g'))) out.push({ id: `S:${m[1]}`, kind: 'scene', title: `scene ${m[1]}` });
  }
  for (const n of probeNames()) out.push({ id: `P:${n}`, kind: 'probe', title: `probe ${n}` });
  for (const t of CFG.mutate.targets) out.push({ id: `M:${t.file}`, kind: 'mutation', title: `tests bite on ${t.file}` });
  return out;
}

/** each cell's last gate result and last judge verdict, derived from every record in the shared state (oldest first, so the newest wins) */
export function cellState(cs = cells()) {
  const s = {}, sceneIds = cs.filter(c => c.kind === 'scene').map(c => c.id);
  for (const rec of records()) {
    const at = { date: rec.started, commit: rec.commit, tier: rec.tier, branch: rec.branch };
    for (const r of rec.results ?? []) {
      const ids = r.name === 'scenes' ? sceneIds : r.name.startsWith('probe:') ? [`P:${r.name.slice(6)}`] : r.name.startsWith('mutate:') ? [`M:${r.name.slice(7)}`] : [];
      for (const id of ids) s[id] = { ...(s[id] ?? {}), last: { ...at, status: r.status } };
    }
  }
  const jd = join(SHARED, 'judge');
  if (existsSync(jd)) for (const f of readdirSync(jd).filter(f => f.endsWith('.json')).sort()) { try { const j = JSON.parse(readFileSync(join(jd, f), 'utf8')); s[j.cell] = { ...(s[j.cell] ?? {}), judged: j }; } catch { /* a broken note is skipped */ } }
  return s;
}

/** a judge tally for a cell, kept apart from pass and fail (advisory until the judge is calibrated); one file per verdict */
export function noteJudge(cellId, tally) {
  const d = join(SHARED, 'judge'); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`), JSON.stringify({ cell: cellId, date: new Date().toISOString(), ...tally }, null, 1) + '\n');
}

/** the part of the game a cell's work touches, so one round does not send two workers into the same files */
export function area(c) {
  if (c.kind === 'probe') { const hit = Object.entries(CFG.probes?.map ?? {}).find(([, ps]) => ps.includes(c.id.slice(2))); return hit ? hit[0] : `probe:${c.id}`; }
  if (c.kind === 'mutation') return dirname(c.id.slice(2));
  if (c.kind === 'target' || c.kind === 'scene') return 'visual';
  if (c.kind === 'request') return c.files?.length ? dirname(c.files[0]) : `request:${c.id}`;
  return c.files?.length ? dirname(c.files[0]) : `aspect:${c.id}`;
}

export function ranked(now = Date.now()) {
  const cs = cells(), s = cellState(cs), stale = CFG.coverage.stale_days * 864e5, claimed = new Map(claims(now).map(c => [c.cell, c])), os = outcomes();
  const score = c => {
    const st = s[c.id] ?? {}, age = st.last ? now - Date.parse(st.last.date) : Infinity, h = history(c.id, os), cl = claimed.get(c.id);
    if (cl) return [8, cl.status === 'review' ? `waiting for the owner (${cl.branch ?? 'a branch'})` : `claimed by round ${cl.round ?? '?'}`];
    if (c.kind === 'request' && !h.parked) return [-1, 'the owner asked for it'];
    if (h.parked) return [7, `parked: rejected ${h.failures} times since its last success; the owner decides (lessons: ${h.lessons[0] ?? ''})`];
    if (st.last && ['fail', 'flaky', 'quarantined'].includes(st.last.status)) return [0, `last ${st.last.tier} gate: ${st.last.status} at ${st.last.commit}`];
    if (c.kind === 'target' && !st.judged) return [1, 'never judged against its target picture'];
    if (c.kind === 'target' && st.judged?.result !== 'candidate' && st.judged?.result !== 'same') return [1, `last judged ${st.judged.result}`];
    if (st.last?.status === 'inconclusive' || st.last?.status === 'skipped') return [2, `the last ${st.last.tier} gate could not check it (${st.last.status})`];
    if (c.kind !== 'aspect' && c.kind !== 'target' && age > stale) return [2, st.last ? `not verified for ${Math.round(age / 864e5)} days` : 'never verified by the gate'];
    if (c.kind === 'aspect' && c.status !== 'done') return [3, `aspect status: ${c.status}`];
    return [9, 'up to date'];
  };
  return cs.map(c => ({ ...c, rank: score(c), lessons: history(c.id, os).lessons })).sort((a, b) => a.rank[0] - b.rank[0] || a.id.localeCompare(b.id));
}

/** the next cells to work on: wanting work (rank below 7: not claimed, not parked), at most one per area */
export function pick(n, all = ranked()) {
  const out = [], used = new Set();
  for (const c of all.filter(c => c.rank[0] < 7)) { const a = area(c); if (used.has(a)) continue; used.add(a); out.push(c); if (out.length >= n) break; }
  return out;
}

/** what a work order says for each kind of cell; a game may replace any of these in enhance.json coverage.orders (a list of lines each) */
export const ORDERS = {
  target: ['Make the game match {target} more closely.', 'Find where it is drawn, change it, picture it on your own server before and after, and build a judge packet: node {engine}/judge.mjs packet --cell {id} --base BASE.png --cand CAND.png --target {target}'],
  scene: ['Find why scene {name} changed or failed, and fix the game, never the scene.'],
  probe: ['Make the probe pass for the right reason: {probe_file}, against your own server. Never edit the probe to pass.'],
  mutation: ['Add checks that catch the surviving mutants: node {engine}/mutate.mjs {name}. A survivor that cannot change behaviour is noted, not chased.'],
  aspect: ['Finish the aspect: {detail}'],
  request: ['The owner asked for this, in their own words: "{detail}"', 'Find where it lives in the game, fix or build it properly (not a workaround), and show it works: a test or probe that fails before your change and passes after, when one can be written.'],
};
export const ACCEPTED = 'Accepted when: node {engine}/gate.mjs merge --port YOUR_PORT exits 0 (and, for a target, the judge prefers the candidate in both orders).';
export const NEVER = 'Never: change a protected path (enhance.json "protected"), tune a value off the allowlist, or push.';

export function workOrder(c) {
  const name = c.id.slice(2), vars = { id: c.id, name, title: c.title, target: c.target ?? '', detail: c.detail ?? '', engine: ENGINE_REL || '.', probe_file: probeGlob()?.file(name) ?? name };
  const put = s => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const how = (CFG.coverage.orders?.[c.kind] ?? ORDERS[c.kind]).map(put);
  if ((c.kind === 'aspect' || c.kind === 'request') && c.files?.length) how.push(`Start from: ${c.files.join(', ')}`);
  if (c.kind === 'request' && c.check) how.push(`It counts as done only when this check passes on the integration branch too: ${c.check}`);
  const lessons = c.lessons?.length ? ['Earlier attempts on this cell were rejected; do not repeat them:', ...c.lessons.map(l => `- ${l}`)] : [];
  return [`## ${c.id}: ${c.title}`, `Why now: ${c.rank[1]}.`, ...how.filter(Boolean), ...lessons, put(CFG.coverage.accepted || ACCEPTED), put(CFG.coverage.never || NEVER)].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('coverage.mjs')) {
  const cmd = process.argv[2] ?? 'map', n = Number(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 3), all = ranked();
  if (cmd === 'next') console.log(pick(n, all).map(workOrder).join('\n\n'));
  else {
    const by = {}; for (const c of all) (by[c.kind] ??= []).push(c);
    for (const [k, cs] of Object.entries(by)) console.log(`${k}: ${cs.length} cells, ${cs.filter(c => c.rank[0] < 7).length} want work${cs.some(c => c.rank[0] === 7) ? `, ${cs.filter(c => c.rank[0] === 7).length} parked` : ''}${cs.some(c => c.rank[0] === 8) ? `, ${cs.filter(c => c.rank[0] === 8).length} claimed` : ''}`);
    if (!records().length) console.log('(no gate has run yet: every gate-checked cell counts as never verified)');
  }
}
