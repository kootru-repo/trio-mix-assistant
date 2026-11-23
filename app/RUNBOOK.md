# Runbook: Acoustic Trio Mix‑Assistant (macOS & Windows)

A practical, show‑day operating guide for the FOH laptop. The app is the same on
both OSes (one downloaded file, nothing to install); only the shell syntax
and a few OS permissions differ. Where a step is identical, it's written once;
where it differs, there's a **macOS** and a **Windows** version side by side.

> Conventions: lines starting `$` are **macOS Terminal** (zsh/bash); lines
> starting `PS>` are **Windows PowerShell**. macOS continues lines with a
> backslash `\`; PowerShell continues with a backtick `` ` ``.
>
> Commands use the downloaded app and are typed in a terminal opened in the app's
> folder. Running from source instead? In `app/ts`, use `npm start` for a start with no
> flags (or `npm start -- --diagnose` for the checks alone, or `npm start -- --rehearse`) and `npm run run --` when you give any other flag. In the Node.js
> folder package, use `node js/host/launch.js` and `node js/host/main.js` the same way.

---

## 0. Mental model (read once)

- **The console is the source of truth.** The app *listens* (channel audio + a FOH
  measurement mic) and *nudges* the desk within hard guardrails. It never owns the mix.
- **A human always wins.** Move a fader on the desk and the app adopts it (auto‑ride
  yields); tap **TAKEOVER** and it mutes main + freezes every automatic move.
- **The Claude advisor (optional) never touches the mix.** It only posts text suggestions.
- **First time on a given console you must validate the OSC formats** against that
  firmware (see `HARDWARE_BRINGUP.md`). After that passes once, every show is just the
  launch command in §3.

---

## 1. Install (one time per laptop)

