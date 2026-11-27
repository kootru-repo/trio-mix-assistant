// A round of the engine, as programs (docs/adr/0003): the /enhance command only starts workers and judges; everything that decides is here.
// Run it from the owner's main tree (its copy of the engine is the trusted one: landing judges every branch with it).
//   node <engine>/round.mjs plan [--workers 3] [--cell ID] [--goal]   preflight, cells, claims, the integration worktree; prints the round as JSON
//        exit 0 a round to run, 3 wait (HOLD, launch gate: try later), 4 stop (not set up, Ratchet off, the copy edited), 5 nothing to do
//   node <engine>/round.mjs serve --round ID --port P          (a worker) start the game's server from this tree, recorded for the cleanup
//   node <engine>/round.mjs land --round ID --cell C --branch B [--worktree W] [--judge DIR]
//        integrate one worker's branch: merge into the integration branch, run the merge gate there with the trusted engine, keep or undo
//   node <engine>/round.mjs finish --round ID    clean up, then land the integration branch on the default branch when the main tree is clean
//   node <engine>/round.mjs review --cell C --branch B accept|reject "why"     the owner's verdict on a branch waiting for review
//   node <engine>/round.mjs settle     land the integration branch now if it can (after a goal is reached)
//   node <engine>/round.mjs status
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { ROOT, CFG, ENGINE, ENGINE_REL, STATE, CONFIG_NAME, mainTree, run, sh, killTree, matches, pyEnv, launchOk } from './lib.mjs';
import { ranked, pick, workOrder } from './coverage.mjs';
import { facts, reasons, landedIn } from './hold.mjs';
import { claim, claims, release, addOutcome, addRound, updateRound, round as getRound, outcomes, safe, addLabel, labels } from './state.mjs';
import { verifyVendor } from './vendor.mjs';
import { load as loadGoal } from './goal.mjs';
import { scopeRefusal } from './scope.mjs';
import { numberOf as requestNumber, find as findRequest, setStatus as setRequest, open as openRequests } from './requests.mjs';

const MAIN = mainTree(), A = CFG.autonomy;
const g = (dir, args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() }; };
const defaultBranch = () => g(MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
// land "pr" (docs/adr/0007): the work is based on, and offered to, the remote's pr.base; the owner's own branch is never read or moved
const PR = A.land === 'pr';
const upstream = () => (PR ? `${A.pr.remote}/${A.pr.base}` : defaultBranch());
const runArgs = (argv, vars) => { const a = argv.map(x => x.replace(/\{(base|head|title|body)\}/g, (_, k) => vars[k] ?? '')); const r = spawnSync(a[0], a.slice(1), { cwd: MAIN, encoding: 'utf8', windowsHide: true }); return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() }; };
/** pr.sync_owner: the owner's checked-out branch takes remote/base by fast-forward, only when the tree is clean, idle, and has nothing of its own */
export function syncOwner() {
  if (!PR || !A.pr.sync_owner) return null;
  const def = upstream(), own = defaultBranch();
  const f = g(MAIN, ['fetch', '--quiet', A.pr.remote, A.pr.base]); if (!f.ok) return `not synced: could not fetch ${def}`;
  if (g(MAIN, ['rev-list', '--count', `${own}..${def}`]).out === '0') return `${own} already has ${def}`;
  const dirty = dirtyPaths(); if (dirty.length) return `not synced: the main tree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 4).join(', ')})`;
  const busy = busyInMain(); if (busy) return `not synced: the main tree is busy (${busy})`;
  const m = g(MAIN, ['merge', '--ff-only', '--quiet', def]);
  if (m.ok) return `synced: ${own} fast-forwarded to ${def} (${g(MAIN, ['rev-parse', '--short', 'HEAD']).out})`;
  // the owner's commits reached the remote by a squash merge: merging them into remote/base changes nothing, so the branch can take it whole
  const t = g(MAIN, ['merge-tree', '--write-tree', def, own]), want = g(MAIN, ['rev-parse', `${def}^{tree}`]).out;
  if (t.ok && t.out.split('\n')[0] === want) { const r = g(MAIN, ['reset', '--keep', '--quiet', def]); if (r.ok) return `synced: ${own} moved to ${def} (${g(MAIN, ['rev-parse', '--short', 'HEAD']).out}); its own commits were already there, squash-merged`; }
  return `not synced: ${own} has commits of its own that ${def} lacks; the owner merges them`;
}

