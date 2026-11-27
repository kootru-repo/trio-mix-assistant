import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeScrubber, templateWords } from "../src/core/diagnostics.ts";
import { showWords } from "../src/host/vet.ts";

test("the scrubber hides IPv6 addresses in full, compressed and zoned forms, and keeps loopback, times and versions", () => {
  const scrub = makeScrubber({ devices: [], words: [] });
  const input = [
    "lan 2001:0db8:85a3:0000:0000:8a2e:0370:7334 up",
    "link fe80::1c2b:3d4e:5f60:7a8b%en0 and fe80::1%12",
    "short 2001:db8::7 and ::ffff:192.168.1.9",
    "loopback ::1 stays",
    "at 10:23:45 the run took 00:01:02",
    "firmware 4.06-8, card aa:bb:cc:dd:ee:ff",
  ].join("\n");
  const out = scrub(input);
  for (const gone of ["2001:0db8", "8a2e", "fe80::", "1c2b", "en0", "2001:db8::7", "ffff", "192.168"])
    assert.ok(!out.includes(gone), `${gone} survived: ${out}`);
  for (const kept of ["::1 stays", "10:23:45", "00:01:02", "4.06-8", "xx:xx:xx:xx:xx:xx"])
    assert.ok(out.includes(kept), `${kept} lost: ${out}`);
  assert.match(out, /lan x:x:x:x:x:x:x:x up/);
});

test("the template's own name and every song name are private words; a broken template gives none", () => {
  const json = JSON.stringify({
    name: "Sunday at Grace",
    songs: [{ name: "Amazing Grace", scene: 1 }, { name: "  Way Maker  " }, { name: 7 }, {}],
  });
  assert.deepEqual(templateWords(json), ["Sunday at Grace", "Amazing Grace", "Way Maker"]);
  assert.deepEqual(templateWords("{not json"), []);
  assert.deepEqual(templateWords(JSON.stringify({ songs: "nope" })), []);
  const scrub = makeScrubber({ devices: [], words: templateWords(json) });
  assert.equal(scrub("recalled scene 1 for Amazing Grace, then way maker"), "recalled scene 1 for (name hidden), then (name hidden)");
});

test("the show's private words come from show.conf and from the template it names, relative to the settings folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrub-show-"));
  try {
    writeFileSync(join(dir, "set.json"), JSON.stringify({ name: "Late Set", songs: [{ name: "Holy Forever" }] }));
    writeFileSync(join(dir, "show.conf"), "VENUE=Grace Chapel\nTEMPLATE=set.json\n");
    assert.deepEqual(showWords(dir).sort(), ["Grace Chapel", "Holy Forever", "Late Set", "set.json"].sort());
    writeFileSync(join(dir, "show.conf"), "VENUE=Grace Chapel\nTEMPLATE=missing.json\n");
    assert.deepEqual(showWords(dir).sort(), ["Grace Chapel", "missing.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("song names are hidden only as whole words, and never inside the scrubber's own placeholders", () => {
  const scrub = makeScrubber({ devices: ["Hidden Mic"], words: ["Here", "Home", "Run", "name", "hidden"] });
  assert.equal(scrub("Fix: check where the device is. There, Here."), "Fix: check where the device is. There, (name hidden).");
  assert.equal(scrub("Run checks in the home folder"), "(name hidden) checks in the (name hidden) folder");
  assert.equal(scrub("Running Homer"), "Running Homer");
  assert.equal(scrub("input Hidden Mic"), "input (device name hidden)");
});

test("an IPv6 address is hidden whole: next to MAC-like groups, before a colon, and never a bare ::", () => {
  const scrub = makeScrubber({ devices: [], words: [] });
  assert.equal(scrub("addr 2001:db8:12:34:56:78:9a:bc up"), "addr x:x:x:x:x:x:x:x up");
  assert.equal(scrub("bind 2001:db8::7: address in use"), "bind x:x:x:x:x:x:x:x: address in use");
  assert.equal(scrub("fe80::1c2b:3d4e:5f60:7a8b: no route"), "x:x:x:x:x:x:x:x: no route");
  assert.equal(scrub("route :: none, Prefix: :: (unspecified)"), "route :: none, Prefix: :: (unspecified)");
  assert.equal(scrub("card aa:bb:cc:dd:ee:ff and ::ffff:192.168.1.9"), "card xx:xx:xx:xx:xx:xx and x:x:x:x:x:x:x:x");
  assert.equal(scrub("loopback ::1 at 10:23:45 on 127.0.0.1"), "loopback ::1 at 10:23:45 on 127.0.0.1");
});

test("a template or venue given on the command line is private too, as well as the ones in show.conf", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrub-args-"));
  try {
    const set = join(dir, "sunday.json");
    writeFileSync(set, JSON.stringify({ name: "Sunday Set", songs: [{ name: "Amazing Grace" }] }));
    assert.deepEqual(showWords(dir, { template: set, venue: "Riverside Hall" }).sort(), ["Amazing Grace", "Riverside Hall", "Sunday Set"]);
    assert.deepEqual(showWords(dir, { template: join(dir, "missing.json"), venue: "" }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