Download the app for the laptop from the [releases page](https://github.com/kootru-repo/trio-mix-assistant/releases/latest). It carries
its own runtime and the audio module, so nothing else is installed.

- **macOS:** pick `arm64` (Apple Silicon) or `x64` (Intel), then:
  ```bash
  $ mkdir -p ~/TrioMix && cd ~/TrioMix
  $ tar -xzf ~/Downloads/TrioMixAssistant-macos-arm64.tar.gz
  ```
  If macOS refuses to open it: System Settings → Privacy & Security → **Open Anyway**.
- **Windows:** unzip `TrioMixAssistant-windows-x64.zip` into a folder on the laptop's
  own disk. The first start shows a SmartScreen warning: **More info → Run anyway**.

Check it starts:
```bash
$ ./TrioMixAssistant --list-devices
```
```powershell
PS> .\TrioMixAssistant.exe --list-devices
```

### 1.1 Let the app check the setup

Once the rig is set up (§2), run the built-in checks. They listen for about
eight seconds when there is a real input or a console (real or emulated) to check, change nothing on the console and play no sound. With no other flags
they check the setup saved in `show.conf`:
```bash
$ ./TrioMixAssistant --diagnose
```
```powershell
PS> .\TrioMixAssistant.exe --diagnose
```
Each line is PASS, WARN, FAIL or SKIP, with a fix under anything that is not right. The
command exits with 1 if a check failed. Add flags to check something other than
`show.conf`, for example `--diagnose --audio-device 2` for one input, or
`--diagnose --hardware --console-ip 192.168.1.50 --audio-device 2` for the full rig.

While the app is running, use **Settings → Run checks** on the dashboard instead (the
running app already holds the audio input and the console's reply port). The report
there has a **Copy report** button.

The checks cover the audio module, the input, the audio flow, the microphone
permission, each channel's level, the console's meter feed and phone or tablet access. They do
not test that fader and EQ commands land correctly; that is §1.2 and §2.4.

### 1.2 Test everything (`--vet`)

`--vet` is the full test. It is newer than release 0.2.2, so until the next release it
runs only from source (`npm run run -- --vet` in `app/ts`). Its settings come from the
command line, not from `show.conf`; it only checks that `show.conf` is valid. On its own it tests this computer and the built-in emulator, plays no sound and contacts
no console:
```bash
$ ./TrioMixAssistant --vet
```
```powershell
PS> .\TrioMixAssistant.exe --vet
```
Each step is PASS, FAIL or SKIP. The command exits with 1 if a step failed and writes
`vet-<date>-<time>.log`, with each console command sent and each reply received, to the settings folder.
A pass on the emulator does not prove a real console. To test the real one, with the PA off:
```bash
$ ./TrioMixAssistant --vet --hardware --console-ip 192.168.1.50 --vet-channel 16
```
```powershell
PS> .\TrioMixAssistant.exe --vet --hardware --console-ip 192.168.1.50 --vet-channel 16
```
On channel 16 this changes the fader, mute, polarity, EQ and one FX send, reads each value
back and puts it back. Without `--vet-channel` or `--vet-main` the console is only asked to identify itself
and send meters. `--vet-gain`, `--vet-main`, `--vet-sound` and `--vet-phone` are in §9.
A scene is never recalled on a real console.

Settings and logs live in `~/Library/Application Support/TrioMixAssistant` (macOS) or
`%LOCALAPPDATA%\TrioMixAssistant` (Windows); the downloaded app prints the folder at
every start.

> **Before you rely on it:** listening on a Mac and capture from a console's
> multichannel USB feed have not been tried yet. See
> [What has been tested](https://github.com/kootru-repo/trio-mix-assistant#tested).
>
> **From source** (developers): Node.js 22.13+ and `npm install` in `app/ts`. Live
> listening then needs the native module `naudiodon2`, which `npm install` compiles
> when a C++ compiler is present. The Node.js folder package made by `npm run package` does not
> carry it.

---

## 2. First‑time rig setup (once per console + interface)

Do this with the **PA off or at low volume**, hand on the console.

### 2.1 Put everything on one network
- Console, FOH laptop (and tablet if used) on the **same LAN/subnet**, wired or a
  dedicated Wi‑Fi AP. Wire the laptop to the console where you can (`HARDWARE_SETUP.md` §3.4). Note
  the **console IP**.

### 2.2 Find the audio interface
```bash
$ ./TrioMixAssistant --list-devices
```
```powershell
PS> .\TrioMixAssistant.exe --list-devices
```
Note the **index** of the input device carrying the console's USB/card return **and**
your measurement mic.

- **macOS multichannel:** if the console return and the meas mic are *separate*
  devices, combine them in **Audio MIDI Setup → "+" → Create Aggregate Device**, then
  use that aggregate's index. (Same interface for both = nothing to do.)
- **Windows multichannel:** prefer the interface's WASAPI device (ASIO is not available in the audio module) that
  exposes all input channels at once.

### 2.3 Grant OS permissions (first launch will need these)
- **macOS Microphone (critical):** the first time, **System Settings → Privacy &
  Security → Microphone → enable Terminal** (or your IDE). If denied, capture is
  *silent*, the assistant is deaf, and calibration stops with "calibration heard only … dBFS at the mic".
- **macOS Network:** when you launch with `--lan`, click **Allow** on the "accept
  incoming connections?" prompt.
- **Windows Firewall:** the first `--lan` or hardware-mode launch pops **Windows Defender Firewall**.
  Check **Private networks → Allow access** (otherwise the tablet can't connect, and
  the console's meter replies on UDP may be blocked).

### 2.4 Validate the OSC contract (the real gate)
Walk **`HARDWARE_BRINGUP.md` §1–§5** with a sniffer (Wireshark / X32 OSC monitor):
confirm fader/gain/EQ scalings, the `/meters` decode, scene recall, and the channel
map. Speak into the lead mic; the **lead** meter (not another) must move. This is the
one step the emulator can't do for you. Done once per firmware.

> Want to rehearse the whole flow *before* the gear arrives? `./TrioMixAssistant --emulate` (Windows: `.\TrioMixAssistant.exe --emulate`)
> runs the identical stack against a built‑in desk emulator (see §8).

---

## 3. Show‑day launch

### macOS
```bash
$ ./TrioMixAssistant --hardware \
      --console-ip 192.168.1.50 \
      --audio-device 2 \
      --template myset.json \
      --venue "The Cellar" \
      --lan --https --pin 123456
```

### Windows
```powershell
PS> .\TrioMixAssistant.exe --hardware `
      --console-ip 192.168.1.50 `
      --audio-device 2 `
      --template myset.json `
      --venue "The Cellar" `
      --lan --https --pin 123456
```

Use a PIN of your own, six or more characters: the app refuses to serve the
network without one. The same settings can be saved in `show.conf` (`MODE`,
`CONSOLE_IP`, `AUDIO_DEVICE`, `OUTPUT_DEVICE`, `TEMPLATE`, `VENUE`, `LAN`, `HTTPS`, `PIN`); then start the app with no flags.

Optional add‑ons (either OS):
- `--ableset-port 39051`: AbleSet drives automatic scene recall.
- `--advisor`: the Claude advisory layer. Set the key first:
  - macOS: `$ export ANTHROPIC_API_KEY=sk-...`
  - Windows: `PS> $env:ANTHROPIC_API_KEY="sk-..."`
- Drop `--audio-device` to run **manual mixing + scene recall only** (assistant idle).
- Without `--lan` (laptop only), `--https` and `--pin` can be dropped: plain http is fine on the laptop itself.

On launch it prints the dashboard URL (and a scan‑to‑open QR when `--lan`). On a network with no gateway (laptop and console only) it shows the laptop's first network address; if it finds none it prints no QR, so open `https://<laptop-ip>:8770/` by hand.

### 3.1 Verify in the first 30 seconds (on the dashboard)
| Check | Good value |
|---|---|
| Mode badge | **HARDWARE** |
| Status pill | **AUTO** (green), not **ALERT** |
| Footer audio chip | `audio: <your interface> ok` (not SILENT / DEAD / XRUN) |
| Settings → Connections → **Console feed** | `connected · N meters` (not `no feed`) |
| Footer loop time | `loop …ms · jit …ms` small, stable |

The app actively watches the hardware and raises an alert for the common
problems (a banner, or a full-screen **NEEDS ATTENTION** overlay for the critical ones), so
you don't have to read gauges:
- *"inputs are silent — check Microphone permission…"* → on macOS, check the
  **Microphone** permission first; then input gain and the patch.
- *"audio capture stopped — the assistant is deaf"* → the interface was unplugged/lost;
  re-connect it and the app **auto-recovers** (the overlay clears, "audio capture
  recovered" appears in the log).
- *"no console feed … — check the console IP, network, and firewall"* → OSC isn't
  arriving; see §10.
- *"audio interface is dropping samples (xruns)…"* → raise the device buffer size.

The dashboard's Decision log shows **`listening on '<device name>' (N ch)`**. Confirm it's the right
interface (this catches a shifted device index). **Don't go live while the pill is ALERT.**

---

## 4. Soundcheck sequence (build trust gradually)

1. **Calibrate the room:** PA at show level, room quiet, then *Run calibration*. The pink noise plays to `OUTPUT_DEVICE` (`--output-device`), or to the computer's default output if that is blank, so make sure that output feeds the PA. Watch for
   a "calibration heard only … dBFS at the mic" message (it means pink noise or the meas mic isn't reaching the
   analyzer; fix that before continuing).
2. **Start with the safety net only:** *Feedback notch* + *Clip protection* (both are on at
   start; Vocal ride and Balance hold start off). Watch the
   **decision log** and confirm what it does is correct before adding more.
3. **Add vocal ride**, then **balance** (set your levels, tap *Capture balance now*).
4. **Load the set:** confirm the song bar shows the right song/scene (it appears while a show clock runs, which on a real console needs AbleSet); tap a scene in the
   **Scenes** panel to test manual recall.
5. Keep **TAKEOVER** within reach.

---

## 5. Phone or tablet (iPhone, iPad or Android, optional)

The dashboard has not been tried on a real iPhone or iPad yet; see
[What has been tested](https://github.com/kootru-repo/trio-mix-assistant#tested).

Launched with `--lan` (and ideally `--https`):
1. On the phone or tablet, open the printed LAN URL or **scan the QR** in the terminal
   (on an iPhone or iPad, use Safari).
2. `--https` is self‑signed → **accept the certificate warning once** (it returns when the laptop's network address changes, such as at a new venue).
3. **Add to Home Screen** → it installs as a full‑screen PWA with screen Wake Lock.
4. Same network only; if the AP has "client isolation"/guest mode, turn it off.

---

## 6. During the show

- **Screens** (tabs at the top): **Mix** (faders + jobs + log, the 95% view) · **EQ**
  (per-channel 4-band PEQ with a live curve; dashed markers = the assistant's auto
  notches, shown in simulation only) · **FX** (per-channel sends + wet returns) · **Settings** (connection,
  latency, room SNR, venue model).
- **Notifications, 4 levels:** silent auto-correct → log entry → dismissable **banner**
  (warn) → full-screen **acknowledge overlay** (critical). No non-critical pop-ups in
  the **first 8 bars** of a song.
- **Operator overrides win:** a console/iPad fader move is adopted automatically; the
  app stops riding that channel briefly. EQ/FX/fader edits stay live even under takeover.
- **COACH** (header button): flips the assistant from *acting* to *advising*. It detects
  the same feedback/clip/level problems but, instead of touching the console, lists the
  exact manual move (channel, band, dB, Hz) in a **Coach — manual moves** panel and the
  decision log (e.g. *"Feedback 2500 Hz in the room → cut the MAIN BUS at 2500 Hz by -9 dB
  (Q 8)"*). **Calibration is coach-aware too:** with coach on, *Run calibration* still
  measures the room but *advises* the main-bus EQ (*"set MAIN-BUS PEQ: band 1 250 Hz
  -6.0 dB…"*) as a standing recommendation instead of applying it. The numbers are
  the same deterministic math the automatic jobs would use. Coach suspends every
  automatic console write, covering mix corrections (feedback, clip, vocal ride, balance,
  calibration) **and** setlist automation (scene recall, guest mutes), and advises each
  instead. **Only your own manual moves (faders, mutes, a scene you tap) actually act.**
  The status pill reads **COACH**. Use it to mix by hand with the app as a guide, or to
  see what it *would* do before trusting a job.
- **TAKEOVER** = panic: mutes main, freezes all automatic jobs + scene recall +
  calibration. Tap again to release.
- **Claude advisor** (if enabled) posts short suggestions in its card. They are *advice*,
  never actions.

---

## 7. After the show

- Every decision is in **`sessions.db`** (SQLite), tagged with `--venue`. Over multiple
  shows at the same room this builds venue history (the basis for venue learning).
- `--session-db off` disables logging (and venue learning, which needs the log); `--session-db path/to/file.db` (Windows: `path\to\file.db`) redirects it.

---

## 8. Rehearse with no hardware (`--emulate`)

Practice the exact launch + dashboard with zero risk:
```bash
$ ./TrioMixAssistant --emulate --lan --pin 123456 --https
```
```powershell
PS> .\TrioMixAssistant.exe --emulate --lan --pin 123456 --https
```
This runs the **full real stack** (OSC over localhost) against a built‑in
protocol‑faithful desk emulator + a timed audio feed: meters stream, feedback gets
caught, and faders reconcile, with the same dashboard and the same muscle memory. (It
validates mechanics, not your firmware's exact formats; that's still §2.4.)

---

## 9. Command reference

| Flag | Meaning |
|---|---|
| `--hardware` | drive a real M32C over OSC |
| `--emulate` | full stack against the built‑in desk emulator (no gear) |
| `--console-ip <ip>` | the M32C's IP (hardware mode) |
| `--audio-device <n>` | input device index/name for the listening half |
| `--output-device <name>` | output device (name, or index) the calibration pink noise plays to; point it at the PA |
| `--auto` | auto-detect the best input device, size the channel map to it, auto-set input gain |
| `--input-gain <dB>` | digital input boost for a quiet mic/interface (try 20–40) |
| `--channel-map "1:0,…"` | explicit console-channel:device-column map (console 1-based, column 0-based); default N→N−1 |
| `--list-devices` | print input devices (with host API) and exit |
| `--diagnose` | run the built-in checks (§1.1), print the report and exit; read-only |
| `--vet` | run the full test (§1.2) against the built-in emulator, print the report, write a log and exit |
| `--vet-channel <N>` | with `--vet --hardware`: change, read back and put back the fader, mute, polarity, EQ and one FX send of console channel N. PA off |
| `--vet-gain` | with `--vet-channel`: also that channel's preamp gain |
| `--vet-main` | with `--vet --hardware`: also the main mute, main fader, one main-bus EQ band and one FX return. PA off |
| `--vet-sound` | with `--vet --audio-device`: play pink noise for 10 seconds and check the measurement input hears it |
| `--vet-phone` | with `--vet --lan --pin`: wait up to two minutes for a phone or tablet to sign in |
| `--rehearse` | on its own or with `--diagnose`: use `show.conf` in emulate mode whatever `MODE` says (the emulated console, with its built-in audio feed unless `AUTO=yes`; the hardware-only keys such as `AUDIO_DEVICE` are not used) |
| `--trace-osc` | with `--emulate`, print every OSC address a mixer app asks the emulated desk for |
| `--template <file.json>` | per‑song scenes + reference levels, **and an optional channel map** (e.g. `pilot_13_input.json`, a 13-input rig plus a measurement mic and a stage mic, so a 15-input device, in the `templates` folder beside `show.conf`; give the full path); else the built‑in 8‑ch trio |
| `--ableset-port <p>` | listen for AbleSet song/section OSC → auto scene recall |
| `--ableset-from <ip>` | accept AbleSet messages only from this address (default: the first computer that sends them) |
| `--no-show-clock` | disable the simulated show clock (simulation and `--emulate`) |
| `--venue "<name>"` | tag the session log **and load/learn this venue's model** (recurring feedback freqs pre‑seed the watch‑list; the model updates after each run with that venue name, simulation and rehearse runs included) |
| `--session-db <path｜off>` | session‑log location, or disable |
| `--advisor` | enable the Claude advisory layer (needs `ANTHROPIC_API_KEY`) |
| `--advisor-interval <s>` | seconds between advisor checks (default 30) |
| `--lan` | bind to the LAN so tablets can connect |
| `--https` | serve TLS (self‑signed) for PWA install + Wake Lock |
| `--pin "<code>"` | require this PIN (at least 6 characters) to open the dashboard + control the console; pair with `--https`. Required with `--lan` unless `--insecure-open` is given. `PIN=` in `show.conf` |
| `--insecure-open` | allow the dashboard on the network with no PIN (anyone on the network can control the console); `ALLOW_OPEN=yes` in `show.conf` |
| `--trust` | serve a cert signed by a local root CA (implies `--https`). Install the printed root once per device → a fully‑trusted, **warning‑free** https connection |
| `--host <ip>` / `--port <n>` | bind address / port (default 8770) |

Default (no flags) = the setup in `show.conf`: **simulation** on `http://127.0.0.1:8770/` as
shipped (`LAN=no`; `HTTPS=yes` takes effect once `LAN=yes`). Started with any
flag other than `--diagnose`, `--list-devices` or `--rehearse` (your `show.conf` in emulate mode), the app ignores `show.conf`.

---

## 10. Troubleshooting

The dashboard names most of these in an alert; this table gives the fix.

| Symptom (banner / message) | Likely cause → fix |
|---|---|
| **"no console feed … check the console IP, network, and firewall"** | Wrong `--console-ip`, console on a different subnet, or firewall blocking UDP. Ping the console; allow the app through the firewall (§2.3); confirm `/xremote` with a sniffer. Recovers automatically when the feed returns. |
| **"inputs are silent" / footer chip = SILENT** | On macOS, check the Microphone permission first (System Settings → Privacy & Security → Microphone → enable Terminal). Also: input gain too low, wrong device, or input muted at the desk. |
| **"audio capture stopped — the assistant is deaf" / chip = DEAD** | Interface unplugged or driver wedged. Re‑connect it; the app **auto‑retries every 3 s** and clears the alert ("audio capture recovered"). |
| **"audio … dropping samples (xruns)" / chip = XRUN** | Device buffer too small / CPU contention. Raise the interface buffer size; close other audio apps. |
| **"audio capture off — … has N input channel(s) but this setup needs M"** | The selected device has too few inputs. Pick a fuller interface, or make a macOS Aggregate Device (§2.2). |
| **"audio capture off — could not open audio device … It may be in use by another app, or not support 48000 Hz"** | Another app (a DAW) holds the device, or the device is not set to 48000 Hz. Close the other app, set the device to 48000 Hz, or pick a different device. |
| **"Could not open the dashboard on port 8770"** | A second copy is already running. Stop it, or use a different port (`--port`, or `PORT=` in `show.conf`). |
| **"meter port busy" / "Desk emulator could not bind…"** | Two copies running. Stop the other instance. |
| **"calibration heard only … dBFS at the mic … the test tone could not be played"** | No/locked **output** device for the pink noise. Check the PA feed/output selection. |
| **Tablet can't open the page** | Not launched with `--lan`; firewall blocking inbound; different Wi‑Fi/VLAN; AP "client isolation" on. Use the exact printed URL/QR. |
| **HTTPS cert warning on tablet** | Expected with self‑signed. Tap **Advanced → proceed**, then Add to Home Screen. **To remove the warning entirely,** launch with `--trust`: it prints steps to install a local root CA once per device (`…/ca.pem`), after which https is fully trusted (no warning). If a browser won't let you proceed *and* you're not using `--trust`, delete the `.certs` folder beside `show.conf` and relaunch to make a fresh certificate. Always open via the exact **IP** URL the app prints. |
| **Fader jumps / wrong EQ band on the real desk** | OSC scaling mismatch for your firmware → `HARDWARE_BRINGUP.md` §1; the constant is in `ts/src/core/console.ts` (changing it needs the source; please report it in an issue). |
| **Wrong meter moves when you play an input** | Channel‑map mismatch. The dashboard's Decision log shows `listening on '<device>' (N ch)`; verify the patch order and the channel map (`--channel-map`, §9). |
| **`node` not found** | Only when running from source or the Node.js folder package: install Node.js 22.13+ from nodejs.org, then open a new terminal. The downloaded app does not need it. |
| **Not sure what is wrong** | Run the checks: **Settings → Run checks**, or `--diagnose` in a terminal (§1.1). Each failed line comes with its fix. |
| **"live audio input needs the optional native audio module 'naudiodon2'"** | Only when running from source or the Node.js folder package. From source, run `npm install` with a C++ compiler present. In the folder package, use the downloaded app instead (it carries the module). Or run without `--audio-device`. |
| **Audio device index changed between shows** | Indexes shift when devices are added/removed. The dashboard's Decision log shows the resolved name. On a Mac, put the device **name** in `show.conf` instead of the number. On Windows a name picks the first entry with that name, which is not the WASAPI one, so keep the WASAPI number and check it with `--list-devices` before each show. |

---

*The console is the source of truth; the app only listens & nudges within hard
guardrails; a human can always take over.*