/** the engine's own open pull requests (head names under pr.prefix), or { error } */
function openPrs() { const r = runArgs(A.pr.list, {}); return r.ok ? r.out.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith(A.pr.prefix)) : { error: `could not list the open pull requests (${A.pr.list[0]}): ${r.out.split('\n').slice(-1)[0]}` }; }
const RATCHET = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'ratchet', 'app', 'ratchet.ts');
const visual = cell => /^[TS]:/.test(cell);
/** how often the judge agreed with the owner's verdicts on judged changes; calibrated when judge.calibrated is set, or the labels reach judge.calibrate_at */
export function calibration() { const L = labels().filter(l => l.judged), agree = L.filter(l => l.agree).length, at = CFG.judge.calibrate_at ?? { labels: 10, agree: 0.85 }; return { n: L.length, agree, rate: L.length ? agree / L.length : 0, calibrated: !!CFG.judge.calibrated || (L.length >= at.labels && agree / L.length >= at.agree) }; }
const integrationBranch = () => loadGoal()?.branch ?? A.integration_branch;
const integrationTree = branch => join(dirname(MAIN), `${basename(MAIN)}-${branch.replace(/[^\w.-]+/g, '-')}`);
const say = (code, lines) => { console.log([].concat(lines).join('\n')); process.exit(code); };

/** Ratchet must be on here, so every worker's edits and turn ends are checked; null when it is */
export function ratchetOff() {
  if (!existsSync(RATCHET)) return A.require_ratchet ? `Ratchet is not installed (${RATCHET}); set autonomy.require_ratchet false to run without it` : null;
  const r = sh(`node --experimental-strip-types --no-warnings "${RATCHET}" status --project "${MAIN}"`, { timeoutS: 60 });
  return /^Here \(.*\): ON/m.test(r.out) ? null : `Ratchet is not on for ${MAIN}: /ratchet on --project .`;
}

/** the integration worktree, made from the default branch the first time, and brought up to the default branch's newest commits.
 *  fresh (land "pr", a new round): started again from the remote's pr.base, since the last round's work went to the owner as a pull request */
