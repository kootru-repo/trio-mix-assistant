// Drives real Safari on a Mac CI runner: starts the downloaded app the way a
// double-click does (from the home folder), optionally runs the Terminal
// microphone test first, opens the dashboard, clicks Run full test as soon as
// it is enabled and waits for the completion popup.
//
// usage: node safari-run-full.mjs <app folder> <fresh|terminal-first> <output folder>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [appDir, scenario, outDir] = process.argv.slice(2);
if (!appDir || !["fresh", "terminal-first"].includes(scenario) || !outDir) {
  console.error("usage: node safari-run-full.mjs <app folder> <fresh|terminal-first> <output folder>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const exe = join(appDir, "TrioMixAssistant");
const logFile = join(outDir, "steps.log");
const t0 = Date.now();
const log = (line) => {
  const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`;
  console.log(s);
  appendFileSync(logFile, s + "\n");
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function terminalFirst() {
  log("Terminal step: ./TrioMixAssistant --list-devices");
  const list = spawnSync(exe, ["--list-devices"], { cwd: appDir, encoding: "utf8", timeout: 60000 });
  writeFileSync(join(outDir, "list-devices.txt"), (list.stdout || "") + (list.stderr || ""));
  log(`  exit ${list.status}`);
  const m = /^\s*\[(\d+)\]/m.exec(list.stdout || "");
  const args = m ? ["--diagnose", "--audio-device", m[1]] : ["--diagnose"];
  log(`Terminal step: ./TrioMixAssistant ${args.join(" ")}`);
  const diag = spawnSync(exe, args, { cwd: appDir, encoding: "utf8", timeout: 90000 });
  writeFileSync(join(outDir, "diagnose.txt"), (diag.stdout || "") + (diag.stderr || ""));
  log(`  exit ${diag.status}`);
}

const W3C_ELEMENT = "element-6066-11e4-a07c-4ec5ad8c2ef0";
let driverBase = "";
let session = "";
async function wd(method, path, body) {
  const r = await fetch(driverBase + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j.value ?? j)}`);
  return j.value;
}
const exec = (script) => wd("POST", `/session/${session}/execute/sync`, { script, args: [] });
async function click(css) {
  let el = null;
  for (let i = 0; i < 100 && !(el && el[W3C_ELEMENT]); i++) {
    el = await wd("POST", `/session/${session}/execute/sync`, { script: "return document.querySelector(arguments[0]);", args: [css] });
    if (!(el && el[W3C_ELEMENT])) await pause(100);
  }
  if (!(el && el[W3C_ELEMENT])) throw new Error(`no element ${css} (got ${JSON.stringify(el)})`);
  await wd("POST", `/session/${session}/element/${el[W3C_ELEMENT]}/click`, {});
}
async function shot(name) {
  try {
    const b64 = await wd("GET", `/session/${session}/screenshot`);
    writeFileSync(join(outDir, name + ".png"), Buffer.from(b64, "base64"));
  } catch (e) {
    log(`screenshot ${name} failed: ${e.message}`);
  }
}

const PROBE = `
const q = (s) => document.querySelector(s);
const t = (s) => { const e = q(s); return e ? e.textContent.trim() : null; };
const why = q('#vetwhy');
const done = q('#donewrap');
return {
  ready: !!q('#vetrun'),
  disabled: q('#vetrun') ? q('#vetrun').disabled : null,
  button: t('#vetrun'),
  why: why && !why.hidden ? why.textContent.trim() : '',
  shield: q('#vetshield') ? !q('#vetshield').hidden : null,
  stage: t('#vetstage'), pct: t('#vetpct'), now: t('#vetnow'), steps: t('#vetsteps'),
  done: done ? !done.hidden : false,
  doneKind: q('#donecard') ? q('#donecard').className : '',
  doneTitle: t('#donetitle'), doneBody: t('#donebody'),
  errors: window.__errs || [],
};`;
const HOOK = `
if (!window.__errs) {
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));
  const ce = console.error.bind(console);
  console.error = (...a) => { window.__errs.push('console.error: ' + a.map(String).join(' ')); ce(...a); };
}`;

let app = null;
let driver = null;
let result = "no popup";
try {
  if (scenario === "terminal-first") terminalFirst();

  // A double-click opens Terminal in the home folder and runs the app from there.
  log(`Starting the app from ${homedir()}`);
  app = spawn(exe, [], { cwd: homedir(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const keep = (d) => { out += d; appendFileSync(join(outDir, "app.log"), d); };
  app.stdout.on("data", keep);
  app.stderr.on("data", keep);
  let url = "";
  for (let i = 0; i < 300 && !url; i++) {
    const m = /Dashboard:\s+(https?:\/\/\S+)/.exec(out);
    if (m) url = m[1];
    else await pause(100);
  }
  if (!url) throw new Error("the app never printed its dashboard address");
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not listening yet */ }
    await pause(100);
  }
  log(`App is serving ${url}`);

  // The app opened the default browser itself; close that copy so safaridriver owns Safari.
  spawnSync("killall", ["Safari"]);
  await pause(3000);

  driver = spawn("safaridriver", ["-p", "4444"], { stdio: "ignore" });
  driverBase = "http://127.0.0.1:4444";
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(driverBase + "/status")).ok) break; } catch { /* starting */ }
    await pause(100);
  }
  let s = null;
  for (let attempt = 1; !s; attempt++) {
    try {
      s = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`Safari session attempt ${attempt} failed, retrying: ${e.message}`);
      spawnSync("killall", ["Safari"]);
      await pause(5000);
    }
  }
  session = s.sessionId;
  log(`Safari ${s.capabilities.browserVersion} session open`);

  await wd("POST", `/session/${session}/url`, { url });
  await exec(HOOK);
  log("Dashboard loaded");
  await click('button.tab[data-tab="settings"]');

  let st = await exec(PROBE);
  let seenWhy = null;
  const waitStart = Date.now();
  while (Date.now() - waitStart < 60000 && (!st.ready || st.disabled)) {
    if (st.why !== seenWhy) { log(`Run full test greyed out: ${st.why || "(no reason shown)"}`); seenWhy = st.why; }
    await pause(100);
    st = await exec(PROBE);
  }
  if (st.disabled) throw new Error("Run full test stayed greyed out for 60 s: " + st.why);
  log(`Run full test is enabled (${((Date.now() - waitStart) / 1000).toFixed(1)} s after the page loaded); clicking it`);
  await click("#vetrun");
  await pause(2000);
  await shot("after-click");

  let last = "";
  const runStart = Date.now();
  while (Date.now() - runStart < 240000) {
    st = await exec(PROBE);
    const line = st.done
      ? `POPUP [${st.doneKind}] ${st.doneTitle}: ${st.doneBody}`
      : `bar=${st.shield ? "shown" : "hidden"} ${st.stage} ${st.pct} | ${st.now} | ${st.steps} | button="${st.button}"${st.why ? " | " + st.why : ""}`;
    if (line !== last) { log(line); last = line; }
    if (st.done) break;
    await pause(500);
  }
  if (st.errors.length) log("Page errors:\n  " + st.errors.join("\n  "));
  await shot("end");
  if (!st.done) result = "no popup";
  else if (/\b(bad|warn)\b/.test(st.doneKind)) result = `${st.doneTitle}: ${st.doneBody}`;
  else result = "pass";
} catch (e) {
  result = "error: " + e.message;
  log(result);
  if (session) await shot("error");
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => undefined);
  if (driver) driver.kill();
  if (app) app.kill("SIGINT");
  spawnSync("killall", ["Safari"]);
}
log(`RESULT (${scenario}): ${result}`);
process.exit(result === "pass" ? 0 : 1);
