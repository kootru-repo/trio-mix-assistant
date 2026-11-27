// The engine's shared state (docs/adr/0003): one folder in the owner's main tree (lib.mjs STATE), one file per event, never a file that two
// workers rewrite. What a cell is worth working on, what holds the engine, and what a worker is told about past attempts are all derived
// from these files when they are read.
//   claims/<cell>.json      a cell being worked on (working) or waiting for the owner (review); removed when its branch lands or is rejected
//   outcomes/<time>.json    what became of a worker's branch: integrated, rejected (with why: the lesson), review, landed
//   rounds/<time>.json      a round that started (for the daily cap) and its workers (for the cleanup)
//   records/<time>.json     every gate run (gate.mjs writes them)
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, CFG } from './lib.mjs';

const dir = d => { const p = join(STATE, d); mkdirSync(p, { recursive: true }); return p; };
const stampName = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
export const safe = id => id.replace(/[^\w.-]+/g, '_');
const readAll = d => { const p = join(STATE, d); return existsSync(p) ? readdirSync(p).filter(f => f.endsWith('.json')).sort().map(f => { try { return { file: join(p, f), ...JSON.parse(readFileSync(join(p, f), 'utf8')) }; } catch { return null; } }).filter(Boolean) : []; };

export const records = () => readAll('records');
export const outcomes = () => readAll('outcomes');
export const rounds = () => readAll('rounds');
export function addOutcome(o) { const f = join(dir('outcomes'), `${stampName()}.json`); writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...o }, null, 1) + '\n'); return f; }
export function addRound(r) { const id = stampName(), f = join(dir('rounds'), `${id}.json`); writeFileSync(f, JSON.stringify({ id, at: new Date().toISOString(), ...r }, null, 1) + '\n'); return { id, file: f }; }
export function updateRound(id, patch) { const f = join(dir('rounds'), `${id}.json`), r = JSON.parse(readFileSync(f, 'utf8')); writeFileSync(f, JSON.stringify({ ...r, ...patch }, null, 1) + '\n'); return { ...r, ...patch }; }
export const round = id => { try { return JSON.parse(readFileSync(join(STATE, 'rounds', `${id}.json`), 'utf8')); } catch { return null; } };

/** live claims: a cell someone is on, or whose branch waits for the owner; a working claim older than claim_hours has lapsed */
export function claims(now = Date.now()) {
  return readAll('claims').filter(c => c.status === 'review' || now - Date.parse(c.at) < CFG.autonomy.claim_hours * 36e5);
}
export function claim(cell, patch) { writeFileSync(join(dir('claims'), `${safe(cell)}.json`), JSON.stringify({ cell, at: new Date().toISOString(), ...patch }, null, 1) + '\n'); }
export function release(cell) { rmSync(join(STATE, 'claims', `${safe(cell)}.json`), { force: true }); }

/** pure: a cell's attempts since its last success, newest first: the lessons a worker is given, and whether the cell is parked */
export function history(cell, all) {
  const mine = all.filter(o => o.cell === cell), lastGood = mine.map(o => o.result).lastIndexOf('integrated');
  const since = mine.slice(lastGood + 1).filter(o => o.result === 'rejected').reverse();
  return { failures: since.length, lessons: since.slice(0, 3).map(o => `${o.at.slice(0, 16)} ${o.branch ?? ''}: ${(o.why ?? '').slice(0, 400)}`), parked: since.length >= CFG.autonomy.park_after };
}

/** pure: rounds started today, and branches waiting (on the owner, or integrated but not landed yet) */
export function load({ rs = rounds(), cs = claims(), os = outcomes(), today = new Date().toISOString().slice(0, 10), landed = () => false } = {}) {
  return { roundsToday: rs.filter(r => r.at.slice(0, 10) === today && !r.empty).length, pending: cs.filter(c => c.status === 'review').length + os.filter(o => o.result === 'integrated' && !landed(o)).length };
}

/** a calibration label: the owner's verdict on a change the judge also judged (docs/adr/0004) */
export function addLabel(l) { const f = join(dir('labels'), `${stampName()}.json`); writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...l }, null, 1) + '\n'); return f; }
export function labels() { const d = dir('labels'); return readdirSync(d).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean); }