function integration(branch = integrationBranch(), { fresh = false } = {}) {
  const dir = integrationTree(branch), def = upstream();
  if (PR) { const f = g(MAIN, ['fetch', '--quiet', A.pr.remote, A.pr.base]); if (!f.ok) return { error: `could not fetch ${def}: ${f.out.split('\n').slice(-1)[0]}` }; }
  if (fresh && existsSync(dir)) { g(dir, ['reset', '--hard', '--quiet']); g(dir, ['checkout', '--quiet', '-B', branch, def]); }
  if (!existsSync(dir)) {
    const exists = g(MAIN, ['rev-parse', '--verify', '--quiet', branch]).ok;
    const r = g(MAIN, fresh ? ['worktree', 'add', '-B', branch, dir, def] : exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', dir, '-b', branch, def]);
    if (!r.ok) return { error: `could not make the integration worktree ${dir}: ${r.out}` };
    // the trusted gate runs the game's own checks there, so it is set up the way a worker sets up (worker.setup), once
    for (const c of CFG.worker.setup) { const s = spawnSync(c, { cwd: dir, shell: true, encoding: 'utf8', timeout: 1800_000, windowsHide: true }); if (s.status !== 0) { g(MAIN, ['worktree', 'remove', '--force', dir]); return { error: `setting up the integration worktree failed at "${c}": ${((s.stdout ?? '') + (s.stderr ?? '')).trim().split('\n').slice(-3).join(' ')}` }; } }
  }
  g(dir, ['reset', '--hard', '--quiet']);
  const m = g(dir, ['merge', '--no-edit', '--quiet', def]);
  if (!m.ok) { g(dir, ['merge', '--abort']); return { error: `the integration branch ${branch} no longer merges with ${def}: ${m.out.split('\n').slice(-3).join(' ')}. The owner resolves it (or deletes the branch to start again).` }; }
  return { branch, dir, commit: g(dir, ['rev-parse', 'HEAD']).out };
}

function brief(r, w) {
  const engine = ENGINE_REL || '.', port = w.port;
  return [
    ...(w.worktree ? [`Your worktree is ${w.worktree} (branch ${w.branch}), made for you by the engine. Do every step inside it: use it as the working directory of every command, and never edit files in ${MAIN}.`] : []),
    `You are worker ${w.index + 1} of round ${r.id} of the enhancement engine on this repository. Work only on your cell below.`,
    `First, in your worktree: git reset --hard ${r.integration.commit}  (you start from the integration branch ${r.integration.branch}, which holds the work already accepted)`,
    ...CFG.worker.setup.map(c => `Set up: ${c}`),
    ...(CFG.worker.server && port ? [`Serve the game on your own port: node ${engine}/round.mjs serve --round ${r.id} --port ${port}   (never another port; the cleanup stops it)`] : []),
    ...(CFG.worker.rules ?? []).map(x => `Rule: ${x}`),
    'Never change a protected path (enhance.json "protected"; the locks are read from the default branch, so changing enhance.json does not unlock anything), never tune a value off the allowlist, never set the re-record or config-edit flags, never pass --live, never push or merge.',
    'Ratchet checks your edits and turn ends. A fact it reports is yours to fix, never to switch off.',
    `Done means: node ${engine}/gate.mjs merge --base ${r.integration.commit}${port ? ` --port ${port}` : ''} exits 0, and your work is committed on your worktree's branch. If it stays at 2 (inconclusive) or 1 (fail), say so; never call it done.`,
    'End with exactly two lines: BRANCH: <your branch>  and  WORKTREE: <your worktree path>.',
  ].join('\n');
}

async function plan(argv) {
  const want = Math.min(Number(arg(argv, '--workers', 1)), A.max_workers), cellId = arg(argv, '--cell', null), goal = argv.includes('--goal') ? loadGoal() : null;
  if (argv.includes('--goal') && (!goal || goal.verdict)) say(4, `no goal is running (goal.mjs status)`);
  { const sc = scopeRefusal(CFG, ROOT); if (sc) say(4, sc); }   // games only, never research (docs/adr/0005)
  const v = verifyVendor(ENGINE); if (v.status !== 'pass') say(4, [`the engine copy does not match its manifest:`, ...v.lines]);
  const rt = ratchetOff(); if (rt) say(4, rt);
  // the owner's branch follows the remote base first, whether or not a round then runs (pr.sync_owner); a waiting or idle plan still says it
  const synced = PR ? syncOwner() : null, wait = (code, lines) => say(code, synced ? [].concat(lines, synced) : lines);
  const hr = reasons(facts({ launchgate: false, round: true })); if (hr.length) wait(3, ['HOLD:', ...hr.map(x => `- ${x}`)]);
  let n = want;
  if (A.launchgate && existsSync(RATCHET)) {
    // launchOk(n - 1): Ratchet counts the workers already running, so the nth worker may start while n - 1 run
    let last = null; for (; n >= 1; n--) { last = launchOk(n - 1); if (!last) break; }
    if (n < 1) wait(3, `Ratchet's launch gate says wait, even for one worker: ${last}`);
  }
  const all = ranked(), cells = cellId ? all.filter(c => c.id === cellId && c.rank[0] < 7) : pick(n, all);
  if (!cells.length) wait(5, cellId ? `${cellId} is not a cell that wants work now (unknown, claimed or parked): node ${ENGINE_REL}/coverage.mjs map` : 'no cell wants work: every cell is up to date, claimed or parked');
  if (PR && !goal) { const open = openPrs(); if (open.error) say(4, open.error); if (open.length >= A.pr.max_open) wait(3, `waiting for the owner: the engine's pull request(s) ${open.join(', ')} are open (autonomy.pr.max_open ${A.pr.max_open}); merge or close them first`); }
  const int = integration(goal?.branch, { fresh: PR && !goal }); if (int.error) say(4, int.error);
  const workers = cells.map((c, i) => ({ index: i, cell: c.id, port: CFG.port ? CFG.port + 1 + i : null }));
  const { id } = addRound({ integration: int, workers, goal: !!goal, wanted: want, got: n });
  // autonomy.worktrees "engine": the engine makes each worker's worktree beside the main tree (for hosts whose own worktree isolation cannot run there)
  if (A.worktrees === 'engine') for (const w of workers) {
    const tag = `${w.cell.replace(/[^\w.-]+/g, '-')}-${id.slice(-4)}`, dir = join(dirname(MAIN), `${basename(MAIN)}-wk`, tag), branch = `enhance-wk/${tag}`;
    const x = g(MAIN, ['worktree', 'add', '-b', branch, dir, int.commit]); if (!x.ok) say(4, `could not make the worktree ${dir}: ${x.out}`);
    Object.assign(w, { worktree: resolve(dir), branch });
  }
  if (A.worktrees === 'engine') updateRound(id, { workers });
  const r = { id, integration: int };
  for (const w of workers) claim(w.cell, { status: 'working', round: id });
  console.log(JSON.stringify({ round: id, ...(synced ? { synced } : {}), integration: int, workers: workers.map((w, i) => ({ ...w, order: workOrder(cells[i]), brief: brief(r, w) })) }, null, 1));
  process.exit(0);
}

async function serve(argv) {
  const port = Number(arg(argv, '--port')), id = arg(argv, '--round');
  if (!CFG.worker.server || !port) say(64, 'this game has no worker.server in enhance.json, or no --port');
  const p = spawn(CFG.worker.server.split('{port}').join(String(port)), { cwd: ROOT, shell: true, detached: true, stdio: 'ignore', windowsHide: true }); p.unref();
  mkdirSync(join(STATE, 'servers'), { recursive: true }); writeFileSync(join(STATE, 'servers', `${port}.json`), JSON.stringify({ pid: p.pid, port, round: id, tree: ROOT, at: new Date().toISOString() }) + '\n');
  const want = readFileSync(join(ROOT, CFG.server.identity), 'utf8');
  for (let i = 0; i < 120; i++) { try { const t = await (await fetch(`http://${CFG.shim.rewrite_host}:${port}/${CFG.server.identity}`, { signal: AbortSignal.timeout(2000) })).text(); if (t === want) say(0, `serving this tree on ${port} (pid ${p.pid})`); } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 1000)); }
  killTree(p.pid); say(1, `the server did not serve this tree on ${port} within 120 s`);
}

