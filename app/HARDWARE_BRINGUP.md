# Hardware bring-up & validation checklist

The software is feature-complete, but **production readiness is gated by validation
against your real M32C + audio interface**, and that can only be done with the gear
in front of you. The X32/M32 OSC scalings and the `/meters` blob layout vary by
firmware, so verify every constant with a sniffer before trusting it
live. Work through this once on the bench, then once at a real soundcheck.

Nothing here is destructive to a show: do it with the PA off or at low volume, and
keep a hand on the console. The app only ever *nudges* within guardrails, and a human
takeover always wins.

---

## What the emulator already covers (and what it can't)

Before you touch hardware, `./TrioMixAssistant --emulate` (`.\TrioMixAssistant.exe` on Windows, here and in every command below) runs the **entire** real stack:
`OscConsole` → UDP socket → a protocol-faithful desk emulator → `/meters` stream +
`/xremote` echoes → `MeterReceiver` → reconciliation, plus the real capture path fed
by a timed audio stream. `npm test`, run in `app/ts` of a source checkout (the emulator and protocol tests),
then asserts the exact wire layout. Together these validate the **mechanics**: OSC
framing/encode/decode, the subscribe→renew handshake, self-move-echo vs.
reconciliation timing, scene-recall round-trips, meter-blob parsing, and the
capture and dead-stream paths, all without gear.

What the emulator **cannot** tell you: whether those formats are *correct for your
firmware*. The emulator encodes the same assumptions the app does, so it can only
prove self-consistency. The checklist below (especially section 1) is exactly the
set of assumptions to confirm against the real desk. Each is pinned by the
recorded values in `ts/fixtures/emulator.json` and `ts/fixtures/osc.json` (checked by the emulator and OSC tests); once you have a capture, replace those values with the
real bytes and the test suite becomes a true regression gate.

---

## 0. Prep
- [ ] The single-file app downloaded from the [releases page](https://github.com/kootru-repo/trio-mix-assistant/releases/latest) (it carries the runtime and the audio module). From source instead: Node.js 22.13+ and the native audio module `naudiodon2`. Capture from the console's multichannel USB feed has not been tried yet; §3 below is that test.
- [ ] Console and laptop on the same wired/Wi-Fi LAN; note the console IP.
- [ ] A sniffer ready: Wireshark (UDP 10023/10024) or the X32 OSC monitor / `OSC` debug.
- [ ] With the PA off, run the full test on one spare channel: `./TrioMixAssistant --vet --hardware --console-ip <ip> --vet-channel <N>` (newer than release 0.2.2: until the next release, from source with `npm run run -- --vet …` in `app/ts`). It changes the fader, mute, polarity, EQ and one FX send on that channel, reads each value back from the console and puts it back. Keep the log it writes. It shows the console stored what the app sent, not what the console displays, so §1 below is still needed.

## 1. OSC control scalings  (the #1 thing to verify)
For each, make the app change it and confirm the console does the **same** thing. Faders
also go the other way: move one on the console and confirm the app shows the same value.
Preamp gain and polarity have no dashboard control: trigger the clip or phase job and watch the desk.
- [x] **Fader**: VALIDATED against **X32-Edit** (2026-06-30). The emulated desk
      serves X32-Edit's discovery + sync, so X32-Edit renders what the app sends.
      Pushed 0/+5/−10/−20/−40 dB via `dbToFader` → X32-Edit displayed exactly those
      dB. The piecewise-linear 0..1 ↔ dB law in `ts/src/core/console.ts` matches Behringer's. (Re-confirm on the
      real M32C, but the scaling itself is no longer an assumption.)
      **Also (2026-07-03): Mixing Station (Android) fully syncs the emulated desk**,
      including discovery, whole-tree sync, /node bulk reads, show/scene list, and live
      meter streams. That is a second independent implementation accepting our wire formats.
