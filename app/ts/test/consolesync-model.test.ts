import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleSync, type SyncStatus, type SyncValues } from "../src/core/consolesync.ts";
import { type OscArg, oscFloat, oscInt } from "../src/core/oscwire.ts";

type Kind = "fader" | "gain" | "invert";

interface Reply {
  address: string;
  args: readonly OscArg[];
  value: number | boolean | null;
}

type Ev = { k: "reply"; r: Reply } | { k: "poll"; dt: number } | { k: "badPoll"; t: number } | { k: "begin" };

const fader = (ch: number): string => `/ch/0${ch}/mix/fader`;
const gain = (ch: number): string => `/headamp/00${ch - 1}/gain`;
const invert = (ch: number): string => `/ch/0${ch}/preamp/invert`;

const asks = (channels: readonly number[]): { address: string; ch: number; kind: Kind }[] =>
  channels.flatMap((ch) => [
    { address: fader(ch), ch, kind: "fader" as const },
    { address: gain(ch), ch, kind: "gain" as const },
    { address: invert(ch), ch, kind: "invert" as const },
  ]);

const ok = (address: string, kind: Kind): Reply => {
  if (kind === "fader") return { address, args: [oscFloat(0.75)], value: 0 };
  if (kind === "gain") return { address, args: [oscFloat(0.5)], value: 24 };
  return { address, args: [oscInt(1)], value: true };
};

const replies = (channels: readonly number[], wide: boolean): Reply[] => [
  ...asks(channels).map((a) => ok(a.address, a.kind)),
  { address: fader(1), args: [oscFloat(0.5)], value: -10 },
  { address: fader(1), args: [oscFloat(1.5)], value: null },
  { address: invert(1), args: [oscInt(2)], value: null },
  ...(wide
    ? [
        { address: invert(1), args: [oscInt(0)], value: false },
        { address: gain(1), args: [oscInt(0)], value: null },
        { address: fader(9), args: [oscFloat(0.75)], value: null },
      ]
    : []),
];

interface Run {
  name: string;
  channels: readonly number[];
  tries: number;
  depth: number;
  idleStart: boolean;
  answered: readonly number[];
  wide: boolean;
  polls: readonly number[];
  bad: readonly number[];
  restart: boolean;
}

const retryS = 0.5;

const runs: readonly Run[] = [
  {
    name: "two channels, two tries",
    channels: [1, 2],
    tries: 2,
    depth: 4,
    idleStart: false,
    answered: [],
    wide: true,
    polls: [0.25, 0.5, 100],
    bad: [],
    restart: true,
  },
  {
    name: "two channels with channel 2 already answered",
    channels: [1, 2],
    tries: 2,
    depth: 4,
    idleStart: false,
    answered: [2],
    wide: true,
    polls: [0.25, 0.5, 100],
    bad: [],
    restart: true,
  },
  {
    name: "one channel, three tries",
    channels: [1],
    tries: 3,
    depth: 6,
    idleStart: false,
    answered: [],
    wide: false,
    polls: [0.25, 0.5],
    bad: [],
    restart: false,
  },
  {
    name: "two channels from idle",
    channels: [1, 2],
    tries: 2,
    depth: 3,
    idleStart: true,
    answered: [],
    wide: true,
    polls: [0.25, 0.5, 100],
    bad: [],
    restart: true,
  },
  {
    name: "one channel, two tries, with polls at NaN and infinite times",
    channels: [1],
    tries: 2,
    depth: 4,
    idleStart: false,
    answered: [],
    wide: false,
    polls: [0.5, 100],
    bad: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    restart: true,
  },
];

const alphabetOf = (run: Run): Ev[] => [
  ...replies(run.channels, run.wide).map((r): Ev => ({ k: "reply", r })),
  ...run.polls.map((dt): Ev => ({ k: "poll", dt })),
  ...run.bad.map((t): Ev => ({ k: "badPoll", t })),
  ...(run.restart ? [{ k: "begin" } as const] : []),
];

const label = (e: Ev): string => {
  if (e.k === "begin") return "begin";
  if (e.k === "poll") return `poll(+${e.dt})`;
  if (e.k === "badPoll") return `poll(${e.t})`;
  return `reply(${e.r.address}=${e.r.value === null ? "bad" : String(e.r.value)})`;
};

const forEachSequence = (size: number, len: number, visit: (seq: readonly number[]) => void): number => {
  const seq: number[] = new Array<number>(len).fill(0);
  let count = 0;
  for (;;) {
    visit(seq);
    count++;
    let i = len - 1;
    while (i >= 0 && seq[i] === size - 1) {
      seq[i] = 0;
      i--;
    }
    if (i < 0) return count;
    seq[i] = (seq[i] ?? 0) + 1;
  }
};

interface Model {
  status: SyncStatus;
  now: number;
  beganAt: number;
  lastSend: number;
  rounds: number;
  answers: Map<string, number | boolean>;
  sends: Map<string, number>;
}

interface Tally {
  sequences: number;
  done: number;
  doneWithGaps: number;
  doneByReply: number;
  failed: number;
  resends: number;
  ignored: number;
  accepted: number;
  rejected: number;
}