/** the gate's own re-record (docs/adr/0004): the trusted settings' rerecord command runs in the integration tree against its server; whatever it changes
 *  must lie within rerecord.paths, and is committed there as the gate's commit. Returns the files, or why it could not */
async function rerecordIn(dir, port) {
  const RR = CFG.rerecord, c = RR && CFG.commands[RR.command];
  if (!c) return { error: `no rerecord command in ${CONFIG_NAME} (rerecord.command names a key of commands)` };
  const r = await run(c.run.split('{engine}').join(ENGINE_REL || '.'), { cwd: dir, timeoutS: c.timeoutS ?? 900, env: { ENHANCE_ROOT: dir, ...(c.python ? pyEnv(port) : {}) } });
  if (r.status !== 0) return { error: `the re-record (${RR.command}) did not succeed: ${r.out.split('\n').slice(-3).join(' ')}` };
  const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout ?? '';
  const files = st.split('\n').filter(l => l.length > 3).map(l => l.slice(3).trim().replace(/^"|"$/g, '')).filter(p => !p.includes(CFG.out_dir));
  // what the game's own tools keep modified (autonomy.ignore_dirty: a spend log the server writes) is put back, not counted
  const noise = files.filter(p => matches(p, A.ignore_dirty ?? []) && !matches(p, RR.paths)); if (noise.length) g(dir, ['checkout', '--', ...noise]);
  const kept = files.filter(p => !noise.includes(p)), bad = kept.filter(p => !matches(p, RR.paths));
  if (bad.length) { g(dir, ['checkout', '--', '.']); for (const p of bad) rmSync(join(dir, p), { force: true }); return { error: `the re-record changed paths outside rerecord.paths: ${bad.slice(0, 5).join(', ')}` }; }
  if (!kept.length) return { files: kept };
  g(dir, ['add', '--', ...kept]); const cm = g(dir, ['commit', '-q', '-m', `re-recorded by the gate (${RR.command}) after the judge preferred the change in both orders`]);
  return cm.ok ? { files: kept } : { error: `could not commit the re-record: ${cm.out}` };
}

