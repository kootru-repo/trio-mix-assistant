// Bounded exhaustive model checking (docs/ENGINE.md), after trio-mix-assistant: walk every sequence of events up to a depth, check the
// invariants after each event, and shrink the first counterexample to the shortest sequence that still breaks them. A pass also needs every
// "reach" predicate to have held in some state, so a pass cannot come from states the walk never got to.
// enumerate({ alphabet, depth, init, step, check, reach }) -> { sequences, states, counterexample, unreached }
//   step(state, event) returns the next state (never changes its argument); check(state, seq) returns an error text or null.

export function enumerate({ alphabet, depth, init, step, check, reach = {} }) {
  let sequences = 0, states = 0, first = null;
  const hit = new Set();
  const visit = (state, seq) => {
    states++;
    for (const [name, pred] of Object.entries(reach)) if (!hit.has(name) && pred(state)) hit.add(name);
    const err = check(state, seq);
    if (err) { first = { seq: [...seq], error: err }; return true; }
    if (seq.length === depth) { sequences++; return false; }
    for (const ev of alphabet) { seq.push(ev); const stop = visit(step(state, ev), seq); seq.pop(); if (stop) return true; }
    return false;
  };
  visit(init(), []);
  const counterexample = first ? shrink(first.seq, { init, step, check }) : null;
  return { sequences, states, counterexample, unreached: Object.keys(reach).filter(n => !hit.has(n)) };
}

/** the shortest sub-sequence (by dropping events one at a time) that still breaks an invariant, with its error */
export function shrink(seq, { init, step, check }) {
  const fails = s => { let st = init(), err = check(st, []); for (let i = 0; i < s.length && !err; i++) { st = step(st, s[i]); err = check(st, s.slice(0, i + 1)); } return err; };
  let cur = [...seq], err = fails(cur);
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < cur.length; i++) { const t = [...cur.slice(0, i), ...cur.slice(i + 1)], e = fails(t); if (e) { cur = t; err = e; changed = true; break; } }
  }
  return { seq: cur, error: err };
}
