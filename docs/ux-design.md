# UX Design: Operating with Mixing Station (no X32‑Edit)

> **Status:** design. Sections 1 to 3 and 6 describe the intended experience. The production launch-banner line, the firewall check, the `--model` flag, the runbook's mixer-app step and the Q-app story (section 4) and the Signal job (section 5) are proposals and are not built. Section 7 lists status.
> **Scope:** the operator/performer experience across all three modes (simulation,
> emulation, production) with **Mixing Station** as the manual mixer surface and the
> **dashboard PWA** as the assistant surface. X32-Edit also works as a
> fallback editor.

---

## 1. Principles

1. **The console is the meeting point.** The assistant, Mixing Station, and the desk
   never talk to each other. Every app talks OSC to the console (or the emulator
   impersonating one), and the console pushes every change to every client. No app
   is ever a dependency of another.
2. **Two surfaces, two roles.** *Mixing Station is the hands*: a full, familiar,
   professional mixer. *The dashboard is the brain's voice*: what the assistant is
   doing, why, and the controls that govern **it** (jobs, coach, takeover,
   calibration), not the mix.
3. **The assistant must be legible from inside any mixer surface.** An operator
   staring at Mixing Station should be able to attribute a moving fader or a new EQ
   band to the assistant *without switching apps* (see §5, console‑native signaling).
4. **A human touch always wins, instantly.** Per‑channel yield on any manual move;
   global TAKEOVER always one tap away on the dashboard.
5. **Rehearsal ≡ show.** Same apps, same layout, same muscle memory in the living
   room as at the gig. The only thing that changes is the IP Mixing Station points
   at: the console (show) or the laptop running `--emulate --lan` with a PIN (rehearsal).

## 2. The surfaces

| Surface | Runs on | Role | Talks to |
|---|---|---|---|
| **Dashboard PWA** | any browser (FOH laptop, iPad, phone) | assistant status, decision log, job toggles, COACH, TAKEOVER, calibration, scenes, EQ/FX fallback views | the app (`https://laptop:8770`) |
| **Mixing Station** | operator's iPad/Android/desktop | full manual mixing surface | the console (show) / the emulator (rehearsal) |
| **M32‑Q / X32‑Q** *(optional)* | musicians' phones | each performer's **own monitor mix** only | the console |
| Console / EmulatedDesk | M32C / the laptop | source of truth | n/a |

Notes:
- The dashboard keeps its lightweight fader/EQ/FX controls as a **fallback manual
  surface** for the no‑Mixing‑Station user (solo band, borrowed phone). It is not
  the pro surface and does not try to be.
- The Q apps fit naturally: the assistant deliberately never touches monitor bus
  sends' per‑musician balance, so performers self‑serving wedge/IEM mixes from
  their phones cannot fight the automation.

## 3. Journeys

### J1: No operator (the core "no engineer" gig)
Pad (or a phone) on a mic stand at the edge of the stage, **dashboard PWA
full‑screen**. Mixing Station may not be installed at all.

- Glanceable from meters away: the status pill (AUTO / ALERT / COACH / MANUAL, or CALIBRATING during a calibration run)
  and the 4‑level notification ladder (silent → log → banner → acknowledge
  overlay) carry the whole story.
- Anything the band must do mid‑set is one tap: TAKEOVER, a scene, a guest mute.
- **Design rule:** every state the assistant can be in must be distinguishable at
  2 m distance from the pill + banner alone.

### J2: Operator, safety‑net mode (assistant acts)
Operator mixes in **Mixing Station**; the assistant handles feedback/clip (and
whatever jobs are enabled) underneath.

