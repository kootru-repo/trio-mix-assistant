// The gate (README.md): one command a worker, CI and the nightly run share.
//   node <engine>/gate.mjs turn|merge|nightly [--only a,b] [--port 5181] [--base origin/main] [--live] [--jobs 2] [--no-rerun]
// Each step ends pass, fail or inconclusive (could not run, or ran against the wrong tree). Inconclusive is never a pass.
// A failure is run once more: failing then passing is reported as flaky. A quarantined step is reported and never holds.
// Every Python tool runs with the shim (right port, paid calls replayed: the paid service is reached only with --live), and no browser starts
// while Ratchet's launchgate says wait. A step that runs out of time is stopped with everything it started.
// Exit 0 all passed, 1 something failed, 2 nothing failed but something could not be checked. Every run writes a record stamped with its commit.
// The steps are fixed; the game's enhance.json says which run in which tier, and supplies the game's own commands (docs/CONFIG.md).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, resolve, relative } from 'node:path';
import { ROOT, CFG, CONFIG_NAME, ENGINE, ENGINE_REL, STATE, configAt, useConfig, mainTree, run, sh, git, pyEnv, baseCommit, changes, stamp, matches, showAt, launchOk } from './lib.mjs';
import { verifyVendor } from './vendor.mjs';
import { protectCheck, tuningCheck, localCheck } from './checks.mjs';
import { runMutations } from './mutate.mjs';
import { guardCheck, readRules, atBase, nowText } from './guard.mjs';
import { facts as holdFacts, reasons as holdReasons } from './hold.mjs';
import { probeNames, probeGlob } from './coverage.mjs';
import { scopeRefusal } from './scope.mjs';

const argv = process.argv.slice(2), arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const tier = argv[0];
if (!CFG.tiers[tier]) { console.error(`usage: node tools/engine/gate.mjs ${Object.keys(CFG.tiers).join('|')} [--only a,b] [--port N] [--base REF] [--live] [--jobs N] [--no-rerun]`); process.exit(64); }
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const port = Number(arg('--port', process.env.ENHANCE_PORT ?? CFG.port ?? 0)), live = argv.includes('--live'), rerun = !argv.includes('--no-rerun'), jobs = Number(arg('--jobs', 2));
// who runs it: a worker's linked worktree, CI, or the owner's own tree (where protect, tuning and separation report and never hold)
const linked = (() => { const d = git(['rev-parse', '--git-dir'], { allowFail: true }), c = git(['rev-parse', '--git-common-dir'], { allowFail: true }); return d && c && resolve(ROOT, d.trim()) !== resolve(ROOT, c.trim()); })();
const role = process.env.ENHANCE_ROLE ?? (process.env.GITHUB_ACTIONS ? 'ci' : linked ? 'worker' : 'owner');
{ const sc = scopeRefusal(CFG, ROOT); if (sc) { console.log(`refused: ${sc}`); process.exit(1); } }   // games only (docs/adr/0005): refused before anything else
const base = baseCommit(arg('--base', null)), changed = changes(base), results = [];
// Outside the owner's tree every setting (the locks, the tiers and their steps, the commands) comes from the base commit, never from the
// branch being judged: a branch that unprotects a path, empties a tier or changes a command in its own enhance.json is judged by the
// base's. (A worker's settings already come from the main tree, lib.mjs; CI and landing pass --base.) The first install has no base settings.
if (role !== 'owner') { const b = configAt(base); if (b) useConfig(b); }
const LOCK = configAt(base) ?? CFG;
// games only, never research (docs/adr/0005): the trusted settings must say this is a game, or nothing is judged and nothing passes
{ const sc = scopeRefusal(LOCK, ROOT); if (sc) { console.log(`refused: ${sc}`); process.exit(1); } }
const declaredRecord = process.env[LOCK.declare_env.record] === '1', declaredConfig = process.env[LOCK.declare_env.config] === '1';
if (role !== 'owner' && !CFG.tiers[tier]?.length) { console.log(`the trusted settings have no steps in the ${tier} tier: nothing to judge with, so nothing passes`); process.exit(2); }
const add = (name, status, lines, extra = {}) => { if (status === 'fail' && role === 'owner' && LOCK.roles.report_only_for_owner.includes(name)) { lines = ['reported, not held: this is the main tree, where the owner works', ...[].concat(lines)]; status = 'reported'; } if (extra.secs != null) extra.secs = Math.round(extra.secs * 10) / 10; results.push({ name, status, lines: [].concat(lines).filter(Boolean).slice(0, 40), ...extra }); console.log(`${status.padEnd(12)} ${name}${extra.secs != null ? ` (${extra.secs} s)` : ''}`); };