/** the trusted gate: the default branch's copy of the engine judges the integration tree; nothing a worker wrote decides */
async function trustedGate(dir, { rerecord = false, base = null } = {}) {
  let srv = null; const port = CFG.port ? CFG.port + 9 : null;
  try {
    if (CFG.worker.server && port) {
      srv = spawn(CFG.worker.server.split('{port}').join(String(port)), { cwd: dir, shell: true, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
      const want = readFileSync(join(dir, CFG.server.identity), 'utf8');
      for (let i = 0; i < 120; i++) { try { if ((await (await fetch(`http://${CFG.shim.rewrite_host}:${port}/${CFG.server.identity}`, { signal: AbortSignal.timeout(2000) })).text()) === want) break; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 1000)); }
    }
    let rerecorded = [];
    if (rerecord) { const rr = await rerecordIn(dir, port); if (rr.error) return { status: 'review', out: rr.error, rerecorded }; rerecorded = rr.files; }
    const env = { ENHANCE_ROOT: dir, ENHANCE_ROLE: 'ci', [CFG.declare_env.record]: '', [CFG.declare_env.config]: '', ENHANCE_RERECORDED: JSON.stringify(rerecorded) };
    // --base: the default branch, named here, so nothing on the branch being judged can move what it is compared with
    return { ...(await run(`node "${join(ENGINE, 'gate.mjs')}" merge --base ${base ?? upstream()}${port ? ` --port ${port}` : ''}`, { cwd: dir, env, timeoutS: 3 * 3600 })), rerecorded };
  } finally { if (srv) killTree(srv.pid); }
}

export async function landBranch({ roundId = null, cell, branch, worktree = null, judgeDir = null, force = false }) {
  const done = (result, why, extra = {}) => { addOutcome({ round: roundId, cell, branch, worktree, result, why, ...extra }); if (result !== 'review') release(cell); return { result, why, ...extra }; };
  let judged = null, per = {}; if (judgeDir && existsSync(join(judgeDir, 'tally.json'))) { const t = JSON.parse(readFileSync(join(judgeDir, 'tally.json'), 'utf8')); judged = t.result; per = t.per ?? {}; }
  /** the judge lands it: the change preferred overall (judge.mjs tally 'candidate'), and, for a target cell, preferred on the target question itself */
  const judgeOk = judged === 'candidate' && (!cell.startsWith('T:') || !per.target || per.target === 'cand');
  let rerecord = visual(cell) && !!CFG.rerecord && (force || A.visual === 'judge');   // an accepted visual change re-records the gate's pictures (docs/adr/0004)
  if (visual(cell) && !force) {
    if (judged === 'base') return done('rejected', 'the judge preferred the picture before the change in both orders');
    if (A.visual === 'judge' && !judgeOk) { claim(cell, { status: 'review', round: roundId, branch, worktree, judged, judgeDir }); return done('review', `the judge did not prefer the change in both orders (judge: ${judged ?? 'no packet'}): the owner decides`); }
    if (A.visual !== 'judge' && !calibration().calibrated && A.visual === 'review') { claim(cell, { status: 'review', round: roundId, branch, worktree, judged, judgeDir }); return done('review', `a visual change and the judge is not calibrated: the owner decides (judge: ${judged ?? 'no packet'})`); }
  }
  const int = integration(); if (int.error) return { result: 'deferred', why: int.error };
  const before = int.commit, m = g(int.dir, ['merge', '--no-ff', '--no-edit', branch]);
  if (!m.ok) { g(int.dir, ['merge', '--abort']); return done('rejected', `conflicts with work already on ${int.branch}: ${m.out.split('\n').filter(l => /CONFLICT/.test(l)).slice(0, 4).join('; ')}`); }
  const r = await trustedGate(int.dir, { rerecord, base: before })   /* compared with the integration branch as it stood: only this merge (and the gate's own re-record) is judged; what is already on it was judged when it landed */, tail = r.out.split('\n').filter(l => /^(fail|inconclusive|quarantined)\s|gate merge/.test(l));
  if (r.status !== 0) g(int.dir, ['reset', '--hard', '--quiet', before]);
  if (r.status === 'review') { claim(cell, { status: 'review', round: roundId, branch, worktree, judged, judgeDir }); return done('review', `${r.out}: the owner decides`); }
  // inconclusive is not the worker's failure (the launch gate, HOLD, a missing recording): the branch waits, and does not count toward parking
  if (r.status === 2) { claim(cell, { status: 'review', round: roundId, branch, worktree, deferred: true }); return done('review', `could not be checked on ${int.branch} (inconclusive): ${tail.join(' | ').slice(0, 600)}. Land it again later: round.mjs review --cell ${cell} --branch ${branch} accept`); }
  if (r.status !== 0) return done('rejected', `${r.status === null ? 'the merge gate did not finish' : 'the merge gate failed'} on ${int.branch} with it merged: ${tail.join(' | ').slice(0, 600)}`);
  // an owner's request: its own check (if it names one) must pass on the integration branch too; then it is done
  const rq = requestNumber(cell), req = rq ? findRequest(rq) : null;
  if (req?.check) { const ck = await run(req.check, { cwd: int.dir, timeoutS: 1800, env: { ENHANCE_ROOT: int.dir } }); if (ck.status !== 0) { g(int.dir, ['reset', '--hard', '--quiet', before]); return done('rejected', `the request's own check failed on ${int.branch}: ${req.check}: ${ck.out.split('\n').slice(-3).join(' ')}`); } }
  if (req) setRequest(rq, 'done', { branch });
  return done('integrated', `merge gate passed on ${int.branch}${req ? `; request #${rq} done` : ''}${r.rerecorded?.length ? `; the gate re-recorded ${r.rerecorded.join(', ')} after the judge preferred the change in both orders (${judged ?? 'accepted by the owner'})` : ''}`, { commit: g(int.dir, ['rev-parse', 'HEAD']).out, judged, rerecorded: r.rerecorded ?? [] });
}

async function land(argv) {
  const res = await landBranch({ roundId: arg(argv, '--round'), cell: arg(argv, '--cell'), branch: arg(argv, '--branch'), worktree: arg(argv, '--worktree', null), judgeDir: arg(argv, '--judge', null) });
  say(res.result === 'integrated' ? 0 : res.result === 'review' ? 0 : 1, `${res.result.toUpperCase()}: ${res.why}`);
}

/** tracked files with uncommitted changes in the main tree, less those the owner's tools keep modified (autonomy.ignore_dirty) */
export function dirtyPaths() {
  // read untrimmed: each line is "XY path", and the first line's leading space is part of its status
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: MAIN, encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').filter(l => l.length > 3).map(l => l.slice(3).trim().replace(/^"|"$/g, '')).filter(p => !p.includes(CFG.out_dir) && !matches(p, A.ignore_dirty ?? []));
}
/** a process whose command line names the main tree and matches autonomy.busy (a probe run there, say): what it is, or null */
export function busyInMain() {
  if (!A.busy) return null;
  const re = new RegExp(A.busy), main = MAIN.toLowerCase().replace(/\\/g, '/');
  const out = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout ?? ''
    : spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout ?? '';
  const hit = out.split(/\r?\n/).find(l => re.test(l) && l.toLowerCase().replace(/\\/g, '/').includes(main) && !l.includes('round.mjs'));
  return hit ? hit.trim().slice(0, 120) : null;
}

/** land "pr": push the integration branch as pr.prefix + the round, and open a pull request against pr.base. Nothing else is pushed */
function landPr(id) {
  const int = integrationBranch(), def = upstream(), head = `${A.pr.prefix}${String(id).replace(/[^\w.-]+/g, '-')}`;
  if (!A.pr.prefix || head === A.pr.base) return `not offered: the pull request branch ${head} would be ${A.pr.base} itself`;
  const goal = loadGoal();
  if (goal && goal.verdict !== 'reached') return goal.verdict ? `the goal ended ${goal.verdict}, not reached: ${int} is left for the owner` : `a goal is running: ${int} is offered when the goal is reached`;
  g(MAIN, ['fetch', '--quiet', A.pr.remote, A.pr.base]);
  if (!g(MAIN, ['rev-parse', '--verify', '--quiet', int]).ok) return `nothing to offer: ${int} is not made yet`;
  const n = g(MAIN, ['rev-list', '--count', `${def}..${int}`]).out; if (n === '0') return `nothing to offer: ${def} already has ${int}`;
  const p = g(MAIN, ['push', '--quiet', '--force', A.pr.remote, `${int}:refs/heads/${head}`]);
  if (!p.ok) return `not offered: pushing ${head} failed: ${p.out.split('\n').slice(-1)[0]}`;
  const log = g(MAIN, ['log', '--reverse', '--format=- %s', `${def}..${int}`]).out;
  const body = [`Round ${id} of the enhancement engine: ${n} commit(s), each landed on ${int} by the trusted gate.`, '', log, '', A.pr.auto_merge === 'after-locks' ? 'Auto-merge: the trusted enhance-locks check (the base branch\'s engine, run on this tree) turns it on once the locks pass, and off if a later push fails them; GitHub then merges this by itself once its required checks pass, with no review. Close it to stop that. The next round waits while it is open.' : A.pr.auto_merge ? 'Auto-merge is on: GitHub merges this by itself once its required checks pass, with no review. Close it, or turn auto-merge off on it, to stop that. The next round waits while it is open.' : 'The engine never merges this: the owner reviews it and merges or closes it. The next round waits while it is open.', '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)'].join('\n');
  const c = runArgs(A.pr.create, { base: A.pr.base, head, title: `enhance round ${id}: ${n} commit(s)`, body });
  if (c.ok && A.pr.auto_merge === true) { const m = runArgs(A.pr.merge, { base: A.pr.base, head }); return `offered: pull request ${c.out.split('\n').slice(-1)[0]} (${head} into ${A.pr.base}); ${m.ok ? 'auto-merge on: the host merges it when its required checks pass' : `auto-merge could not be turned on (${m.out.split('\n').slice(-1)[0]}); the owner merges it`}`; }
  return c.ok ? `offered: pull request ${c.out.split('\n').slice(-1)[0]} (${head} into ${A.pr.base})` : `pushed ${head}, but opening the pull request failed: ${c.out.split('\n').slice(-1)[0]}`;
}

/** the default branch takes the integration branch by fast-forward, only when the owner's tree has no uncommitted change to a tracked file.
 *  With land "pr" the round's work is offered as a pull request instead (landPr) */
export function landDefault(id = null) {
  if (PR) return landPr(id ?? new Date().toISOString().replace(/\D/g, '').slice(0, 12));
  const int = integrationBranch(), def = defaultBranch();
  if (A.land !== 'when-clean') return `landing is off (autonomy.land ${A.land}); ${int} holds the work`;
  const goal = loadGoal();
  if (goal && goal.verdict !== 'reached') return goal.verdict ? `the goal ended ${goal.verdict}, not reached: ${int} is left for the owner, not landed` : `a goal is running: ${int} lands when the goal is reached`;
  const dirty = dirtyPaths();
  if (dirty.length) return `not landed: the main tree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 4).join(', ')}: the owner is working); ${int} keeps the work until it is clean`;
  const busy = busyInMain(); if (busy) return `not landed: the main tree is busy (${busy}); ${int} keeps the work until it is idle`;
  if (g(MAIN, ['rev-list', '--count', `${def}..${int}`]).out === '0') return `nothing to land: ${def} already has ${int}`;
  const m = g(MAIN, ['merge', '--ff-only', '--quiet', int]);
  if (!m.ok) return `not landed: ${def} has moved; the next round brings ${int} up to it first (${m.out.split('\n').slice(-1)[0]})`;
  let pushed = ''; if (A.push) { const p = g(MAIN, ['push', '--quiet', 'origin', def]); pushed = p.ok ? `, pushed` : `, push failed: ${p.out.split('\n').slice(-1)[0]}`; }
  return `landed: ${def} is now ${g(MAIN, ['rev-parse', '--short', 'HEAD']).out}${pushed}`;
}

function finish(argv) {
  const id = arg(argv, '--round'), r = getRound(id); if (!r) say(64, `no round ${id}`);
  const mine = outcomes().filter(o => o.round === id), lines = [];
  // the workers' worktrees and branches: kept only when they wait for the owner
  for (const o of mine.filter(o => o.result === 'integrated' || o.result === 'rejected')) {
    if (o.worktree && existsSync(o.worktree) && resolve(o.worktree) !== resolve(MAIN)) { const x = g(MAIN, ['worktree', 'remove', '--force', o.worktree]); lines.push(`${x.ok ? 'removed' : 'could not remove'} ${o.worktree}`); }
    if (o.branch) g(MAIN, ['branch', '-D', o.branch]);
  }
  g(MAIN, ['worktree', 'prune']);
  // the servers this round's workers started (recorded by serve), and only those
  const sd = join(STATE, 'servers');
  if (existsSync(sd)) for (const f of readdirSync(sd)) { try { const s = JSON.parse(readFileSync(join(sd, f), 'utf8')); if (s.round === id) { killTree(s.pid); rmSync(join(sd, f)); lines.push(`stopped the server on ${s.port}`); } } catch { /* a broken record is left */ } }
  // a worker that reported nothing leaves its claim; released here so the cell can be tried again
  for (const w of r.workers) if (!mine.some(o => o.cell === w.cell)) { release(w.cell); lines.push(`${w.cell}: no branch came back; released`); if (w.worktree && existsSync(w.worktree)) { g(MAIN, ['worktree', 'remove', '--force', w.worktree]); if (w.branch) g(MAIN, ['branch', '-D', w.branch]); lines.push(`removed ${w.worktree}`); } }
  g(MAIN, ['worktree', 'prune']);
  lines.push(landDefault(id));
  updateRound(id, { finished: new Date().toISOString(), outcomes: mine.map(o => `${o.cell}: ${o.result}`) });
  say(0, [`round ${id}:`, ...mine.map(o => `- ${o.cell} ${o.branch ?? ''}: ${o.result.toUpperCase()}: ${o.why}`), ...lines.map(l => `- ${l}`)]);
}

async function review(argv) {
  const cell = arg(argv, '--cell'), branch = arg(argv, '--branch'), verdict = argv.find(a => a === 'accept' || a === 'reject'), why = argv[argv.indexOf(verdict) + 1] ?? '';
  const c = claims().find(x => x.cell === cell);
  if (c?.judged && visual(cell) && (verdict === 'accept' || verdict === 'reject')) { const owner = verdict === 'accept' ? 'candidate' : 'base'; addLabel({ cell, branch, judged: c.judged, owner, agree: c.judged === owner, judgeDir: c.judgeDir ?? null, why }); }
  if (verdict === 'reject') { addOutcome({ cell, branch, worktree: c?.worktree, result: 'rejected', why: `the owner: ${why}` }); release(cell); say(0, `rejected; the reason goes into ${cell}'s next work order`); }
  if (verdict === 'accept') { release(cell); const r = await landBranch({ cell, branch, worktree: c?.worktree, force: true }); say(r.result === 'integrated' ? 0 : 1, [`${r.result.toUpperCase()}: ${r.why}`, r.result === 'integrated' ? landDefault() : '']); }
  say(64, 'usage: round.mjs review --cell C --branch B accept|reject "why"');
}

function status() {
  const f = facts({ launchgate: false, round: true }), cs = claims(), all = ranked(), int = integrationBranch(), def = upstream(), goal = loadGoal();
  say(0, [
    `holds: ${reasons(f).join(' | ') || 'none'}`,
    `rounds today ${f.roundsToday} of ${A.max_rounds_per_day}; pending ${f.pending} of ${A.max_pending}`,
    `integration ${int}: ${g(MAIN, ['rev-parse', '--verify', '--quiet', int]).ok ? `${g(MAIN, ['rev-list', '--count', `${def}..${int}`]).out} commit(s) not on ${def} yet` : 'not made yet (the first round makes it)'}`,
    `waiting for the owner: ${cs.filter(c => c.status === 'review').map(c => `${c.cell} (${c.branch})`).join(', ') || 'none'}`,
    `judge calibration: ${(() => { const k = calibration(); return `${k.agree} of ${k.n} owner labels agree${k.n ? ` (${Math.round(k.rate * 100)}%)` : ''}${k.calibrated ? ', calibrated' : `, not calibrated (needs ${(CFG.judge.calibrate_at ?? {}).labels ?? 10} labels at ${Math.round(((CFG.judge.calibrate_at ?? {}).agree ?? 0.85) * 100)}%)`}`; })()}`,
    `visual changes: ${A.visual === 'judge' ? 'the judge decides (both orders must prefer the change; the gate re-records)' : 'the owner reviews them'}; landed by the judge, last 10: ${outcomes().filter(o => o.result === 'integrated' && o.rerecorded?.length).slice(-10).map(o => o.cell).join(', ') || 'none'}`,
    `owner requests open: ${openRequests().map(r => `#${r.n} ${r.text.slice(0, 50)}`).join(' | ') || 'none'}`,
    `parked: ${all.filter(c => c.rank[0] === 7).map(c => c.id).join(', ') || 'none'}`,
    `cells wanting work: ${all.filter(c => c.rank[0] < 7).length}`,
    `goal: ${goal ? `"${goal.goal}", ${goal.rounds.length} round(s)${goal.verdict ? `, ${goal.verdict}` : ''}` : 'none'}`,
    `Ratchet: ${ratchetOff() ?? 'on here'}`,
  ]);
}

function arg(argv, k, d) { return argv.includes(k) ? argv[argv.indexOf(k) + 1] : d; }

if (process.argv[1] && process.argv[1].endsWith('round.mjs')) {
  const [cmd, ...argv] = process.argv.slice(2);
  const fns = { plan, serve, land, finish, review, status, settle: () => say(0, landDefault()) };
  if (!fns[cmd]) say(64, 'usage: round.mjs plan | serve | land | finish | review | status');
  await fns[cmd](argv);
}
