// Shared helpers for the enhancement engine (README.md): git, globbing, running a command with a time limit, and the game's settings.
// Pure Node, no game imports. The engine is game-agnostic: every fact about a game is in that game's enhance.json (docs/CONFIG.md).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, delimiter } from 'node:path';

export const CONFIG_NAME = 'enhance.json';
/** the game's root: ENHANCE_ROOT, else the nearest folder holding enhance.json above the working directory, else above the engine's own folder */
function findRoot() {
  if (process.env.ENHANCE_ROOT) return resolve(process.env.ENHANCE_ROOT);
  for (const start of [process.cwd(), import.meta.dirname]) for (let d = resolve(start); ; d = dirname(d)) { if (existsSync(join(d, CONFIG_NAME))) return d; if (dirname(d) === d) break; }
  throw new Error(`no ${CONFIG_NAME} found above ${process.cwd()} or ${import.meta.dirname}: run the engine from a game that has one (node <engine>/cli.mjs init), or set ENHANCE_ROOT`);
}
export const ROOT = findRoot();
/** where this copy of the engine sits, relative to the game's root, with forward slashes (for the commands the engine writes) */
export const ENGINE = import.meta.dirname, ENGINE_REL = relative(ROOT, ENGINE).split('\\').join('/');

/** what a game's enhance.json may leave out (docs/CONFIG.md) */
export const DEFAULTS = {
  // what the engine works on: "game", the only kind it runs for (engine/scope.mjs, docs/adr/0005)
  kind: null,
  base_refs: ['origin/main', 'main'], out_dir: '.enhance/out', port: null, server: { identity: CONFIG_NAME },
  declare_env: { record: 'ENHANCE_RECORD', config: 'ENHANCE_CONFIG_EDIT' }, product: ['src/**'], protected: [], writable: [], local_override: null,
  tiers: { turn: ['vendor', 'protect', 'tuning', 'guard', 'separation'], merge: ['hold', 'vendor', 'protect', 'tuning', 'guard', 'separation'], nightly: ['vendor', 'protect', 'guard', 'mutate'] },
  commands: {}, probes: null, mutate: { min_kill: 0.9, max_mutants: 200, timeoutS: 120, copy: [], targets: [] }, tuning: null,
  judge: { title: 'the game', calibrated: false, dimensions: [], calibrate_at: { labels: 10, agree: 0.85 } }, hold: { flake_storm: 3, flake_window: 5, rules_file: 'CLAUDE.md', spend: null },
  roles: { report_only_for_owner: ['protect', 'tuning', 'separation'] }, coverage: { stale_days: 7, sources: {}, orders: {}, never: '' },
  shim: { rewrite_host: 'localhost', port_env: [], replay: null }, guard: { browser_finally: true },
  // what a worker is told to do first, how it serves the game, and the game's own rules for it (the brief /enhance gives every worker)
  worker: { setup: [], server: null, rules: [] },
  // a re-record the gate itself may run after the judge preferred a visual change in both orders (autonomy.visual "judge"): the command (a key of
  // commands) and the only protected paths it may change (docs/adr/0004)
  rerecord: null,
  // autonomy (docs/adr/0003): what the engine does without the owner. Landing is a fast-forward of the default branch from the integration
  // branch, only when the owner's main tree has no uncommitted change; pushing is off unless the owner turns it on.
  // ignore_dirty: tracked files the owner's tools keep modified and never commit (they do not block landing); busy: a pattern of command
  // lines that, running in the main tree, mean the owner is checking something there (landing waits)
  autonomy: { integration_branch: 'enhance/main', land: 'when-clean', push: false, max_workers: 3, max_rounds_per_day: 8, max_pending: 3, park_after: 3, claim_hours: 24, visual: 'review', worktrees: 'agent', launchgate: true, helper_procs: '@playwright[\\\\/]mcp|playwright-mcp|mcp-server|modelcontextprotocol', require_ratchet: true, ignore_dirty: [], busy: null,
    // land "pr" (docs/adr/0007): each round's work goes to the owner as a pull request against pr.base and nothing else is pushed; the default
    // branch is never touched. A round starts from the remote's pr.base, and waits while max_open of the engine's own pull requests are open.
    // create and list are argument lists ({base} {head} {title} {body}), run without a shell
    pr: { base: 'main', remote: 'origin', prefix: 'enhance/round-', max_open: 1,
      create: ['gh', 'pr', 'create', '--base', '{base}', '--head', '{head}', '--title', '{title}', '--body', '{body}'],
      list: ['gh', 'pr', 'list', '--state', 'open', '--json', 'headRefName', '--jq', '.[].headRefName'] } },
};
export const merge = (d, v) => (d && v && typeof d === 'object' && typeof v === 'object' && !Array.isArray(d) && !Array.isArray(v) ? Object.fromEntries([...new Set([...Object.keys(d), ...Object.keys(v)])].map(k => [k, merge(d[k], v[k])])) : v === undefined ? d : v);
/**
 * the settings. In a worker's linked worktree they come from the owner's main tree, not from the branch being worked on: a branch cannot
 * empty its own tiers, change its own commands or move its own base. The gate replaces them with the base commit's in CI (useConfig).
 */