- [ ] **Preamp gain**: clip-trim −2 dB actually drops the head-amp ~2 dB.
- [ ] **Channel EQ notch**: a feedback notch lands on the right band, freq, Q, and gain.
- [ ] **Main-bus PEQ**: room-correction cuts hit the main/stereo bus, not a channel.
- [ ] **Mute** and **scene recall** (`/-action/goscene`) do what you expect.
- [ ] **Polarity/phase invert** (`/ch/NN/preamp/invert`, for the *phase* job): when the phase
      job flips it, the channel Φ toggles on the desk. **Also confirm the card/USB tap
      point is POST-invert**: the phase job's auto-flip only closes the loop if the
      signal the app captures reflects the polarity flip (else it correctly falls back
      to advisory after one flip). If the address differs, fix it in `console.ts`.
> If any mapping is off, fix the scaling in `ts/src/core/console.ts` (or `config.ts`); the
> code centralises every conversion so there's one place to correct per parameter.

> **Validate the app→console direction NOW, without the desk:** run
> `./TrioMixAssistant --emulate --lan --https --pin 123456` (`.\TrioMixAssistant.exe` on Windows) and
> connect **Mixing Station** (or X32-Edit) to the laptop (it discovers the
> emulated desk as *MixAssist* at the LAN IP on UDP 10023). Anything the app sends is
> rendered by a production mixer app, so the mute/EQ-notch/headamp/scene assumptions
> above can each be confirmed against it the same way the fader was. (The `/meters`
> ingestion in §2 is console→app, so it still needs the real desk.)

## 2. `/meters` ingestion + fader reconciliation
- [ ] Start the app in hardware mode; in the sniffer confirm the console is sending
      `/meters` (or `/meters/1`) blobs to UDP 10024 after the app's `/batchsubscribe` + `/xremote`.
      The app sends those requests from UDP 10024 too, because the console replies to
      the port a request came from. If the sniffer shows them leaving from another
      port, another program was holding 10024 when the app started.
- [ ] Confirm `decodeMeterBlob` (in `oscwire.ts`) produces sane values (0..1). If the count
      or float layout is off for your firmware, adjust `decodeMeterBlob`.
- [ ] Move a fader **on the console**; confirm the app log shows
      "moved on console → …" and auto-ride yields (Settings shows Console feed `connected · N meters`).
- [ ] Confirm the app's own ride moves do **not** show up as "moved on console"
      (self-move suppression is working).

## 3. Audio capture (the listening half)
- [ ] Run the built-in checks first: `./TrioMixAssistant --diagnose --hardware --console-ip <ip> --audio-device <N>`. They are read-only and cover most of this section: the input opens with enough channels, audio arrives without gaps, the signal is not digital silence, and each channel shows a level. Keep the report.
- [ ] `./TrioMixAssistant --hardware --console-ip <ip> --list-devices` → find the interface
      (the console's USB/card return + the FOH measurement mic).
- [ ] Launch with `--audio-device <n>`; confirm `capture: {kind: audio, dead: false}` in `/state`
      and that channel meters move with real input.
- [ ] Verify the **channel map**: console channel N must map to the device channel the
      app reads for role N. Default is N→N−1; if your routing differs pass
      `--channel-map "1:0,2:1,…,8:9"` (console 1-based : device column 0-based). Speak
      into the lead mic; the *lead* meter moves. (Rig spec: `HARDWARE_SETUP.md`.)
- [ ] Confirm the **measurement mic** is on `MEAS_MIC_CH` (config) and hears the room.
- [ ] Confirm the dashboard's Decision log shows `listening on '<your interface>' (N ch)` (catches a
      wrong/shifted device index) and the footer chip reads `audio: … ok`.
- [ ] **macOS:** if you ever clicked "Don't Allow" on the mic prompt, the footer chip
      shows **SILENT** and a banner says "inputs are silent — check Microphone
      permission". Fix in System Settings → Privacy & Security → Microphone.
- [ ] **Unplug test:** pull the interface briefly → a full-screen "audio capture stopped — the assistant is deaf" alert appears;
      re-plug → the app auto-recovers within a few seconds ("audio capture recovered"
      in the log, alert clears). No restart needed.

