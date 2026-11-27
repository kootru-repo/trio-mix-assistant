// The owner's requests (docs/adr/0006): specific things to fix or build in the game, in the owner's own words. They come first in the queue,
// before every other cell, in the order they were added; a worker gets the words verbatim. A request is done when its branch passes the merge
// gate and lands on the integration branch, and, when it names a check, when that check passes there too.
//   node <engine>/requests.mjs add "what to fix" [--files src/a.ts,src/b.ts] [--check "command that exits 0 when it is done"]
//   node <engine>/requests.mjs list [--all]
//   node <engine>/requests.mjs done N | drop N
// Kept in the main tree's shared state (out/requests.json: not tracked, so the queue never makes the owner's tree dirty). Games only: a
// request that reads as research is refused (engine/scope.mjs).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from './lib.mjs';
import { goalRefusal } from './scope.mjs';

const FILE = join(STATE, 'requests.json');
export const load = () => { try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { next: 1, items: [] }; } catch { return { next: 1, items: [] }; } };
const save = s => { mkdirSync(STATE, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 1) + '\n'); };
export const cellId = n => `R:${String(n).padStart(3, '0')}`;
export const numberOf = id => (/^R:(\d+)$/.exec(id) ? Number(/^R:(\d+)$/.exec(id)[1]) : null);
export const open = () => load().items.filter(r => r.status === 'open');
export const find = n => load().items.find(r => r.n === n) ?? null;

export function add(text, { files = [], check = null } = {}) {
  text = String(text ?? '').trim(); if (!text) return { error: 'an empty request' };
  const no = goalRefusal(text); if (no) return { error: no };
  const s = load(), r = { n: s.next++, text, files, check, status: 'open', added: new Date().toISOString() };
  s.items.push(r); save(s); return { request: r };
}
export function setStatus(n, status, extra = {}) {
  const s = load(), r = s.items.find(x => x.n === n); if (!r) return null;
  Object.assign(r, { status, [`${status}_at`]: new Date().toISOString(), ...extra }); save(s); return r;
}

const line = r => `${String(r.n).padStart(3)}  ${r.status.padEnd(7)} ${r.text}${r.files?.length ? `  [start: ${r.files.join(', ')}]` : ''}${r.check ? `  [done when: ${r.check}]` : ''}${r.branch ? `  (${r.branch})` : ''}`;
if (process.argv[1] && process.argv[1].endsWith('requests.mjs')) {
  const [cmd, ...a] = process.argv.slice(2), opt = k => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  if (cmd === 'add') {
    const text = a.find((x, i) => !x.startsWith('--') && !['--files', '--check'].includes(a[i - 1]));
    const r = add(text, { files: (opt('--files') ?? '').split(',').map(x => x.trim()).filter(Boolean), check: opt('--check') });
    if (r.error) { console.log(`refused: ${r.error}`); process.exit(65); }
    console.log(`added #${r.request.n} (${cellId(r.request.n)}): ${r.request.text}`); process.exit(0);
  }
  if (cmd === 'done' || cmd === 'drop') { const n = Number(a[0]); const r = setStatus(n, cmd === 'done' ? 'done' : 'dropped'); if (!r) { console.log(`no request #${a[0]}`); process.exit(64); } console.log(`#${n} ${r.status}`); process.exit(0); }
  if (cmd === 'list' || !cmd) { const all = load().items, show = a.includes('--all') ? all : all.filter(r => r.status === 'open'); console.log(show.length ? show.map(line).join('\n') : (all.length ? 'no open requests (list --all shows the rest)' : 'no requests yet')); process.exit(0); }
  console.log('usage: requests.mjs add "what to fix" [--files a,b] [--check "cmd"] | list [--all] | done N | drop N'); process.exit(64);
}