const mainOf = dir => { const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' }); const f = r.status === 0 ? r.stdout.split('\n')[0] : ''; return f.startsWith('worktree ') ? resolve(f.slice(9).trim()) : dir; };
const TRUSTED = (() => { const m = mainOf(ROOT); return m !== ROOT && existsSync(join(m, CONFIG_NAME)) ? join(m, CONFIG_NAME) : join(ROOT, CONFIG_NAME); })();
export const CONFIG_FROM = TRUSTED;
export const CFG = merge(DEFAULTS, JSON.parse(readFileSync(TRUSTED, 'utf8')));
/** put trusted settings (the base commit's) in place of the ones loaded, in the same object every module holds */
export function useConfig(c) { for (const k of Object.keys(CFG)) delete CFG[k]; Object.assign(CFG, c); }

/**
 * the settings as they were at a commit (the base the gate compares with): the locks (protected paths, tuning allowlist, local override,
 * declared flags, roles) are read from here, never from the branch being judged, so a branch cannot unlock what it changes. null when the
 * commit has no enhance.json (the engine's own first install).
 */
export function configAt(commit) {
  const r = spawnSync('git', ['show', `${commit}:${CONFIG_NAME}`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return merge(DEFAULTS, JSON.parse(r.stdout)); } catch { return null; }
}

/** the owner's main tree (the first worktree): shared state lives there, whichever worktree runs the engine */
export function mainTree() { return mainOf(ROOT); }
/**
 * shared state: records, claims, outcomes, rounds, HOLD, the goal. One folder in the main tree, one file per event (never one file that
 * concurrent workers rewrite), so every worker's gate is seen by the scheduler and by HOLD.
 */
// Only when the main tree has the engine (its enhance.json): until a game's owner has taken the engine in, nothing is written into their tree.
export const STATE = existsSync(join(mainTree(), CONFIG_NAME)) ? join(mainTree(), CFG.out_dir) : join(ROOT, CFG.out_dir);

/** stop a process and everything it started (a shell, uv, Python, Chromium): on Windows killing the shell alone leaves the rest running */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
}

/** run a shell command; never throws. status null means it did not finish (timeout, then the whole process tree is stopped) or could not start */
export function run(cmd, { timeoutS = 120, env = {}, cwd = ROOT } = {}) {
  return new Promise(res => {
    const t0 = Date.now(); let out = '', done = false;
    const p = spawn(cmd, { cwd, shell: true, env: { ...process.env, ...env }, detached: process.platform !== 'win32', windowsHide: true });
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    const finish = (status, extra = {}) => { if (done) return; done = true; clearTimeout(timer); res({ status, out: out.trim(), secs: Math.round((Date.now() - t0) / 100) / 10, ...extra }); };
    const timer = setTimeout(() => { killTree(p.pid); finish(null, { timedOut: true }); }, timeoutS * 1000);
    p.on('error', e => finish(null, { error: e.message }));
    p.on('close', code => finish(code));
  });
}

/** short synchronous commands only (git, launchgate): no tree to clean up */
export function sh(cmd, { timeoutS = 60, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutS * 1000, windowsHide: true });
  return { status: r.status, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}

/**
 * the environment every Python tool gets from the gate: the port (also under the game's own names, shim.port_env), the shim in every Python
 * process (shim/sitecustomize.py), and the paid calls listed in shim.replay answered from recordings unless --live
 */
export function pyEnv(port, { live = false, strictReplay = false } = {}) {
  const r = CFG.shim.replay, env = {
    ENHANCE_PORT: String(port), ENHANCE_HOME_PORT: String(CFG.port ?? port), ENHANCE_HOST: CFG.shim.rewrite_host, ENHANCE_SHIM: '1', ENHANCE_OUT: join(ROOT, CFG.out_dir),
    ENHANCE_REPLAY: !r ? 'off' : live ? 'off' : 'replay', ENHANCE_REPLAY_STRICT: strictReplay ? '1' : '',
    ENHANCE_REPLAY_ROUTES: JSON.stringify(r?.routes ?? []), ENHANCE_REPLAY_SEED: r?.seed != null ? String(r.seed) : '', ENHANCE_REPLAY_STORE: r ? join(ROOT, r.store) : '',
    PYTHONPATH: [join(ENGINE, 'shim'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
  for (const name of CFG.shim.port_env) env[name] = String(port);
  return env;
}

export function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.status === 0 ? r.stdout : null;
}

/**
 * the commit the comparison starts from: where this branch left the base. With no ref given it is the later of the merge-bases with each of
 * CFG.base_refs (origin/master and the local master), so the owner's commits that are merged locally but not pushed yet are never charged to a worker.
 */
export function baseCommit(ref = null) {
  const refs = ref ? ref.split(',') : CFG.base_refs, bases = refs.map(r => git(['merge-base', 'HEAD', r], { allowFail: true })?.trim()).filter(Boolean);
  if (!bases.length) throw new Error(`no merge base with ${refs.join(' or ')}: fetch it, or pass --base`);
  return bases.reduce((a, b) => (git(['merge-base', '--is-ancestor', a, b], { allowFail: true }) !== null ? b : a));
}

/** every path that differs between the base commit and the working tree (committed or not), with how: A added, M modified, D deleted; untracked files count as added */
export function changes(base) {
  const out = new Map();
  for (const line of (git(['diff', '--name-status', '--no-renames', base, '--']) ?? '').split('\n').filter(Boolean)) {
    const [st, ...rest] = line.split('\t'); out.set(rest.join('\t'), st[0]);
  }
  for (const f of (git(['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean)) if (!out.has(f)) out.set(f, 'A');
  return out;
}

/** the commit this run checked, and whether the tree had changes beyond it */
export function stamp() {
  const head = git(['rev-parse', '--short', 'HEAD']).trim();
  const dirty = (git(['status', '--porcelain']) ?? '').split('\n').filter(l => l && !l.includes(CFG.out_dir)).length;
  return { commit: head, dirty };
}

/** glob to RegExp: ** any depth, * within one folder, ? one character */
export function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
export const matches = (path, globs) => globs.some(g => globRe(g).test(path));

export const exists = p => existsSync(join(ROOT, p));
/** the file as it is at a commit, or null if it was not there */
export const showAt = (commit, path) => git(['show', `${commit}:${path}`], { allowFail: true });

/** the machine's processes: pid, parent, name, command line */
function processTable() {
  const out = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)\t$($_.ParentProcessId)\t$($_.Name)\t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout ?? ''
    : spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).stdout ?? '';
  return out.split(/\r?\n/).map(l => (process.platform === 'win32' ? l.split('\t') : l.trim().split(/\s+/, 4))).filter(x => x.length >= 3).map(([p, pp, n, c]) => ({ pid: Number(p), ppid: Number(pp), name: String(n).toLowerCase(), cmd: c ?? '' }));
}
/** claude and node processes the cap should not count: this engine run's own tree (from its topmost node process down: the gate's server and
 *  browsers), and idle helpers of open sessions whose command line matches autonomy.helper_procs */
export function excusedProcesses() {
  try {
    const ps = processTable(), by = new Map(ps.map(p => [p.pid, p])), isNode = p => /^node(\.exe)?$/.test(p?.name ?? ''), counted = p => /^(node|claude)(\.exe)?$/.test(p.name);
    let top = by.get(process.pid); while (top && isNode(by.get(top.ppid))) top = by.get(top.ppid);
    const own = new Set(top ? [top.pid] : []); for (let grew = true; grew;) { grew = false; for (const p of ps) if (!own.has(p.pid) && own.has(p.ppid)) { own.add(p.pid); grew = true; } }
    const helper = CFG.autonomy.helper_procs ? new RegExp(CFG.autonomy.helper_procs, 'i') : null;
    const ex = ps.filter(p => counted(p) && (own.has(p.pid) || (helper && helper.test(p.cmd))));
    return { n: ex.length, own: ex.filter(p => own.has(p.pid)).length };
  } catch { return { n: 0, own: 0 }; }
}
/** Ratchet's launch gate for n workers (null: go). Ratchet decides; a refusal for the process cap alone is overridden when the count less the
 *  excused processes is under the cap (RAM, CPU and the worker limit are never overridden) */
export function launchOk(workers) {
  const app = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'ratchet', 'app', 'ratchet.ts');
  if (!existsSync(app)) return null;
  const r = sh(`node --experimental-strip-types --no-warnings "${app}" launchgate --workers ${workers}`, { timeoutS: 60 });
  if (r.status !== 1) return null;
  const why = r.out.split('\n').filter(Boolean).slice(-1)[0] ?? '', reasons = why.replace(/^wait:\s*/, '').split(/;\s*/).filter(Boolean);
  const cap = reasons.length === 1 && /(\d+) claude and node processes are running, limit (\d+)/.exec(reasons[0]);
  if (cap) { const ex = excusedProcesses(), others = Number(cap[1]) - ex.n; if (others < Number(cap[2])) { console.error(`launch gate: ${reasons[0]}; ${ex.n} are excused (${ex.own} this run's own, ${ex.n - ex.own} idle session helpers): ${others} others, under the cap: go`); return null; } }
  return why || 'wait';
}