/** does the server on the port serve this very tree? A dev server serves files under the root, so a file of this tree (server.identity) is compared byte for byte */
async function serverIsThisTree() {
  if (!port) return `no port: set "port" in ${CONFIG_NAME} or pass --port`;
  const id = CFG.server.identity;
  try {
    const r = await fetch(`http://${CFG.shim.rewrite_host}:${port}/${id}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `the server on ${port} answered ${r.status} for ${id}`;
    return (await r.text()) === readFileSync(join(ROOT, id), 'utf8') ? null : `the server on ${port} serves another tree (its ${id} differs from this one): start the dev server from this folder on a free port and pass --port`;
  } catch (e) { return `nothing answers on port ${port} (${e.message}): start the dev server from this folder on port ${port}`; }
}

/** Ratchet's launch gate (RAM, process cap, other projects running), when this machine has Ratchet; null means go */
/** Ratchet's launch gate for this run's browsers: the gate is one run, not a set of workers (lib.mjs launchOk) */
function launchgate() { const w = launchOk(0); return w ? `Ratchet's launchgate says wait: ${w}` : null; }

/** one command or tool, with the rerun rule and the quarantine rule */
async function step(name, cmd, timeoutS, env, quarantine, info = false) {
  let r = await run(cmd, { timeoutS, env }), status, lines;
  const tail = o => o.split('\n').filter(l => !/^portshim:/.test(l) || /proves nothing|\d+ without/.test(l)).slice(-10);
  if (r.status === 0) { status = 'pass'; lines = info ? tail(r.out) : tail(r.out).slice(-2); }
  else if (r.status === null) { status = 'inconclusive'; lines = [`did not finish in ${timeoutS} s${r.error ? ': ' + r.error : ''}; stopped with everything it started`, ...tail(r.out)]; }
  else if (r.status === 3) { status = 'inconclusive'; lines = tail(r.out); }
  else {
    status = 'fail'; lines = [...tail(r.out), `Command: ${cmd}`];
    if (rerun) { const r2 = await run(cmd, { timeoutS, env }); r.secs += r2.secs; if (r2.status === 0) { status = 'flaky'; lines = ['failed, then passed on a fresh run:', ...lines]; } }
  }
  if (quarantine && status !== 'pass') { lines = [`quarantined (${status}): ${quarantine}`, ...lines]; status = 'quarantined'; }
  add(name, status, lines, { secs: r.secs, info });
}

const home = s => s.replace(/~/g, (process.env.USERPROFILE ?? process.env.HOME ?? '~').replace(/\\/g, '/'));
/** {engine} in a command is where this copy of the engine sits, so a game's commands survive the engine being vendored elsewhere */
const fill = s => home(s).split('{engine}').join(ENGINE_REL || '.');
async function command(name) {
  if (!CFG.commands[name]) return add(name, 'inconclusive', `no command "${name}" in ${CONFIG_NAME} commands, but the tier names it`);
  const c = { ...CFG.commands[name] }; c.run = fill(c.run); if (c.requires) c.requires = home(c.requires);
  if (c.requires && !existsSync(c.requires)) return add(name, 'inconclusive', `needs ${c.requires}, which is not on this machine (${c.why})`);
  await step(name, c.run, c.timeoutS ?? 120, c.python ? pyEnv(port, { live }) : {}, c.quarantine, !!c.info);
}

/** probes: files matching probes.glob, one * standing for the probe's name (e.g. tools/*_probe.py) */
const P = CFG.probes, probeFile = n => probeGlob().file(n), allProbes = probeNames;
function affectedProbes() {
  const want = new Set(); let unmapped = false;
  for (const path of changed.keys()) {
    const hit = Object.entries(P.map ?? {}).filter(([g]) => matches(path, [g]));
    hit.forEach(([, ps]) => ps.forEach(p => want.add(p)));
    if (!hit.length && matches(path, CFG.product)) unmapped = true;
  }
  if (unmapped) (P.smoke ?? []).forEach(p => want.add(p));
  return [...want].filter(p => allProbes().includes(p)).sort();
}

async function probes(names) {
  const skipped = live ? [] : names.filter(n => (P.live ?? []).includes(n)), torun = names.filter(n => !skipped.includes(n));
  if (skipped.length) add('probes:live-skipped', 'skipped', [`not run (they exist to test the paid service itself; pass --live): ${skipped.join(', ')}`]);
  const queue = [...torun];
  const worker = async () => {
    for (let n; (n = queue.shift());) await step(`probe:${n}`, fill(P.run).split('{file}').join(probeFile(n)), P.slowS?.[n] ?? P.timeoutS ?? 300, pyEnv(port, { live, strictReplay: (P.replay_needed ?? []).includes(n) }), P.quarantine?.[n]);
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
}

const steps = CFG.tiers[tier].filter(s => !only || only.has(s) || only.has(s.split(':')[0]));
/** a step needs the game's server and a browser: the probes, and any command marked "browser": true */
const needsServer = s => s.startsWith('probes') || !!CFG.commands[s]?.browser;
const browsers = steps.filter(needsServer);
const server = browsers.length ? await serverIsThisTree() : null, waitMsg = browsers.length && !server ? launchgate() : null;
for (const s of steps) {
  if (s === 'protect') {
    // the paths landing re-recorded itself (round.mjs, CI role only), limited to the trusted settings' rerecord.paths: nothing else is unlocked
    const rerec = role === 'ci' && LOCK.rerecord ? (() => { try { return JSON.parse(process.env.ENHANCE_RERECORDED || '[]'); } catch { return []; } })().filter(p => matches(p, LOCK.rerecord.paths)) : [];
    const r = protectCheck(changed, LOCK.protected, { declared: declaredRecord, allowed: rerec, writable: LOCK.writable ?? [] }), lo = LOCK.local_override, lf = lo ? join(ROOT, lo.file) : null;
    const l = lo ? localCheck(existsSync(lf) ? JSON.parse(readFileSync(lf, 'utf8')) : null, lo.allow, lo) : { status: 'pass', lines: [] };
    add('protect', r.status === 'fail' || l.status === 'fail' ? 'fail' : 'pass', [...(r.status === 'fail' ? r.lines : []), ...(l.status === 'fail' ? l.lines : []), ...(r.status === 'pass' && l.status === 'pass' ? [...r.lines, ...l.lines] : [])]);
  }
  else if (s === 'vendor') {
    // the copy this gate runs from, and, when a trusted copy judges another tree (landing), that tree's own copy too
    const own = ENGINE, theirs = join(ROOT, relative(mainTree(), ENGINE)), rs = [verifyVendor(own)];
    if (resolve(theirs) !== resolve(own) && existsSync(theirs)) rs.push(verifyVendor(theirs));
    const bad = rs.find(r => r.status !== 'pass'); add('vendor', bad ? bad.status : 'pass', rs.flatMap(r => r.lines));
  }
  else if (s === 'tuning' && !LOCK.tuning) add('tuning', 'pass', `no tuning allowlist in ${CONFIG_NAME}: tuning values are guarded by protect alone`);
  else if (s === 'tuning') {
    const files = [...changed.keys()].filter(p => matches(p, [LOCK.tuning.files]));
    const before = new Map(), after = new Map();
    for (const p of files) { const b = showAt(base, p); before.set(basename(p), b ? JSON.parse(b) : null); after.set(basename(p), existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), 'utf8')) : null); }
    const r = tuningCheck(before, after, LOCK.tuning.allow, { declared: declaredConfig }); add('tuning', r.status, r.lines);
  }
  else if (s === 'hold') { const r = holdReasons(holdFacts({ launchgate: false })); add('hold', r.length ? 'inconclusive' : 'pass', r.length ? ['the engine is held; nothing can be merged until this clears:', ...r] : 'nothing holds the engine'); }
  else if (s === 'guard') { const paths = [...changed.keys()]; const r = guardCheck(paths, atBase(base), nowText, readRules()); add('guard', r.status, r.lines); }
  else if (s === 'separation') {
    const oracle = [...changed.keys()].filter(p => LOCK.protected.some(r => matches(p, r.paths))), product = [...changed.keys()].filter(p => matches(p, LOCK.product));
    add('separation', 'pass', oracle.length && product.length ? [`reported (Ratchet: a check changes in a change of its own): this change touches checks (${oracle.slice(0, 6).join(', ')}) and the game (${product.slice(0, 6).join(', ')}) together; a reviewer reads the check changes first`] : 'checks and game are not changed together');
  }
  else if (s.startsWith('probes') && !P) add(s, 'inconclusive', `the tier names ${s}, but ${CONFIG_NAME} has no probes section`);
  else if (s.startsWith('probes')) {
    const names = s === 'probes:all' ? allProbes() : affectedProbes();
    if (!names.length) add(s, 'pass', 'no probe watches the changed files');
    else if (server || waitMsg) add(s, 'inconclusive', [server ?? waitMsg, `not run: ${names.join(', ')}`]);
    else await probes(names);
  }
  else if (s === 'mutate') { const rs = await runMutations(CFG.mutate); if (!rs.length) add('mutate', 'pass', `no mutation targets in ${CONFIG_NAME}`); for (const r of rs) add(`mutate:${r.file}`, r.status, r.lines, { secs: r.secs }); }
  else if (needsServer(s) && (server || waitMsg)) add(s, 'inconclusive', server ?? waitMsg);
  else await command(s);
}

const failed = results.filter(r => r.status === 'fail'), open = results.filter(r => r.status === 'inconclusive');
const verdict = failed.length ? 'fail' : open.length ? 'inconclusive' : 'pass';
const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ?? '').trim();
const record = { tier, verdict, role, ...stamp(), branch, tree: ROOT, base: base.slice(0, 7), port, live, started: new Date().toISOString(), declared: { record: declaredRecord, config: declaredConfig }, results };
// every gate's record goes to the shared state in the main tree (one file each), so the scheduler and HOLD see workers' runs too
const dir = join(STATE, 'records'); mkdirSync(dir, { recursive: true }); mkdirSync(join(ROOT, CFG.out_dir), { recursive: true });
const file = join(dir, `${record.started.replace(/[:.]/g, '-')}-${process.pid}-${tier}.json`); writeFileSync(file, JSON.stringify(record, null, 1) + '\n');
const md = [`# Gate ${tier}: ${verdict}`, '', `Commit ${record.commit}${record.dirty ? ` with ${record.dirty} uncommitted changes` : ''}, against base ${record.base}, role ${role}, port ${port}${live ? ', live paid calls' : CFG.shim.replay ? ', paid calls replayed' : ''}, ${record.started}.`, '',
  ...results.map(r => `- **${r.name}**: ${r.status}${r.secs != null ? ` (${r.secs} s)` : ''}${r.status === 'pass' && !r.info ? '' : '\n' + r.lines.map(l => `  - ${l}`).join('\n')}`),
  '', `Record: ${file.split('\\').join('/')}`];
writeFileSync(join(ROOT, CFG.out_dir, 'latest.md'), md.join('\n') + '\n');
console.log(`\ngate ${tier}: ${verdict.toUpperCase()}${failed.length ? ` (failed: ${failed.map(r => r.name).join(', ')})` : ''}${open.length ? ` (not checked: ${open.map(r => r.name).join(', ')})` : ''}\nsee ${CFG.out_dir}/latest.md`);
process.exit(verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : 2);
