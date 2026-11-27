// A goal for the engine's loop (README.md, docs/adr/0002-goal-loop.md): rounds go on until a check the owner can read says the goal is
// reached, and stop by themselves when they run out of rounds or stop making progress. Whether the goal is reached is a program's exit code,
// never a model's opinion.
//   node <engine>/goal.mjs start "goal in words" --check "<command>" [--max-rounds 10] [--stall 3] [--port P]
//       records the goal; the check must FAIL now (a goal already met is not a goal), on the goal branch's starting commit
//   node <engine>/goal.mjs check --in <dir>     one round's verdict: runs the check in <dir> (the goal branch's worktree) and records it
//       exit 0 reached, 1 not yet (go on), 3 out of rounds, 4 stalled (the goal branch did not advance for --stall rounds), 2 no goal
//   node <engine>/goal.mjs status | stop "reason"
// The goal branch and its worktree are the orchestrator's (the /enhance-goal command); this file only keeps the record and decides.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scopeRefusal, goalRefusal } from './scope.mjs';
import { ROOT, CFG, STATE, run, git, pyEnv } from './lib.mjs';

const OUT = STATE, FILE = join(OUT, 'goal.json'), HISTORY = join(OUT, 'goal_history.jsonl');
export const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } };
const save = g => { mkdirSync(OUT, { recursive: true }); writeFileSync(FILE, JSON.stringify(g, null, 1) + '\n'); };

/**
 * pure: what one more check result means for the goal. g: the goal with its rounds so far; r: { status (exit code, null when the check
 * did not finish), commit (the goal branch's head) }. Returns { verdict: reached | go | rounds | stalled, why }.
 */
export function verdict(g, r) {
  const rounds = [...g.rounds, r];
  if (r.status === 0) return { verdict: 'reached', why: `the check passed after ${rounds.length} round(s)` };
  if (rounds.length >= g.max_rounds) return { verdict: 'rounds', why: `${rounds.length} rounds, the most this goal allows (--max-rounds ${g.max_rounds}), and the check still fails` };
  const last = rounds.slice(-(g.stall + 1));
  if (last.length === g.stall + 1 && last.every(x => x.commit === last[0].commit)) return { verdict: 'stalled', why: `the goal branch has not advanced in ${g.stall} round(s) (still ${last[0].commit}): no worker's change passed the gate` };
  return { verdict: 'go', why: r.status === null ? 'the check did not finish (counted as not reached)' : `the check fails (exit ${r.status}); ${g.max_rounds - rounds.length} round(s) left` };
}
const EXIT = { reached: 0, go: 1, rounds: 3, stalled: 4 };

const argv = process.argv.slice(2), arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
if (process.argv[1] && process.argv[1].endsWith('goal.mjs')) {
  const cmd = argv[0], g = load();
  if (cmd === 'start') {
    if (g) { console.log(`a goal is already set: "${g.goal}" (node goal.mjs stop "reason" first)`); process.exit(2); }
    const text = argv[1], check = arg('--check');
    { const r = scopeRefusal(CFG, ROOT) ?? goalRefusal(text); if (r) { console.log(`refused: ${r}`); process.exit(65); } }   // games only, never research (docs/adr/0005)
    if (!text || !check) { console.log('usage: goal.mjs start "goal" --check "<command that exits 0 when the goal is reached>" [--max-rounds 10] [--stall 3] [--port P] [--in DIR]'); process.exit(64); }
    const dir = resolve(arg('--in', ROOT)), port = Number(arg('--port', CFG.port ?? 0));
    const first = await run(check, { cwd: dir, env: port ? pyEnv(port) : {}, timeoutS: Number(arg('--timeout', 600)) });
    if (first.status === 0) { console.log(`the check already passes, so there is nothing to reach:\n${first.out.split('\n').slice(-5).join('\n')}\nWrite a check that fails now and passes when the goal is met.`); process.exit(2); }
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'goal';
    const goal = { goal: text, check, branch: arg('--branch', `enhance/goal-${slug}`), max_rounds: Number(arg('--max-rounds', 10)), stall: Number(arg('--stall', 3)), port, timeoutS: Number(arg('--timeout', 600)), started: new Date().toISOString(), base: git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).trim(), rounds: [], baseline: { status: first.status, tail: first.out.split('\n').slice(-5) } };
    save(goal); console.log(`goal set: "${text}"\nbranch: ${goal.branch} (rounds integrate there; it lands on the default branch only when the goal is reached)\ncheck: ${check} (fails now, exit ${first.status})\nat most ${goal.max_rounds} rounds; stops if the goal branch does not advance in ${goal.stall}`); process.exit(0);
  }
  if (!g) { console.log('no goal is set (node goal.mjs start ...)'); process.exit(2); }
  if (cmd === 'check' && g.verdict) { console.log(`the goal has ended: ${g.verdict.toUpperCase()}: ${g.why} (node goal.mjs stop to clear it)`); process.exit(EXIT[g.verdict]); }
  if (cmd === 'check') {
    const dir = resolve(arg('--in', ROOT)), commit = git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).trim();
    const r = await run(g.check, { cwd: dir, env: g.port ? pyEnv(g.port) : {}, timeoutS: g.timeoutS });
    const rec = { at: new Date().toISOString(), commit, status: r.status, tail: r.out.split('\n').slice(-5) }, v = verdict(g, rec);
    g.rounds.push(rec);
    if (v.verdict === 'go') save(g); else { appendFileSync(HISTORY, JSON.stringify({ ...g, ended: rec.at, verdict: v.verdict, why: v.why }) + '\n'); save({ ...g, ended: rec.at, verdict: v.verdict, why: v.why }); }
    console.log(`round ${g.rounds.length}: ${v.verdict.toUpperCase()}: ${v.why}\ncheck: ${g.check} in ${dir} at ${commit}\n${rec.tail.join('\n')}`);
    process.exit(EXIT[v.verdict]);
  }
  if (cmd === 'status') { console.log(JSON.stringify({ ...g, rounds: g.rounds.map(r => `${r.at.slice(0, 16)} ${r.commit} exit ${r.status}`) }, null, 1)); process.exit(g.verdict ? EXIT[g.verdict] : 1); }
  if (cmd === 'stop') { appendFileSync(HISTORY, JSON.stringify({ ...g, ended: new Date().toISOString(), verdict: g.verdict ?? 'stopped', why: g.why ?? argv[1] ?? 'stopped by the owner' }) + '\n'); rmSync(FILE); console.log('goal ended and kept in goal_history.jsonl'); process.exit(0); }
  console.log('usage: goal.mjs start | check --in DIR | status | stop "reason"'); process.exit(64);
}