- **Layout, one pad:** iPad Split View with Mixing Station ~2/3 and dashboard ~1/3
  (the PWA's mobile layout already fits a narrow column).
- **Layout, two devices (preferred):** pad = Mixing Station full‑screen;
  phone = dashboard, propped next to it or in a pocket with banners on.
- Assistant moves appear **live inside Mixing Station** (the desk echoes them to
  all clients): faders glide, EQ bands appear. Attribution comes from the decision
  log and from console‑native signaling (§5).
- When the operator grabs any fader, the assistant yields that channel (existing
  reconciliation). The more hands‑on the operator, the more the assistant recedes
  toward pure feedback/clip protection. That is the intended posture, not a bug.

### J3: Coach mode (assistant advises, operator acts)
The inverted experience, and the pairing that shows both apps at their best.

- Split view: **coach cards on one side, Mixing Station on the other.**
- Card lifecycle (existing engine behavior, now a UX contract):
  1. problem detected → card appears about 100 ms later, freshest‑first;
  2. card text **updates in place** if the problem evolves (no duplicates);
  3. operator dials the move into Mixing Station;
  4. detector stops firing → card **self‑clears after ~8 s**. The card
     disappearing *is* the confirmation.
  5. `persist` cards (room‑calibration EQ, for example) stay until their cause clears or coach is toggled off.
- **Design rule:** a card must name the move in console vocabulary (channel,
  band, Hz, dB, Q) exactly as Mixing Station labels it, so the operator never
  translates.

### J4: Rehearsal (emulation)
Identical to J2/J3 with one substitution: the laptop runs `--emulate --lan` (with a PIN) and Mixing
Station connects to the **laptop's IP**.

- The emulator answers the discovery broadcast, so Mixing Station's console picker
  shows **“MixAssist”**: connecting is a tap, not an IP form.
- A USB mic makes feedback/calibration rehearsal real; without one, the emulator's timed audio feed
  still drives the full coach/override loop.
- **Design rule:** zero rehearsal‑only UI. If rehearsal needs a different habit
  than the show, the design is wrong.

## 4. Onboarding & connection UX

*Partly built: with `--emulate` the app already prints the mixer-app line; the production line and the firewall check are not built.* Startup prints/QRs the dashboard URL. Extend the launch banner to tell
the whole two‑surface story in one glance:

```
  Dashboard   →  https://192.168.1.20:8770        [QR]
  Mixer app   →  connect Mixing Station to 192.168.1.42 (console)     ← production
  Mixer app   →  connect Mixing Station to 192.168.1.20 “MixAssist”   ← --emulate
```

- `--emulate --lan` should check for the macOS incoming-connections permission and the
  **Windows Firewall rule** for UDP 10023 (a pad on Wi-Fi needs it).
- A `--model X32|M32` identity flag selects the family string the emulator reports,
  so M32‑Edit and the Q apps connect without config edits.
- RUNBOOK gains a “Connect your mixer app” step mirroring the tablet‑PWA step.

## 5. Console‑native signaling *(new, optional job: “Signal”)*

*Proposal, not built.*

**Problem:** inside Mixing Station, an assistant move is anonymous: a fader glides
and the operator can't tell assistant from ghost without looking at the dashboard.

**Design:** the assistant annotates **through the console itself**, using standard
scribble‑strip OSC (`/ch/NN/config/color`, `/ch/NN/config/name`) that every
surface (Mixing Station, the Q apps, X32‑Edit, the physical desk) already renders:

- **Acting:** while a correction is parked on a channel (feedback notch, clip trim),
  its strip color flips to **red**; restored when the correction is released.
- **Coach:** the channel with a pending card gets a name suffix (`Vox ◄`), pulling
  the operator's eyes to the right strip in Mixing Station; removed when the card
  clears.

Guardrails (non‑negotiable):
- Original name/color captured before any change and **always restored**: on
  clear, on job toggle‑off, on TAKEOVER, and on app exit.
- Never more than a suffix; never rename a strip outright.
- Off by default in production until proven at a rehearsal (`SIGNAL=yes` /
  dashboard toggle); on by default in `--emulate`.

## 6. Failure & edge UX

| Failure | Experience |
|---|---|
| Mixing Station loses Wi‑Fi | Nothing changes for the assistant or the show (independent paths to the console). Operator reconnects at leisure. |
| Dashboard tab dies / phone sleeps | Assistant keeps mixing (it is headless by design); the PWA reconnects via WS→SSE fallback on reopen. Wake Lock (`--https`) prevents the sleep case on the dedicated pad. |
| Laptop dies mid‑show | Assistant gone; console untouched and last‑written; operator still has full manual control in Mixing Station. Degradation is graceful *by architecture*. |
| Operator and assistant touch the same channel | Human wins; assistant yields that channel briefly (existing reconciliation), then resumes guardrail duty. |
| Both surfaces on one pad | iPad Split View keeps both live. If the OS suspends the PWA half, banners are missed but nothing breaks. Recommend the two‑device layout for shows. |

## 7. Status of the work

Done:

- **Emulator fidelity with Mixing Station.** Mixing Station discovers the emulated
  desk as *MixAssist*, syncs it, reads the scene list and shows live meters
  (checked 2026-07-03; see `app/HARDWARE_BRINGUP.md`). `--trace-osc` prints every
  address a mixer app asks for.
- **Docs.** The README is written around Mixing Station, with X32-Edit and
  M32-Edit as other editors.

Not built:

1. **Identity flag**: `--model X32|M32`, so M32-Edit and the Q apps connect
   without config edits.
2. **Launch banner**: the production (console IP) mixer-app line, and a firewall
   check on `--emulate --lan`. The `--emulate` mixer-app line is printed today.
3. **Runbook step**: a short step on connecting the mixer app, beside the
   phone and tablet step.
4. **Signal job**: scribble-strip color and name annotation with the section 5
   guardrails. The color values need checking against console firmware.
5. **Q-app story**: document performer self-serve monitor mixes, and confirm the
   Q handshake against the emulator.
