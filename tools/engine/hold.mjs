// HOLD (README.md), after trio-mix-assistant's safety model (its ADR 0014): the engine stops starting work by itself when a condition says
// it is not safe to go on, and goes on only when that condition has cleared (or, for the owner's own hold, when the owner clears it).
//   node <engine>/hold.mjs check          exit 0 go, 1 held (with every reason), used by /enhance before a round and by the merge gate
//   node <engine>/hold.mjs set "reason"   the owner's hold, kept until clear
//   node <engine>/hold.mjs clear          clears the owner's hold
//   node <engine>/hold.mjs ack            the owner has read the rules file (hold.rules_file, CLAUDE.md by default) as it is now
// Reasons: the owner's hold; the day's spend at its cap (hold.spend, when the game spends); the rules file changed since it was last
// acknowledged; a flake storm in the last gate records; Ratchet's launchgate says wait. Each clears by itself once its condition is gone,
// except the owner's hold and the rules ack.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, CFG, STATE, mainTree, git, sh } from './lib.mjs';
import { load as loadState } from './state.mjs';
export { mainTree };

const OUT = STATE, HOLD = join(OUT, 'HOLD'), ACK = join(OUT, 'rules_ack.json');
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
/** has the default branch got this integrated commit yet? */
export const landedIn = main => o => !!o.commit && git(['merge-base', '--is-ancestor', o.commit, 'HEAD'], { cwd: main, allowFail: true }) !== null;

/** pure: the reasons to hold, from the facts gathered by facts() */
export function reasons(f) {
  const out = [];
  if (f.ownerHold) out.push(`the owner's hold: ${f.ownerHold} (node tools/engine/hold.mjs clear)`);
  if (f.spend && f.cap != null && f.spend.day === f.today && f.spend.usd >= f.cap) out.push(`today's spend is ${f.spend.usd.toFixed(4)} USD, at the cap of ${f.cap}${f.capFrom ? ` (${f.capFrom})` : ''}; it clears tomorrow`);
  if (f.rulesSha && f.ackSha && f.rulesSha !== f.ackSha) out.push(`${f.rulesFile ?? 'the rules file'} has changed since the engine last acknowledged it: re-read it, adjust work orders and briefs if a rule moved, then run hold.mjs ack`);
  if (f.flaky >= CFG.hold.flake_storm) out.push(`${f.flaky} flaky results in the last ${CFG.hold.flake_window} gate records: a check that changes its mind cannot gate; find the cause first`);
  if (f.launchgate) out.push(f.launchgate);
  // before a round only: the cost cap (workers' own model use is not measured, so rounds a day stand in for it) and the review backlog
  if (f.roundsToday != null && f.roundsToday >= CFG.autonomy.max_rounds_per_day) out.push(`${f.roundsToday} rounds today, the most allowed (enhance.json autonomy.max_rounds_per_day ${CFG.autonomy.max_rounds_per_day}); it clears tomorrow`);
  if (f.pending != null && f.pending >= CFG.autonomy.max_pending) out.push(`${f.pending} branches wait to land or for the owner (autonomy.max_pending ${CFG.autonomy.max_pending}): review them (/enhance --review), or clean the main tree so integrated work can land`);
  return out;
}

export function facts({ launchgate = true, round = false } = {}) {
  const main = mainTree(), today = new Date().toISOString().slice(0, 10);
  // hold.spend: { file, file_in_main_tree, cap_file, cap_key }: the day's spend as { day, usd }, read from the owner's main tree when the
  // spending service runs there, and the cap, a dotted key in a config file of this tree
  const sp = CFG.hold.spend; let spend = null, cap = null;
  if (sp) {
    try { spend = JSON.parse(readFileSync(join(sp.file_in_main_tree === false ? ROOT : main, sp.file), 'utf8')); } catch { /* no spend recorded yet */ }
    try { cap = sp.cap_key.split('.').reduce((o, k) => o[k], JSON.parse(readFileSync(join(ROOT, sp.cap_file), 'utf8'))); } catch { /* no cap known */ }
  }
  const recs = existsSync(join(OUT, 'records')) ? readdirSync(join(OUT, 'records')).filter(f => f.endsWith('.json')).sort().slice(-CFG.hold.flake_window) : [];
  const flaky = recs.reduce((n, f) => { try { return n + JSON.parse(readFileSync(join(OUT, 'records', f), 'utf8')).results.filter(r => r.status === 'flaky').length; } catch { return n; } }, 0);
  const app = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'ratchet', 'app', 'ratchet.ts');
  const lg = launchgate && CFG.autonomy.launchgate && existsSync(app) ? sh(`node --experimental-strip-types --no-warnings "${app}" launchgate --workers 1`, { timeoutS: 60 }) : null;
  const rulesFile = CFG.hold.rules_file, rulesSha = rulesFile && existsSync(join(ROOT, rulesFile)) ? sha(join(ROOT, rulesFile)) : null;
  let ackSha = null; try { ackSha = JSON.parse(readFileSync(ACK, 'utf8')).sha; } catch { /* never acknowledged */ }
  const st = round ? loadState({ landed: landedIn(main) }) : {};
  return { ...st, ownerHold: existsSync(HOLD) ? readFileSync(HOLD, 'utf8').trim() : null, spend, cap, capFrom: sp ? `${sp.cap_file} ${sp.cap_key}` : null, today, rulesFile, rulesSha, ackSha: ackSha ?? rulesSha, flaky, launchgate: lg && lg.status === 1 ? `Ratchet's launchgate says wait: ${lg.out.split('\n').slice(-2).join(' ')}` : null, firstAck: !ackSha };
}

if (process.argv[1] && process.argv[1].endsWith('hold.mjs')) {
  const cmd = process.argv[2] ?? 'check'; mkdirSync(OUT, { recursive: true });
  if (cmd === 'set') { writeFileSync(HOLD, (process.argv[3] ?? 'held by the owner') + '\n'); console.log('held'); process.exit(0); }
  if (cmd === 'clear') { rmSync(HOLD, { force: true }); console.log('the owner\'s hold is cleared'); process.exit(0); }
  if (cmd === 'ack') { writeFileSync(ACK, JSON.stringify({ sha: sha(join(ROOT, CFG.hold.rules_file)), at: new Date().toISOString() }) + '\n'); console.log(`${CFG.hold.rules_file} acknowledged as it is now`); process.exit(0); }
  const f = facts({ round: process.argv.includes('--round') }); if (f.firstAck && f.rulesSha) writeFileSync(ACK, JSON.stringify({ sha: f.rulesSha, at: new Date().toISOString(), first: true }) + '\n');
  const r = reasons(f);
  console.log(r.length ? `HOLD:\n- ${r.join('\n- ')}` : 'go: nothing holds the engine');
  process.exit(r.length ? 1 : 0);
}