## 4. Calibration (pink noise)
- [ ] PA at a safe level. Run calibration; confirm pink noise actually plays out the PA
      and the meas mic records it (watch for a "calibration heard only … dBFS at the mic" message, which means
      playback or the mic isn't reaching the analyzer).
- [ ] Confirm the resulting cuts land on the main bus and sound sensible (no wild EQ).

## 5. Show clock → scene recall  (if using AbleSet)
- [ ] Point AbleSet's OSC output at the app: `--ableset-port <p>`.
- [ ] In the sniffer, confirm AbleSet sends `/setlist/activeSongName` etc. If the
      addresses differ on your AbleSet version, adjust the address `switch` in
      `AbleSetReceiver.handle` (`ts/src/core/showclock.ts`).
- [ ] Change songs in AbleSet → the app recalls the template's scene and the song bar
      updates. Verify scene numbers in your `--template` match the console's scenes.

## 6. Latency / success criteria
- [ ] Watch the **Detect→actuate** row on the Settings screen, and `capture.lag_ms` and
      `capture.stale` in `/state`. The row times a block from capture to the console write and should stay at a few
      milliseconds; investigate if it or the lag grows or `stale` keeps counting (CPU contention, or too
      small a buffer on the audio interface). The footer's `loop …ms · jit …ms` only shows
      that the app's timer is healthy: audio is analysed on a separate thread.

## 7. First real show: safety-net only
- [ ] Run in **COACH** mode; the Coach panel and the decision log list each move it
      *would* make. Confirm they are correct before letting it act.
- [ ] Enable feedback + clip protection first; add vocal ride / balance once trusted.
- [ ] Keep TAKEOVER one tap away. Review the SQLite session log afterwards
      (`sessions.db`) and tag the venue (`--venue`) to start building venue history.

---

## Known limitations (by design; plan around these)

- **One input device must expose all channels.** The listening half opens a single
  audio device for the console returns **and** the measurement mic. If your meas mic
  is on a *separate* interface, combine them first: macOS → Audio MIDI Setup
  **Aggregate Device**; Windows → a single multichannel interface (the audio
  module has no ASIO, so an ASIO aggregate such as ASIO4ALL will not work). A device with too few channels is rejected with a
  clear message in the Decision log, and the app keeps running without listening.
- **48 kHz, float32.** Capture runs at 48 kHz. The app does not resample: if the driver refuses 48 kHz, the device fails to open
  with a message naming 48000 Hz; set the interface to 48 kHz.
- **Calibration output.** Pink noise plays to the OS default output unless you pass
  `--output-device` (point it at the PA; it is not used with `--auto`). Otherwise it may play out the laptop
  speakers and calibration will (correctly) stop with "calibration heard only … dBFS at the mic".
- **The emulator validates mechanics, not your firmware's exact OSC formats**; that's
  what §1 is for.
- **Channel EQ shares 4 bands.** The X32/M32 input has 4 PEQ bands; the performer EQ
  view and the automatic feedback notcher use the *same* 4 bands. In simulation the EQ view shows
  active notches as dashed markers + a note; with a console it does not. An operator edit and an auto-notch
  can land on the same band. The operator (or TAKEOVER) wins. The FX/aux send
  OSC addresses are unverified against a real desk, like the rest.
- **TAKEOVER holds the *automatic* system, not your hands.** Takeover mutes the main
  and freezes all automatic jobs + scene recall + calibration; the manual surface
  (faders, mutes, EQ, FX, sends from the dashboard on the laptop, iPhone or iPad) stays live so you can fix
  things by hand. Quitting the app leaves the console untouched.

The app detects and surfaces the rest (denied mic permission, a mid-show
unplug + auto-recovery, xruns, a busy/late device that recovers without a relaunch,
port clashes, a lost console feed). See RUNBOOK.md §10.

---

When every box is checked on your console, the hardware path is validated and the
system is production-ready for that rig. Re-verify section 1 after any console
firmware update.
