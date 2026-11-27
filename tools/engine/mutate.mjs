// Mutation runs (README.md): proof that a test bites. Each target file is broken in small ways (a boundary moved, a guard flipped,
// a min for a max, a constant changed) in a temporary copy of the tree (mutate.copy), never the working tree, and its test is run on each broken copy.
// A mutant the test does not fail on survived: either the test misses that fault, or the change makes no difference (an equivalent mutant).
//   node <engine>/mutate.mjs [file]     run the targets in enhance.json mutate.targets (or one file of them)
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, CFG, run } from './lib.mjs';

const OPS = [
  [/(?<![<>=!])>=(?!=)/g, '>'], [/(?<![<>=!])<=(?!=)/g, '<'], [/(?<![<>=!-])>(?![=>])/g, '>='], [/(?<![<>=!])<(?![=<])/g, '<='],
  [/&&/g, '||'], [/\|\|/g, '&&'], [/Math\.max\(/g, 'Math.min('], [/Math\.min\(/g, 'Math.max('],
  [/===/g, '!=='], [/!==/g, '==='], [/(?<![\w.])1(?![\w.])/g, '0'], [/(?<![\w.])0(?![\w.])/g, '1'], [/ \+ /g, ' - '], [/ - /g, ' + '],
];

/** every single-site mutant of the source: line number, what changed, and the mutated text. Comment lines and import lines are left alone */
export function mutants(src) {
  const lines = src.split('\n'), out = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/^\s*(\*|\/\/|import |export (interface|type) )/.test(line) || !code.trim()) return;
    for (const [re, to] of OPS) {
      for (const m of code.matchAll(new RegExp(re.source, 'g'))) {
        if (/^\s*(\d|[a-z_])/i.test(to) && /['"`]/.test(code.slice(0, m.index).replace(/(['"`]).*?\1/g, ''))) continue;   // inside a string
        const mutated = line.slice(0, m.index) + to + line.slice(m.index + m[0].length);
        if (mutated !== line) out.push({ line: i + 1, what: `${m[0].trim()} -> ${to.trim()} at column ${m.index + 1} (…${line.slice(Math.max(0, m.index - 24), m.index).trimStart()}⟦${m[0].trim()}⟧${line.slice(m.index + m[0].length, m.index + m[0].length + 12)}…)`, text: [...lines.slice(0, i), mutated, ...lines.slice(i + 1)].join('\n') });
      }
    }
  });
  return out;
}

/** an even spread of at most n items, so a cap does not keep only the top of the file */
const spread = (xs, n) => xs.length <= n ? xs : Array.from({ length: n }, (_, k) => xs[Math.floor(k * xs.length / n)]);

export async function runMutations(cfg, onlyFile = null) {
  const res = [];
  for (const t of cfg.targets.filter(t => !onlyFile || t.file === onlyFile)) {
    const t0 = Date.now(), dir = mkdtempSync(join(tmpdir(), 'enhance-mutate-'));
    try {
      for (const p of cfg.copy) if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
      const clean = await run(t.test, { cwd: dir, timeoutS: cfg.timeoutS });
      if (clean.status !== 0) { res.push({ file: t.file, status: 'inconclusive', lines: ['the test fails on the unbroken copy, so mutants prove nothing:', ...clean.out.split('\n').slice(-6)], secs: 0 }); continue; }
      const src = readFileSync(join(dir, t.file), 'utf8'), all = mutants(src), picked = spread(all, cfg.max_mutants), survived = [];
      for (const m of picked) {
        writeFileSync(join(dir, t.file), m.text);
        const r = await run(t.test, { cwd: dir, timeoutS: cfg.timeoutS });
        if (r.status === 0) survived.push(`line ${m.line}: ${m.what}`);
      }
      writeFileSync(join(dir, t.file), src);
      const kill = picked.length ? (picked.length - survived.length) / picked.length : 0, secs = Math.round((Date.now() - t0) / 1000);
      // A known backlog (Ratchet's census): survivors up to the ceiling pass while the file is the one the ceiling was set on; the ceiling may only fall.
      const sha = createHash('sha256').update(src).digest('hex').slice(0, 12), ceil = t.ceiling && t.ceiling.sha === sha ? t.ceiling.survivors : null;
      const ok = picked.length > 0 && (kill >= cfg.min_kill || (ceil !== null && survived.length <= ceil));
      const lines = [`${picked.length - survived.length} of ${picked.length} mutants caught (${all.length} possible; kill rate ${(kill * 100).toFixed(0)}%, needed ${cfg.min_kill * 100}%${ceil !== null ? `, or at most ${ceil} survivors (ceiling: ${t.ceiling.why})` : t.ceiling ? `; the ceiling was set on another version of the file (${t.ceiling.sha}, now ${sha}), so it no longer applies: review the survivors again` : ''}). Test: ${t.test}`, ...survived.map(s => `survived ${s}`)];
      if (ceil !== null && survived.length < ceil) lines.push(`fewer survivors than the ceiling: lower it to ${survived.length} in enhance.json mutate.targets`);
      res.push({ file: t.file, status: ok ? 'pass' : 'fail', lines, secs, kill, survived, sha });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return res;
}

if (process.argv[1] && process.argv[1].endsWith('mutate.mjs')) {
  const r = await runMutations(CFG.mutate, process.argv[2] ?? null);
  for (const x of r) console.log(`${x.status.padEnd(12)} ${x.file}\n  ${x.lines.join('\n  ')}`);
  process.exit(r.some(x => x.status === 'fail') ? 1 : r.some(x => x.status !== 'pass') ? 2 : 0);
}
