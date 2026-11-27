// The engine's scope (owner 2026-11-27, docs/adr/0005): it is for games, and only games. Every use, now and in future, improves a game in a
// git repository; it is never used for research (a research question, a literature review or survey, a paper, a study, a writing or research
// project). Enforced by programs, not by prose: init refuses a repository that is not a game; plan, the gate and goals refuse to run unless
// the trusted settings say "kind": "game"; a goal whose text is research is refused.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

export const SCOPE = 'the enhancement engine is for games only (and the few apps the owner names in engine/scope.mjs): it is never used for research (docs/adr/0005, 0007)';
/** the apps the owner has named (docs/adr/0007): a repository is one only when its origin is listed here, in the engine itself, so no repository
 *  admits itself; its enhance.json then says "kind": "app". Every research refusal still applies to it. */
export const OWNER_APPS = [
  { repo: 'kootru-repo/trio-mix-assistant', since: '2026-11-27', why: 'the owner: a narrowly scoped loop over the dashboard, docs and tests; safety logic, fixtures and ADRs protected; a pull request per round' },
];
/** owner/name of a repository's origin (GITHUB_REPOSITORY in CI when there is no remote), lower case; null when there is neither */
export function repoOf(root) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const url = r.status === 0 ? r.stdout.trim() : '';
  const m = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return (m?.[1] ?? process.env.GITHUB_REPOSITORY ?? '').toLowerCase() || null;
}
/** the owner's entry for this repository, or null */
export function namedApp(root) { const r = repoOf(root); return r ? OWNER_APPS.find(a => a.repo.toLowerCase() === r) ?? null : null; }
/** words that make a goal research, not game work */
export const RESEARCH = /\b(research(?:ing|er)?|literature(?: review)?|survey of|systematic review|meta-analysis|bibliograph\w*|citations?|white ?paper|thesis|dissertation|academic paper|peer[- ]review\w*|study of|case study|deep[- ]research|market (?:research|analysis)|competitor analysis|essay|manuscript|novel|chapter)\b/i;

/** what code a game is made of, and what a research or writing repository is made of */
const CODE = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx', '.py', '.cs', '.cpp', '.c', '.h', '.rs', '.go', '.lua', '.gd', '.java', '.kt', '.swift', '.html', '.svelte', '.vue']);
const PAPER = new Set(['.md', '.txt', '.pdf', '.tex', '.bib', '.ipynb', '.docx', '.rtf', '.csv']);
/** signs of a game: an engine's project file, or game words in the repository's own description */
const ENGINE_FILES = ['project.godot', 'ProjectSettings', 'Assets', '.uproject', 'Cargo.toml', 'game.json'];
const GAME_WORDS = /\b(game|gameplay|player|level|sprite|npc|quest|mission|isometric|platformer|puzzle|rpg|shooter|arcade|roguelike|sandbox|multiplayer|phaser|three\.js|pixi|godot|unity|unreal|bevy|pygame|love2d)\b/i;

function walk(dir, out = { code: 0, paper: 0 }, depth = 0) {
  if (depth > 4) return out;
  let names = []; try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.') || n === 'node_modules' || n === 'dist' || n === 'build' || n === '.venv' || n === 'out') continue;
    const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else { const e = extname(n).toLowerCase(); if (CODE.has(e)) out.code++; else if (PAPER.has(e)) out.paper++; }
  }
  return out;
}

/** is this repository a game, or an app the owner named? { ok, why, kind } */
export function isGame(root) {
  const app = namedApp(root);
  const counts = walk(root);
  const text = ['package.json', 'README.md', 'CLAUDE.md', 'pyproject.toml', 'Cargo.toml'].map(f => { try { return readFileSync(join(root, f), 'utf8').slice(0, 20000); } catch { return ''; } }).join('\n');
  const engineFile = ENGINE_FILES.some(f => existsSync(join(root, f))) || readdirSync(root).some(n => n.endsWith('.uproject'));
  const gameWords = (text.match(new RegExp(GAME_WORDS.source, 'gi')) ?? []).length, researchWords = (text.match(new RegExp(RESEARCH.source, 'gi')) ?? []).length;
  if (counts.code === 0) return { ok: false, why: `${basename(root)} has no game code (no source files)` };
  if (app) {
    if (counts.paper > counts.code * 3) return { ok: false, why: `${basename(root)} is mostly documents (${counts.paper} document files to ${counts.code} code files): a research or writing repository, not an app` };
    if (researchWords > 0) return { ok: false, why: `${basename(root)} describes itself as research (${researchWords} research words), though the owner named it` };
    return { ok: true, kind: 'app', why: `an app the owner named (${app.repo}, ${app.since}; ${counts.code} code files)` };
  }
  if (counts.paper > counts.code * 3 && !engineFile) return { ok: false, why: `${basename(root)} is mostly documents (${counts.paper} document files to ${counts.code} code files): a research or writing repository, not a game` };
  if (!engineFile && gameWords === 0) return { ok: false, why: `nothing in ${basename(root)} (package.json, README.md, CLAUDE.md) says it is a game` };
  if (researchWords > gameWords && !engineFile) return { ok: false, why: `${basename(root)} describes itself as research more than as a game` };
  return { ok: true, kind: 'game', why: `a game (${counts.code} code files${engineFile ? ', a game engine project' : ''}, ${gameWords} game words)` };
}

/** the trusted settings must say this is a game, or "app" for an app the owner named (root is the repository); null when they do, else why not */
export function scopeRefusal(cfg, root) {
  if (cfg?.kind === 'game') return null;
  if (cfg?.kind === 'app') return root && namedApp(root) ? null : `${SCOPE}. "kind": "app" is only for an app the owner named in engine/scope.mjs OWNER_APPS, and ${root ? repoOf(root) ?? 'this repository (no origin)' : 'this repository'} is not one`;
  return `${SCOPE}. enhance.json must say "kind": "game", or "app" for an app the owner named (it says ${JSON.stringify(cfg?.kind ?? null)})`;
}
/** a goal's text must be game work; null when it is, else why not */
export function goalRefusal(text) { const m = RESEARCH.exec(String(text ?? '')); return m ? `${SCOPE}. This goal reads as research ("${m[0]}"): give a goal about the game itself` : null; }
