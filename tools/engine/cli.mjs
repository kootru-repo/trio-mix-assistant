#!/usr/bin/env node
// The enhancement engine's command line (README.md).
//   From the engine's repository, once per game:
//     node engine/cli.mjs init <game> [--dir tools/engine]   copy the engine in, and write enhance.json, .ratchet/config.json and a CI workflow where absent
//                                                            (the /enhance command is the owner's, global, in ~/.claude/commands: templates/enhance.md)
//     node engine/cli.mjs sync <game> [--dir tools/engine]   update a game's copy to this engine (the dir is read from the game's VENDOR.json when it has one)
//   From a game (through its copy, e.g. node tools/engine/cli.mjs ...):
//     gate | hold | coverage | judge | mutate | guard | goal  ARGS    the same as node <engine>/<name>.mjs ARGS
//     verify                                                  does this copy match its VENDOR.json?
//     version
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { sync, source, verifyVendor, MANIFEST } from './vendor.mjs';
import { isGame, scopeRefusal, SCOPE } from './scope.mjs';

const HERE = import.meta.dirname, REPO = dirname(HERE), TEMPLATES = join(REPO, 'templates');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
const SCRIPTS = ['gate', 'hold', 'coverage', 'judge', 'mutate', 'guard', 'goal', 'round', 'requests'];

/** the folder a game keeps its copy in: --dir, else where an earlier sync put it (a VENDOR.json under tools/ or the root), else tools/engine */
function vendorDir(game) {
  if (opt('--dir')) return opt('--dir');
  for (const d of ['tools/engine', 'tools/enhance', 'enhance', '.enhance/engine']) if (existsSync(join(game, d, MANIFEST))) return d;
  return 'tools/engine';
}
const fromRepo = () => { if (!existsSync(TEMPLATES)) { console.error(`${cmd} runs from the engine's own repository (this is a vendored copy: ${HERE})`); process.exit(64); } };

if (cmd === 'sync' || cmd === 'init') {
  fromRepo();
  const game = resolve(rest.find(a => !a.startsWith('--') && a !== opt('--dir')) ?? '.'), dir = vendorDir(game);
  if (!existsSync(join(game, '.git'))) { console.error(`${game} is not the root of a git repository`); process.exit(64); }
  // games only, never research (docs/adr/0005): the repository must be a game, and a game's settings must say so
  const found = isGame(game); if (!found.ok) { console.error(`refused: ${SCOPE}. ${found.why}.`); process.exit(65); }
  if (cmd === 'sync' && existsSync(join(game, 'enhance.json'))) { let k = null; try { k = JSON.parse(readFileSync(join(game, 'enhance.json'), 'utf8')).kind; } catch { /* unreadable: refused below */ } const no = scopeRefusal({ kind: k }, game); if (no) { console.error(`refused: ${no} (${join(game, 'enhance.json')}).`); process.exit(65); } }
  const r = sync(HERE, join(game, dir));
  console.log(`${r.engine} ${r.version} at ${r.commit}: ${r.files} files copied to ${join(game, dir)}${r.removed.length ? `; removed ${r.removed.join(', ')}` : ''}`);
  if (r.commit.endsWith('-dirty')) console.log('warning: the engine has uncommitted changes, so this copy matches no commit of the engine');
  if (cmd === 'init') {
    const put = (rel, text) => { const f = join(game, rel); if (existsSync(f)) return console.log(`kept ${rel} (it exists)`); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); console.log(`wrote ${rel}`); };
    const t = n => readFileSync(join(TEMPLATES, n), 'utf8').split('{engine}').join(dir);
    put('enhance.json', t('enhance.json').replace('"kind": "game"', `"kind": "${found.kind}"`));
    put('.ratchet/config.json', t('ratchet.config.json'));
    put('.github/workflows/enhance.yml', t('ci.yml'));
    console.log(`\nNext: fill in enhance.json (docs/CONFIG.md in the engine's repository), add "${dir}/out" to .gitignore, commit, then: node ${dir}/gate.mjs turn`);
  }
}
else if (cmd === 'verify') { const r = verifyVendor(HERE); console.log(`${r.status}: ${r.lines.join('\n  ')}`); process.exit(r.status === 'pass' ? 0 : r.status === 'fail' ? 1 : 2); }
else if (cmd === 'version') { const m = existsSync(join(HERE, MANIFEST)) ? JSON.parse(readFileSync(join(HERE, MANIFEST), 'utf8')) : source(HERE); console.log(`${m.engine} ${m.version} at ${m.commit}`); }
else if (SCRIPTS.includes(cmd)) { const r = spawnSync(process.execPath, [join(HERE, `${cmd}.mjs`), ...rest], { stdio: 'inherit' }); process.exit(r.status ?? 1); }
else { console.log(readFileSync(import.meta.filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(cmd ? 64 : 0); }
