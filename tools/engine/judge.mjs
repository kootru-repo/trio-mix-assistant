// The pairwise judge (README.md). The judging itself is done by a Claude Code subagent that did not make the change, reading the pictures:
// this file only prepares what it sees and counts what it says, so no model is called from a script.
//   node <engine>/judge.mjs packet --cell T:name --base BASE.png --cand CAND.png [--target TARGET.png]
//     writes two folders, the pair in each order with neutral names (first.png, second.png), the target, and prompt.md; the key stays outside them
//   node <engine>/judge.mjs tally DIR
//     reads DIR/order1/verdict.json and DIR/order2/verdict.json, maps them back through the key, and keeps a dimension only if both orders agree
// The questions are the game's (enhance.json judge.dimensions). Verdicts are advisory until judge.calibrated is true.
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, CFG, ENGINE_REL } from './lib.mjs';
import { noteJudge } from './coverage.mjs';

const CHOICES = ['first', 'second', 'same'];

export function prompt(dims, hasTarget) {
  return [
    `# Compare two pictures of the same place in ${CFG.judge.title}`,
    '',
    `You see first.png and second.png${hasTarget ? ', and target.png, the picture the game is meant to match' : ''}. They differ by one change; you are not told which is newer.`,
    'Look at both closely, at full size, before you answer. Judge only what you can see.',
    '',
    'For each question answer "first", "second" or "same" (same when you cannot honestly tell them apart on that question):',
    ...dims.map(d => `- ${d.id}: ${d.ask}`),
    '',
    'Write only this JSON to verdict.json in this folder, nothing else:',
    '```json',
    JSON.stringify(Object.fromEntries([...dims.map(d => [d.id, 'first | second | same']), ['note', 'one sentence on the biggest difference you saw']]), null, 1),
    '```',
  ].join('\n');
}

/** check a verdict's shape; returns the problems, empty when it is usable */
export function verdictProblems(v, dims) {
  if (!v || typeof v !== 'object') return ['not a JSON object'];
  return dims.filter(d => !CHOICES.includes(v[d.id])).map(d => `${d.id} is ${JSON.stringify(v[d.id])}, not one of ${CHOICES.join(', ')}`);
}

/** both orders, mapped back to base and candidate; a dimension counts only when the two orders agree */
export function tally(v1, v2, key, dims) {
  const side = (v, order) => v === 'same' ? 'same' : key[order][v];   // key.order1.first is 'base' or 'cand'
  const per = {}, count = { cand: 0, base: 0, same: 0, split: 0 };
  for (const d of dims) {
    const a = side(v1[d.id], 'order1'), b = side(v2[d.id], 'order2');
    per[d.id] = a === b ? a : 'split'; count[per[d.id]]++;
  }
  const result = count.split * 2 >= dims.length ? 'inconsistent' : per.clean === 'base' ? 'base' : count.cand > count.base ? 'candidate' : count.base > count.cand ? 'base' : 'same';
  return { result, per, count, advisory: !CFG.judge.calibrated, notes: [v1.note, v2.note].filter(Boolean) };
}

function packet(a) {
  const cell = a['--cell'], baseP = a['--base'], candP = a['--cand'], target = a['--target'];
  for (const [k, p] of [['--base', baseP], ['--cand', candP], ['--target', target]]) if ((k !== '--target' || p) && !existsSync(p)) throw new Error(`${k} ${p}: no such file`);
  const dir = resolve(a['--out'] ?? join(ROOT, CFG.out_dir, 'judge', `${(cell ?? 'pair').replace(/[^\w-]/g, '_')}-${Date.now()}`));
  const flip = Math.random() < 0.5, key = { cell, base: resolve(baseP), cand: resolve(candP), target: target ? resolve(target) : null,
    order1: flip ? { first: 'cand', second: 'base' } : { first: 'base', second: 'cand' }, order2: flip ? { first: 'base', second: 'cand' } : { first: 'cand', second: 'base' } };
  for (const o of ['order1', 'order2']) {
    mkdirSync(join(dir, o), { recursive: true });
    copyFileSync(key[o].first === 'base' ? baseP : candP, join(dir, o, 'first.png'));
    copyFileSync(key[o].second === 'base' ? baseP : candP, join(dir, o, 'second.png'));
    if (target) copyFileSync(target, join(dir, o, 'target.png'));
    writeFileSync(join(dir, o, 'prompt.md'), prompt(CFG.judge.dimensions, !!target) + '\n');
  }
  writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1) + '\n');
  console.log(`packet: ${dir}\nGive ${join(dir, 'order1')} to one fresh subagent and ${join(dir, 'order2')} to another (each sees only its folder; neither made the change), then: node ${ENGINE_REL || '.'}/judge.mjs tally "${dir}"`);
}

function tallyCmd(dir) {
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')), dims = CFG.judge.dimensions, vs = [];
  for (const o of ['order1', 'order2']) {
    const f = join(dir, o, 'verdict.json');
    if (!existsSync(f)) { console.log(`inconclusive: ${f} is missing`); process.exit(2); }
    let v; try { v = JSON.parse(readFileSync(f, 'utf8').replace(/^```(json)?|```\s*$/gm, '')); } catch (e) { console.log(`inconclusive: ${f} is not JSON (${e.message})`); process.exit(2); }
    const bad = verdictProblems(v, dims); if (bad.length) { console.log(`inconclusive: ${f}: ${bad.join('; ')}`); process.exit(2); }
    vs.push(v);
  }
  const t = tally(vs[0], vs[1], key, dims);
  if (key.cell) noteJudge(key.cell, t);
  writeFileSync(join(dir, 'tally.json'), JSON.stringify(t, null, 1) + '\n');
  console.log(`judge: ${t.result}${t.advisory ? ' (advisory: the judge is not calibrated yet)' : ''}\n${Object.entries(t.per).map(([d, w]) => `  ${d}: ${w}`).join('\n')}${t.notes.length ? '\n  notes: ' + t.notes.join(' | ') : ''}`);
  process.exit(t.result === 'candidate' ? 0 : t.result === 'base' ? 1 : 2);
}

if (process.argv[1] && process.argv[1].endsWith('judge.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2), a = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i]] = rest[i + 1];
  if (cmd === 'packet') packet(a); else if (cmd === 'tally' && rest[0]) tallyCmd(resolve(rest[0]));
  else { console.log('usage: judge.mjs packet --cell ID --base A.png --cand B.png [--target T.png] [--out DIR] | judge.mjs tally DIR'); process.exit(64); }
}
