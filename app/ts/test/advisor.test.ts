import assert from "node:assert/strict";
import test from "node:test";
import { Advisor, API_URL, DEFAULT_MODEL, jsonDumps, SYSTEM_PROMPT } from "../src/host/advisor.ts";
import type { AdvisorAdvice, FetchFn } from "../src/host/advisor.ts";
import { fixture } from "./helpers.ts";

const fx = fixture("sessionlog");

const fakeCaller =
  (advice: Record<string, unknown>) =>
  (): unknown => ({ ...advice });

function reply(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

const noop = { getContext: () => ({}), onAdvice: () => {} };

test("unavailable without key or caller", () => {
  const a = new Advisor({ ...noop, env: {} });
  assert.equal(a.available, false);
  assert.equal(a.start(), false);
});

test("the API key comes from the env or an explicit option", () => {
  assert.equal(new Advisor({ ...noop, env: { ANTHROPIC_API_KEY: "k" } }).available, true);
  assert.equal(new Advisor({ ...noop, env: { ANTHROPIC_API_KEY: "" } }).available, false);
  assert.equal(new Advisor({ ...noop, apiKey: "x", env: {} }).available, true);
});

test("an injected caller is available and ticks", async () => {
  const got: AdvisorAdvice[] = [];
  const a = new Advisor({
    getContext: () => ({ recent_events: [] }),
    onAdvice: (adv) => got.push(adv),
    env: {},
    caller: fakeCaller({ performer_prompt: "Ease the guitar", room_assessment: "2.5 kHz settling", severity: "notice" }),
  });
  assert.equal(a.available, true);
  const out = await a.tick();
  assert.equal(out!.performer_prompt, "Ease the guitar");
  assert.equal(got[0]!.severity, "notice");
  assert.equal(a.calls, 1);
});

test("the background loop fires and stop ends it", async () => {
  const got: AdvisorAdvice[] = [];
  const a = new Advisor({
    getContext: () => ({ recent_events: [] }),
    onAdvice: (adv) => got.push(adv),
    env: {},
    caller: fakeCaller({ performer_prompt: "ok", severity: "info" }),
    interval: 0.05,
  });
  assert.equal(a.start(), true);
  assert.equal(a.start(), false);
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const deadline = Date.now() + 2000;
    while (got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(got.length >= 2, "advisor background loop did not fire");
  } finally {
    a.stop();
  }
  const n = got.length;
  await new Promise((r) => setTimeout(r, 150));
  clearTimeout(keepAlive);
  assert.ok(got.length <= n + 1);
});

test("a caller error is swallowed", async () => {
  const a = new Advisor({
    ...noop,
    env: {},
    caller: () => {
      throw new Error("network down");
    },
  });
  assert.equal(await a.tick(), null);
  assert.match(a.lastError!, /network down/);
});

test("a non-object result counts as a call but delivers nothing", async () => {
  const got: unknown[] = [];
  const a = new Advisor({ getContext: () => ({}), onAdvice: (x) => got.push(x), env: {}, caller: () => null });
  assert.equal(await a.tick(), null);
  assert.equal(a.calls, 1);
  assert.deepEqual(got, []);
});

test("parse extracts JSON", () => {
  const p = Advisor.parse;
  const d = p('Sure! {"performer_prompt":"Lower the cajon","room_assessment":"boomy","severity":"warn"} done');
  assert.equal(d!.performer_prompt, "Lower the cajon");
  assert.equal(d!.severity, "warn");
  assert.equal(p("no json here"), null);
  assert.equal(p('{"severity":"bogus"}')!.severity, "info");
});

test("parse matches the recorded parser on recorded inputs", () => {
  for (const c of fx.parse as { in: string; out: AdvisorAdvice | null }[]) {
    assert.deepEqual(Advisor.parse(c.in), c.out, c.in.slice(0, 40));
  }
});

test("the request context serialises as recorded and is capped", () => {
  const ctxs = [
    { recent_events: [], mode: "simulation" },
    { a: 1, b: [1, 2, { c: "café — “q”" }], d: null, e: true, f: 0.5 },
    { big: "x".repeat(7000) },
  ];
  ctxs.forEach((c, i) => assert.equal(jsonDumps(c).slice(0, 6000), fx.contexts[i]));
});

test("the HTTP call posts the documented request and parses the reply", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return reply({
      content: [
        { type: "text", text: 'note {"performer_prompt":"Ease off","room_assessment":"ok","severity":"notice"}' },
        { type: "tool_use", id: "x" },
      ],
    });
  };
  const got: AdvisorAdvice[] = [];
  const ctx = { recent_events: [{ kind: "feedback", msg: "café" }] };
  const a = new Advisor({
    getContext: () => ctx,
    onAdvice: (x) => got.push(x),
    env: { ANTHROPIC_API_KEY: "sk-test" },
    fetch: fetchFn,
  });
  assert.equal(a.available, true);
  const out = await a.tick();
  assert.deepEqual(out, { performer_prompt: "Ease off", room_assessment: "ok", severity: "notice" });
  assert.deepEqual(got, [out]);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, API_URL);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    "content-type": "application/json",
    "x-api-key": "sk-test",
    "anthropic-version": "2023-06-01",
  });
  assert.ok(init.signal instanceof AbortSignal);
  const raw = init.body as string;
  const body = JSON.parse(raw);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.max_tokens, 300);
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.deepEqual(body.messages, [{ role: "user", content: jsonDumps(ctx) }]);
  assert.ok(!/[^\x00-\x7f]/.test(raw));
});

test("the HTTP call caps the context at 6000 characters", async () => {
  let sent = "";
  const fetchFn: FetchFn = async (_url, init) => {
    sent = JSON.parse(init.body as string).messages[0].content;
    return reply({ content: [] });
  };
  const a = new Advisor({ getContext: () => ({ big: "x".repeat(9000) }), onAdvice: () => {}, apiKey: "k", env: {}, fetch: fetchFn });
  assert.equal(await a.tick(), null);
  assert.equal(sent.length, 6000);
  assert.equal(a.calls, 1);
});

test("an HTTP error status is recorded and swallowed", async () => {
  const fetchFn: FetchFn = async () => reply({ error: "x" }, { status: 401, statusText: "Unauthorized" });
  const a = new Advisor({ ...noop, apiKey: "k", env: {}, fetch: fetchFn });
  assert.equal(await a.tick(), null);
  assert.equal(a.calls, 0);
  assert.match(a.lastError!, /401/);
});

test("a network failure is recorded and swallowed", async () => {
  const fetchFn: FetchFn = async () => {
    throw new TypeError("fetch failed");
  };
  const a = new Advisor({ ...noop, apiKey: "k", env: {}, fetch: fetchFn });
  assert.equal(await a.tick(), null);
  assert.equal(a.lastError, "TypeError: fetch failed");
});