const storedValue = (v: SyncValues, kind: Kind): number | boolean | null =>
  kind === "fader" ? v.faderDb : kind === "gain" ? v.gainDb : v.inverted;

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const runSequence = (run: Run, alphabet: readonly Ev[], seq: readonly number[], tally: Tally): void => {
  const sent: string[] = [];
  const sync = new ConsoleSync({ channels: run.channels, send: (a) => sent.push(a), retryS, tries: run.tries });
  const table = asks(run.channels);
  const all = table.map((a) => a.address);
  const kindOf = new Map(table.map((a) => [a.address, a.kind]));
  const m: Model = { status: "idle", now: 10, beganAt: 0, lastSend: 0, rounds: 0, answers: new Map(), sends: new Map() };
  const trail: Ev[] = [];
  const fail = (what: string): never => assert.fail(`${run.name}: ${what} after ${trail.map(label).join(" -> ")}`);
  const pendingList = (): string[] => (m.status === "idle" ? [] : all.filter((a) => !m.answers.has(a)));
  const expectSent = (want: readonly string[]): void => {
    const got = sent.splice(0);
    if (!sameList(got, want)) fail(`sent [${got.join(" ")}], expected [${want.join(" ")}]`);
    for (const a of got) m.sends.set(a, (m.sends.get(a) ?? 0) + 1);
  };
  const begin = (): void => {
    sync.begin(m.now);
    m.answers = new Map();
    m.sends = new Map();
    m.beganAt = m.now;
    m.lastSend = m.now;
    m.rounds = 1;
    m.status = table.length === 0 ? "done" : "pending";
    expectSent(all);
  };
  const opening: Ev[] = run.idleStart ? [] : [{ k: "begin" }];
  for (const a of asks(run.answered)) opening.push({ k: "reply", r: ok(a.address, a.kind) });
  const steps: Ev[] = [...opening, ...seq.map((i) => alphabet[i]!)];
  for (const ev of steps) {
    trail.push(ev);
    const before = m.status;
    if (ev.k === "begin") begin();
    else if (ev.k === "reply") {
      const kind = kindOf.get(ev.r.address);
      const want = m.status === "pending" && kind !== undefined && !m.answers.has(ev.r.address) && ev.r.value !== null;
      const got = sync.handle(ev.r.address, ev.r.args);
      if (got !== want) fail(`handle(${ev.r.address}) returned ${got}`);
      if (got) {
        tally.accepted++;
        m.answers.set(ev.r.address, ev.r.value!);
        if (pendingList().length === 0) {
          m.status = "done";
          tally.doneByReply++;
        }
      } else tally.rejected++;
      expectSent([]);
    } else if (ev.k === "badPoll") {
      const got = sync.poll(ev.t);
      if (got !== m.status) fail(`poll(${ev.t}) returned ${got}, expected ${m.status}`);
      expectSent([]);
      tally.ignored++;
    } else {
      m.now += ev.dt;
      let want: string[] = [];
      if (m.status === "pending" && m.now - m.lastSend >= retryS) {
        if (m.rounds < run.tries) {
          m.rounds++;
          m.lastSend = m.now;
          want = pendingList();
          tally.resends++;
        } else {
          m.status = pendingList().some((a) => kindOf.get(a) === "fader") ? "failed" : "done";
        }
      }
      const got = sync.poll(m.now);
      if (got !== m.status) fail(`poll returned ${got}, expected ${m.status}`);
      expectSent(want);
      if (got === "failed") {
        tally.failed++;
        const missingFader = pendingList().find((a) => kindOf.get(a) === "fader") ?? fail("failed with every fader answered");
        if (m.sends.get(missingFader) !== run.tries) fail(`failed after ${m.sends.get(missingFader)} requests for ${missingFader}`);
        if (m.now - m.beganAt < run.tries * retryS) fail("failed before every retry window passed");
      }
      if (got === "done" && before === "pending") {
        tally.done++;
        if (pendingList().length > 0) tally.doneWithGaps++;
      }
    }
    if (before !== "pending" && before !== "idle" && ev.k !== "begin" && m.status !== before) fail("a finished sync changed status");
    if (sync.active !== (m.status === "pending")) fail(`active is ${sync.active} with status ${m.status}`);
    if (m.status === "done") {
      for (const a of table) if (a.kind === "fader" && !m.answers.has(a.address)) fail(`done without a reply for ${a.address}`);
      if (pendingList().length > 0 && m.rounds < run.tries) fail("done with replies missing before the retries ran out");
    }
    for (const [a, n] of m.sends) if (n > run.tries) fail(`${a} was requested ${n} times`);
    const missing = sync.missing();
    if (!sameList(missing, pendingList())) fail(`missing() is [${missing.join(" ")}]`);
    const result = sync.result();
    if (result.size !== run.channels.length || run.channels.some((ch) => !result.has(ch)))
      fail("result channels differ from the requested channels");
    for (const a of table) {
      const got = storedValue(result.get(a.ch)!, a.kind);
      const want = m.answers.get(a.address) ?? null;
      if (got !== want) fail(`result for ${a.address} is ${String(got)}, expected ${String(want)}`);
    }
  }
};

for (const run of runs) {
  test(`every sequence of replies, retries and restarts keeps the console read honest: ${run.name}`, () => {
    const alphabet = alphabetOf(run);
    const tally: Tally = {
      sequences: 0,
      done: 0,
      doneWithGaps: 0,
      doneByReply: 0,
      failed: 0,
      resends: 0,
      ignored: 0,
      accepted: 0,
      rejected: 0,
    };
    tally.sequences = forEachSequence(alphabet.length, run.depth, (seq) => runSequence(run, alphabet, seq, tally));
    assert.equal(tally.sequences, alphabet.length ** run.depth);
    assert.ok(tally.accepted > 0);
    assert.ok(tally.rejected > 0);
    assert.ok(tally.resends > 0);
    assert.ok(tally.failed > 0);
    assert.equal(tally.ignored > 0, run.bad.length > 0);
    if (!run.idleStart) {
      assert.ok(tally.done > 0);
      assert.ok(tally.doneWithGaps > 0);
      if (3 * (run.channels.length - run.answered.length) <= run.depth) assert.ok(tally.doneByReply > 0);
    }
  });
}
