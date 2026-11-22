
interface JobDef { key: string; name: string; tier: string; cls: string; icon: string; desc: string; }
const JOBS: JobDef[] = [
  {key:"feedback",   name:"Feedback notch",  tier:"reflex",   cls:"reflex", icon:"ic-feedback", desc:"Catch a rising, stable ring → park a narrow EQ cut."},
  {key:"clip",       name:"Clip protection", tier:"reflex",   cls:"reflex", icon:"ic-clip",     desc:"Peak near full scale → trim the preamp a touch."},
  {key:"vocal_ride", name:"Vocal ride",      tier:"advisory", cls:"adv",    icon:"ic-vocal",    desc:"Hold the lead vocal at its loudness target."},
  {key:"balance",    name:"Balance hold",    tier:"advisory", cls:"adv",    icon:"ic-balance",  desc:"Keep bass/keys from wandering off a stored balance."},
  {key:"phase",      name:"Phase / polarity",tier:"advisory", cls:"adv",    icon:"ic-balance",  desc:"Paired mics out of polarity → auto-flip (or advise); flag comb filtering. Needs phase pairs."},
  {key:"unmask",     name:"Vocal unmask",    tier:"advisory", cls:"adv",    icon:"ic-vocal",    desc:"When the vocal is up, duck instruments' ~3 kHz a few dB so it cuts through; release when it pauses."},
];
const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector<T>(s)!;
const ESCAPES: Record<string, string> = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);
const rendered = new WeakMap<Element, string>();
function setHTML(el: Element, html: string): boolean {
  if(rendered.get(el) === html) return false;
  rendered.set(el, html);
  el.innerHTML = html;
  return true;
}
const dbPct = (db: number): number => Math.max(0, Math.min(100, (db + 60) / 60 * 100));
const zone = (db: number): string => db >= -3 ? 'red' : (db >= -12 ? 'yel' : 'grn');
const nf = (v: unknown, d = 0): number => Number.isFinite(v) ? v as number : d;

interface ChEls {
  root: HTMLElement; fill: HTMLElement; peak: HTMLElement; db: HTMLElement; fb: HTMLElement;
  led: HTMLElement; fbtxt: HTMLElement; chips: HTMLElement; fader: HTMLElement; gain: HTMLElement;
}
const jobEls: Record<string, HTMLElement> = {}, chEls: Record<number, ChEls> = {};
function buildJobs(): void {
  const root = $("#jobs"); root.innerHTML = "";
  for(const j of JOBS){
    const el = document.createElement("div");
    el.className = `job ${j.cls}`;
    el.innerHTML = `<div class="jtop"><svg class="jic"><use href="#${j.icon}"/></svg><h3>${j.name}</h3><span class="tier">${j.tier}</span><div class="sw"></div></div>
                    <div class="desc">${j.desc}</div>`;
    el.onclick = () => action({type:"toggle", job:j.key, on:!el.classList.contains("on")});
    root.appendChild(el); jobEls[j.key] = el;
  }
}
function buildChannels(chs: ChannelT[]): void {
  const root = $("#chans"); root.innerHTML = "";
  for(const c of chs){
    const el = document.createElement("div");
    el.className = "ch" + (c.is_meas?" meas":"") + (c.is_lead?" lead":"");
    let tags = "";
    if(c.is_lead) tags += `<span class="tag lead">lead</span>`;
    if(c.is_meas) tags += `<span class="tag room">room truth</span><span class="tag nomix">no mix</span>`;
    if(c.is_balance) tags += `<span class="tag bal">balance</span>`;
    el.innerHTML = `
      <div class="chtop"><span class="num mono">${esc(c.ch)}</span><span class="name">${esc(c.label)}</span><span class="tags">${tags}</span></div>
      <div class="meterrow">
        <div class="meter"><span class="tick" style="left:33%"></span><span class="tick" style="left:66%"></span><span class="tick" style="left:90%"></span><span class="fill"></span><span class="peak"></span></div>
        <span class="db mono">—</span>
      </div>
      <div class="chbot">
        <span class="fb"><span class="led"></span><span class="fbtxt">clear</span></span>
        <span class="chips"></span>
        <span class="rd"><span><b class="fader">0.0</b> fdr</span><span><b class="gain">20</b> gain</span></span>
      </div>`;
    root.appendChild(el);
    const q = (sel: string) => el.querySelector<HTMLElement>(sel)!;
    chEls[c.ch] = {root:el, fill:q(".fill"), peak:q(".peak"),
      db:q(".db"), fb:q(".fb"), led:q(".led"),
      fbtxt:q(".fbtxt"), chips:q(".chips"),
      fader:q(".fader"), gain:q(".gain")};
  }
}

let built = false;
let curStatus = "live";
let _lastSongScene: number | null = null, _lastSongName: string | null = null;
function renderSong(show: ShowT | undefined): void {
  const bar = $("#songbar");
  if(!show || !show.current){ bar.hidden = true; return; }
  bar.hidden = false;
  $("#songidx").textContent = (show.index!=null) ? ("#" + (show.index+1)) : "";
  $("#songname").textContent = show.current;
  const sec = (show.section && show.section !== "Song") ? show.section : "";
  $("#songsec").textContent = sec ? ("· " + sec) : "";
  $("#songnext").textContent = show.next || "—";
  const chip = $("#scenechip");
  if(show.scene!=null){
    chip.hidden = false;
    $("#scenenum").textContent = String(show.scene);
    if(show.scene !== _lastSongScene || show.current !== _lastSongName){
      chip.classList.remove("flash"); void chip.offsetWidth; chip.classList.add("flash");
    }
  } else { chip.hidden = true; }
  $("#clocksrc").textContent = show.playing ? "show clock · playing" : "show clock";
  _lastSongScene = show.scene; _lastSongName = show.current;
}
let _bannerDismissed = "";
function renderBanner(alerts: AlertT[] | undefined): void {
  const bn = $("#banner");
  const top = (alerts||[]).filter(a => a.level==="warn")[0];
  if(!top){ bn.hidden = true; _bannerDismissed = ""; return; }
  const key = "warn|" + top.msg;
  if(_bannerDismissed === key){ bn.hidden = true; return; }
  bn.hidden = false;
  bn.className = "banner warn";
  $("#bannermsg").textContent = top.msg;
  bn.dataset.key = key;
}
$("#bannerx").onclick = () => { _bannerDismissed = $("#banner").dataset.key || ""; $("#banner").hidden = true; };
let _critAcked = "";
function renderOverlay(alerts: AlertT[] | undefined): void {
  const ov = $("#critoverlay");
  const top = (alerts||[]).filter(a => a.level==="critical")[0];
  if(!top){ ov.hidden = true; _critAcked = ""; return; }
  if(_critAcked === top.msg){ ov.hidden = true; return; }
  ov.hidden = false;
  $("#critmsg").textContent = top.msg;
  ov.dataset.key = top.msg;
}
$("#critack").onclick = () => { _critAcked = $("#critoverlay").dataset.key || ""; $("#critoverlay").hidden = true; };
function renderScenes(scenes: SceneT[] | undefined): void {
  const panel = $("#scenepanel"), wrap = $("#scenes");
  if(!scenes || !scenes.length){ panel.hidden = true; return; }
  panel.hidden = false;
  const html = scenes.map(sc =>
    `<button class="scenebtn ${sc.current?'current':''}" data-scene="${esc(sc.index)}">`
    + `<span class="sc">SCENE ${esc(sc.index)}${sc.current?' · NOW':''}</span>`
    + `<span class="sn">${esc(sc.name)}</span></button>`).join("");
  if(!setHTML(wrap, html)) return;
  for(const b of wrap.querySelectorAll<HTMLElement>(".scenebtn")){
    b.onclick = () => action({type:"scene", index:+b.dataset.scene!});
  }
}
function renderAdvisor(advice: AdviceT | null | undefined, on: boolean | undefined): void {
  const panel = $("#advisorpanel"), box = $("#advice");
  if(!on && !advice){ panel.hidden = true; return; }
  panel.hidden = false;
  if(!advice || (!advice.prompt && !advice.assessment)){
    box.className = "advice";
    setHTML(box, `<span class="empty">Listening… an advisory note will appear here.</span>`);
    return;
  }
  box.className = "advice sev-" + esc(advice.severity||"info");
  let h = "";
  if(advice.prompt)     h += `<div class="prompt">${esc(advice.prompt)}</div>`;
  if(advice.assessment) h += `<div class="assess">${esc(advice.assessment)}</div>`;
  h += `<div class="ameta">${esc(advice.time||"")} · Claude suggestion — not an automatic action</div>`;
  setHTML(box, h);
}
let _lastState: Snapshot | null = null, activeTab = "mix", eqCh: number | null = null, eqDirty = true, fxDirty = true;
const TABS = ["mix","eq","fx","settings"];
function selectTab(name: string | undefined, push: boolean): void {
  if(!name || !TABS.includes(name)) name = "mix";
  activeTab = name;
  for(const x of document.querySelectorAll<HTMLElement>(".tab")) x.classList.toggle("on", x.dataset.tab===name);
  for(const p of document.querySelectorAll<HTMLElement>(".tabpanel")) p.hidden = (p.id !== "tab-"+name);
  eqDirty = fxDirty = true;
  if(_lastState) renderTabPanels(_lastState);
  if(push && location.hash !== "#"+name){ history.replaceState(null, "", "#"+name); }
}
for(const t of document.querySelectorAll<HTMLElement>(".tab")){
  t.onclick = () => selectTab(t.dataset.tab, true);
}
function applyHashTab(): void { const h=(location.hash||"").slice(1); if(TABS.includes(h)) selectTab(h, false); }
window.addEventListener("hashchange", applyHashTab);
const fEQs = (p: number): number => 20*Math.pow(10, 3*p);
const fEQinv = (f: number): number => Math.log10(Math.max(20,Math.min(20000,f))/20)/3;
const hzLbl = (f: number): string => f<1000 ? f.toFixed(0) : (f/1000).toFixed(1)+"k";
function chMeta(s: Snapshot, ch: number): Partial<ChannelT> { return (s.channels||[]).find(c=>c.ch===ch) || {}; }
function renderEQ(s: Snapshot): void {
  const chans = (s.channels||[]).filter(c=>c.in_mix).map(c=>c.ch);
  if(!chans.length) return;
  if(eqCh==null || !chans.includes(eqCh)) eqCh = chans[0];
  const cur: number = eqCh;
  $("#eqchsel").innerHTML = chans.map(ch=>
    `<span class="chip ${ch===eqCh?'on':''}" data-ch="${esc(ch)}">${esc(chMeta(s,ch).label||('ch'+ch))}</span>`).join("");
  for(const c of $("#eqchsel").querySelectorAll<HTMLElement>(".chip"))
    c.onclick = () => { eqCh = +c.dataset.ch!; eqDirty = true; renderTabPanels(_lastState!); };
  const bands = (s.eq && s.eq[cur]) || [];
  $("#eqbands").innerHTML = bands.map(b=>`
    <div class="eqband" data-band="${esc(b.band)}">
      <h4>BAND ${esc(b.band)}<span class="togg ${b.on?'on':''}" data-act="on">${b.on?'ON':'OFF'}</span></h4>
      <div class="eqrow"><span>Freq</span><input type="range" min="0" max="1" step="0.001" value="${esc(fEQinv(b.hz))}" data-act="hz"><b>${esc(hzLbl(b.hz))}</b></div>
      <div class="eqrow"><span>Gain</span><input type="range" min="-15" max="15" step="0.5" value="${esc(b.gain)}" data-act="gain"><b>${b.gain>0?'+':''}${esc(b.gain.toFixed(1))}</b></div>
      <div class="eqrow"><span>Q</span><input type="range" min="0.3" max="10" step="0.1" value="${esc(b.q)}" data-act="q"><b>${esc(b.q.toFixed(1))}</b></div>
    </div>`).join("");
  for(const card of $("#eqbands").querySelectorAll<HTMLElement>(".eqband")){
    const band = +card.dataset.band!;
    for(const inp of card.querySelectorAll<HTMLInputElement>("input")) inp.onchange = () => {
      const act = inp.dataset.act as "hz" | "gain" | "q", val = act==="hz" ? fEQs(+inp.value) : +inp.value;
      action({type:"eq", ch:eqCh!, band, [act]:val, on:true}); eqDirty = true;
    };
    const tg = card.querySelector<HTMLElement>(".togg")!;
    tg.onclick = () => { action({type:"eq", ch:eqCh!, band, on:!tg.classList.contains("on")}); eqDirty = true; };
  }
  const nf = chMeta(s,cur).notch_freqs||[];
  $("#eqnote").textContent = nf.length
    ? `⚠ ${nf.length} automatic feedback notch(es) active on this channel (shown dashed) — the assistant manages 1–2 of these 4 bands; your edits and its notches share them.`
    : "";
  drawEQ(bands, nf);
}
function drawEQ(bands: EqBandT[], notches: number[]): void {
  const W=600,H=160; let pts="";
  for(let i=0;i<=120;i++){
    const p=i/120, f=fEQs(p); let db=0;
    for(const b of bands) if(b.on){ const o=Math.log2(f/b.hz); db += b.gain*Math.exp(-0.5*Math.pow(o*b.q*0.7,2)); }
    pts += `${(p*W).toFixed(1)},${(H/2-(db/15)*(H/2-6)).toFixed(1)} `;
  }
  let m=""; for(const nf of notches){ const x=(fEQinv(nf)*W).toFixed(1); m+=`<line class="notch" x1="${x}" y1="0" x2="${x}" y2="${H}"/>`; }
  $("#eqcurve").innerHTML = `<line class="grid0" x1="0" y1="${H/2}" x2="${W}" y2="${H/2}"/>${m}<polyline class="resp" points="${pts.trim()}"/>`;
}
function renderFX(s: Snapshot): void {
  const buses = (s.fx&&s.fx.buses)||{}, chans=(s.channels||[]).filter(c=>c.in_mix);
  $("#fxwrap").innerHTML = Object.keys(buses).map(fx=>{
    const wet=(s.fx.wet||{})[fx]; const wv=(wet==null?-90:wet);
    const sends = chans.map(c=>{
      const lvl=((s.sends||{})[c.ch]||{})[fx]; const v=(lvl==null?-90:lvl);
      return `<div class="fxsend" data-ch="${esc(c.ch)}" data-fx="${esc(fx)}"><span>${esc(c.label)}</span><input type="range" min="-90" max="10" step="1" value="${esc(v)}"><b>${v<=-90?'-∞':esc(v.toFixed(0))}</b></div>`;
    }).join("");
    return `<div class="fxbus"><h3>${esc(buses[fx])}</h3>
      <div class="fxwet" data-fx="${esc(fx)}"><span>WET</span><input type="range" min="-90" max="10" step="1" value="${esc(wv)}"><b>${wv<=-90?'-∞':esc(wv.toFixed(0))}</b></div>${sends}</div>`;
  }).join("");
  for(const w of $("#fxwrap").querySelectorAll<HTMLElement>(".fxwet")){ const fx=+w.dataset.fx!;
    w.querySelector("input")!.onchange=e=>{ action({type:"fx",fx,db:+(e.target as HTMLInputElement).value}); fxDirty=true; }; }
  for(const r of $("#fxwrap").querySelectorAll<HTMLElement>(".fxsend")){ const ch=+r.dataset.ch!, fx=+r.dataset.fx!;
    r.querySelector("input")!.onchange=e=>{ action({type:"send",ch,fx,db:+(e.target as HTMLInputElement).value}); fxDirty=true; }; }
}
function renderSettings(s: Snapshot): void {
  const cap: Partial<CaptureT>=s.capture||{}, con: Partial<Snapshot["console"]>=s.console||{},
    lat: Snapshot["latency"]=s.latency||{}, room: Partial<Snapshot["room"]>=s.room||{}, show: Partial<ShowT>=s.show||{};
  const row=(k: string, v: string | number, cls?: string)=>`<div class="row"><span class="k">${esc(k)}</span><span class="v ${cls||''}">${esc(v)}</span></div>`;
  const audio = cap.kind==="audio" ? ((cap.name||"audio")+" — "+(cap.dead?"DEAD":cap.silent?"SILENT":cap.overload?"XRUN":"ok")) : String(cap.kind);
  setHTML($("#setconn"), row("Mode", s.mode||"") +
    row("Audio input", audio, (cap.dead||cap.silent)?"bad":"ok") +
    row("Console feed", con.connected?("connected · "+con.meters+" meters"):"no feed", con.connected?"ok":"bad"));
  const latTxt = Object.keys(lat).length ? Object.entries(lat).map(([k,v])=>k+" "+v.ema+"ms").join(" · ") : "—";
  setHTML($("#setperf"), row("Loop", (s.perf?s.perf.tick_ms:0)+" ms · jit "+(s.perf?s.perf.jitter_ms:0)+" ms") +
    row("Detect→actuate", latTxt) +
    row("Block buffer", (s.block_ms||0)+" ms") +
    row("Room SNR", room.confidence!=null?(Math.round(room.confidence*100)+"% · "+room.level_db+" dBFS"):"—", (room.confidence!=null&&room.confidence<0.5)?"bad":"ok"));
  const ven = s.venue;
  setHTML($("#setshow"), row("Template song", show.current||"—") +
    row("Scene", show.scene!=null?show.scene:"—") +
    row("Calibration", (s.calibration||{}).status||"—") +
    row("Venue model", ven ? (ven.shows+" show(s) · "+Math.round((ven.confidence||0)*100)+"% · "+(ven.freqs||[]).length+" known freqs") : "—"));
}
function renderTabPanels(s: Snapshot): void {
  if(activeTab==="settings") renderSettings(s);
  else if(activeTab==="eq" && eqDirty){ renderEQ(s); eqDirty=false; }
  else if(activeTab==="fx" && fxDirty){ renderFX(s); fxDirty=false; }
}
$("#eqreset").onclick = () => { if(eqCh!=null){ action({type:"eq_reset", ch:eqCh}); eqDirty=true; } };
$("#setcal").onclick = () => action({type:"calibrate"});
function render(s: Snapshot | null | undefined): void {
  if(!s) return;
  _lastState = s;
  if(!built){ buildChannels(s.channels); buildMixer(s.channels); built = true; }

  curStatus = s.status || "live";
  const op = s.op_mode || "auto";
  const st = $("#status");
  st.className = "status " + op;
  $("#statustext").textContent = op.toUpperCase();
  $("#uptime").textContent = (s.uptime||0).toFixed(0) + "s";
  $("#modebadge").textContent = s.mode === "simulation" ? "SIMULATION" : "HARDWARE";
  $("#footmode").textContent = s.mode + (s.main_muted ? " · MAIN MUTED" : "");
  const pf = s.perf; if(pf) $("#footperf").textContent = `loop ${(pf.tick_ms||0).toFixed(1)}ms · jit ${(pf.jitter_ms||0).toFixed(1)}ms`;
  const cap: Partial<CaptureT> = s.capture||{}, fa = $("#footaudio");
  if(cap.kind === "audio"){
    const st = cap.dead ? "DEAD" : cap.silent ? "SILENT" : cap.overload ? "XRUN" : "ok";
    const nm = cap.name ? String(cap.name).slice(0,20) + " " : "";
    fa.textContent = `audio: ${nm}${st}`;
    fa.style.color = (st === "ok") ? "" : "#f5a623";
  } else if(cap.kind === "simulation"){ fa.textContent = "audio: sim"; fa.style.color = ""; }
  else { fa.textContent = "audio: none"; fa.style.color = ""; }
  const tk = $("#takeover");
  tk.classList.toggle("active", curStatus === "takeover");
  $("#tklbl").textContent = curStatus === "takeover" ? "RELEASE" : "TAKEOVER";

  renderSong(s.show);
  renderBanner(s.alerts);
  renderOverlay(s.alerts);
  renderScenes(s.scenes);
  renderAdvisor(s.advisor, s.advisor_on);
  renderTabPanels(s);

  for(const j of JOBS){ jobEls[j.key].classList.toggle("on", !!(s.enabled||{})[j.key]); }
  renderCoach(s.coach);

  for(const c of (s.channels||[])){
    const e = chEls[c.ch]; if(!e) continue;
    const rms = nf(c.rms,-90), peak = nf(c.peak,-90), fdr = nf(c.fader), gn = nf(c.gain,20);
    e.fill.style.width = dbPct(rms) + "%";
    e.fill.className = "fill " + zone(rms);
    e.peak.style.left = dbPct(peak) + "%";
    e.db.textContent = (rms<=-90?"-∞":rms.toFixed(1));
    e.fb.className = "fb " + (c.fb_state==="notched"?"notched":(c.fb_state==="building"?"building":""));
    e.fbtxt.textContent = c.fb_state==="notched"?"notched":(c.fb_state==="building"?"ring building":"clear");
    e.root.classList.toggle("alarm", c.fb_state==="building" || c.clip_recent);
    let chips = "";
    for(const f of (c.notch_freqs||[])) chips += `<span class="chip notch">${esc(f)} Hz cut</span>`;
    if(c.gain_trimmed) chips += `<span class="chip trim">preamp ${esc(gn)} dB</span>`;
    setHTML(e.chips, chips);
    e.fader.textContent = (fdr>=0?"+":"") + fdr.toFixed(1);
    e.gain.textContent = gn.toFixed(0);
  }

  for(const c of (s.channels||[])){
    const st = stripEls[c.ch]; if(!st) continue;
    const fdr = nf(c.fader), rms = nf(c.rms,-90);
    muteOn[c.ch] = !!c.muted;
    if(!dragging.has(c.ch)){ st.cap.style.bottom = capBottom(fdr)+"px"; st.vdb.textContent = (fdr>=0?"+":"")+fdr.toFixed(1); }
    st.fill.style.height = meterV(rms)+"%"; st.fill.className = "vfill " + zone(rms);
    st.el.classList.toggle("muted", !!c.muted);
    st.el.classList.toggle("held", !!c.manual_hold);
    if(st.mute) st.mute.classList.toggle("on", !!c.muted);
  }
  if(masterEl && s.master){
    const mdb = nf(s.master.fader);
    if(!dragging.has("master")){ masterEl.cap.style.bottom = capBottom(mdb)+"px"; masterEl.vdb.textContent = (mdb>=0?"+":"")+mdb.toFixed(1); }
    masterEl.el.classList.toggle("muted", !!s.main_muted);
  }

  const cal: Partial<Snapshot["calibration"]> = s.calibration||{};
  const calbtn = $<HTMLButtonElement>("#calbtn"), cs = cal.status;
  calbtn.disabled = cs === "running";
  $("#callbl").textContent = cs==="running" ? "Calibrating…" : (cs==="done" ? "Re-run calibration" : "Run calibration");
  setHTML($("#calstatus"), cs==="running" ? "Emitting pink noise &amp; measuring the room…" :
    (cs==="done" ? `Room measured · ${ esc((cal.corrections||[]).length) } cut(s) applied` : "Not yet run — using raw detection thresholds."));
  const bands = $("#bands");
  const bl = cal.baseline || [];
  if(bl.length){
    bands.style.display = "flex";
    let bandsHtml = "";
    const ds = bl.map(b=>b.db); const lo = Math.min(...ds)-2, hi = Math.max(...ds)+2;
    const watch = (cal.watchlist||[]).map(w=>w.hz);
    for(const {hz,db} of bl){
      const h = Math.max(6, (db-lo)/(hi-lo)*100);
      const hot = watch.some(w => Math.abs(w-hz)/hz < 0.25);
      const lbl = (hz>=1000) ? (Math.round(hz/100)/10)+"k" : Math.round(hz);
      bandsHtml += `<div class="band"><div class="bar ${hot?'hot':''}" style="height:${esc(h)}%"></div><div class="bl">${esc(lbl)}</div></div>`;
    }
    setHTML(bands, bandsHtml);
  } else bands.style.display = "none";
  let wc = "";
  for(const w of (cal.watchlist||[]).slice(0,4)) wc += `<span class="wchip">▲ ${esc(w.hz)} Hz · +${esc(w.excess)} dB</span>`;
  for(const c of (cal.corrections||[]).slice(0,4)) wc += `<span class="cchip">▼ ${esc(c.hz)} Hz · ${esc(c.cut)} dB</span>`;
  setHTML($("#watchchips"), wc ? `<div class="chips-row">${wc}</div>` : "");

  const L: Partial<Snapshot["lead"]> = s.lead||{};
  $("#leadtgtv").textContent = (L.target!=null?L.target.toFixed(1):"—");
  $("#leadin").textContent = (L.input!=null?L.input.toFixed(1):"—");
  $("#leadoutv").textContent = (L.output!=null?L.output.toFixed(1):"—");
  $("#leadout").style.width = (L.output!=null?dbPct(L.output):0) + "%";
  $("#leadtgt").style.left = (L.target!=null?dbPct(L.target):50) + "%";
  if(!tgtDragging && L.target!=null){ $<HTMLInputElement>("#tgt").value = String(L.target); paintSlider(L.target); lastTarget = L.target; }

  const bt = s.balance_targets||{};
  const btk = Object.keys(bt);
  setHTML($("#baltargets"), btk.length
    ? "Holding: " + btk.map(k=>`<span class="cchip">ch${esc(k)} ${bt[k]>=0?'+':''}${esc(bt[k])}</span>`).join(" ")
    : `<span class="empty">No balance captured yet.</span>`);

  const log = s.log||[];
  setHTML($("#log"), log.length ? log.map(e =>
    `<div class="logrow ${esc(e.kind)} lv-${esc(e.level||'info')}"><span class="t mono">${esc(e.time)}</span><span class="lvdot"></span><span class="k">${esc(e.kind)}</span><span class="m">${esc(e.msg)}</span></div>`
  ).join("") : `<div class="empty">No decisions yet. Toggle jobs or run calibration.</div>`);
}

function renderCoach(coach: Snapshot["coach"] | undefined): void {
  const on = !!(coach && coach.on);
  $("#coach").classList.toggle("on", on);
  const panel = $("#coachpanel"); panel.hidden = !on;
  if(!on) return;
  const recs = (coach && coach.recs) || [];
  setHTML($("#coachrecs"), recs.length
    ? recs.map(r => `<div class="crec ${esc(r.kind)}"><span class="ck">${esc(r.kind)}</span><span class="cm">${esc(r.text)}</span></div>`).join("")
    : `<div class="empty">No moves needed right now — the mix is within targets.</div>`);
}

async function post(path: string, body: Command): Promise<void> {
  try{ const r = await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}); if(r.ok) render(await r.json()); }catch(e){}
}
let ws: WebSocket | null = null, wsReady = false, es: EventSource | null = null, retryT: ReturnType<typeof setTimeout> | null = null;
function setConn(ok: boolean, txt: string): void {
  const c=$("#conn"); c.className="conn "+(ok?"ok":"off"); $("#conntext").textContent=txt;
  if(!ok){
    const ov=$("#critoverlay"); if(ov){ ov.hidden=true; } _critAcked="";
    const bn=$("#banner"); if(bn){ bn.hidden=true; }
  }
}
let badFrames = 0;
function badFrame(e: unknown): void {
  if(badFrames++ === 0) console.warn("dashboard: dropped an unreadable telemetry frame", e);
  $("#conn").title = "ignored " + badFrames + " unreadable frame(s)";
}
function onFrame(data: string): void {
  try{ render(JSON.parse(data)); }catch(e){ badFrame(e); }
}
let sessionCheck = false;
function checkSession(): void {
  if(sessionCheck) return;
  sessionCheck = true;
  fetch("/state").then(r => { if(r.status === 401) location.reload(); }).catch(() => {}).finally(() => { sessionCheck = false; });
}
function action(obj: Command): void {
  if(wsReady && ws){ try{ ws.send(JSON.stringify(obj)); return; }catch(e){} }
  post("/api/command", obj);
}
$("#takeover").onclick = () => action({type:"panic", on: curStatus !== "takeover"});
$("#coach").onclick = () => action({type:"coach", on: !(_lastState && _lastState.coach && _lastState.coach.on)});
$("#calbtn").onclick   = () => action({type:"calibrate"});
$("#balbtn").onclick   = () => action({type:"balance_capture"});
$("#resetbtn").onclick = () => action({type:"reset_notches"});
let tgtDragging = false, lastTarget: number | null = null;
const TMIN = -18, TMAX = 0;
function paintSlider(v: number | string): void {
  v = +v;
  const p = (v - TMIN) / (TMAX - TMIN) * 100;
  $("#tgt").style.setProperty("--p", p + "%");
  const sb = $("#slbubble"); sb.textContent = v.toFixed(1); sb.style.left = p + "%";
}
function setTarget(v: number | string, push: boolean): void {
  v = Math.min(TMAX, Math.max(TMIN, +v));
  $<HTMLInputElement>("#tgt").value = String(v); paintSlider(v);
  if(push && v !== lastTarget){ lastTarget = v; action({type:"lead_target", db:v}); }
}
$("#tgt").addEventListener("input",  e => { tgtDragging = true; $("#slider").classList.add("drag"); paintSlider((e.target as HTMLInputElement).value); });
$("#tgt").addEventListener("change", e => { tgtDragging = false; $("#slider").classList.remove("drag"); setTarget((e.target as HTMLInputElement).value, true); });
$("#tgtdn").onclick = () => setTarget((+$<HTMLInputElement>("#tgt").value) - 0.5, true);
$("#tgtup").onclick = () => setTarget((+$<HTMLInputElement>("#tgt").value) + 0.5, true);

function addRipple(e: PointerEvent): void {
  const b = e.currentTarget as HTMLButtonElement;
  if(b.disabled) return;
  const r = document.createElement("span"); r.className = "ripple";
  const rect = b.getBoundingClientRect(), d = Math.max(rect.width, rect.height);
  r.style.width = r.style.height = d + "px";
  r.style.left = ((e.clientX ?? rect.left + rect.width/2) - rect.left - d/2) + "px";
  r.style.top  = ((e.clientY ?? rect.top + rect.height/2) - rect.top - d/2) + "px";
  b.appendChild(r); setTimeout(() => r.remove(), 600);
}
document.querySelectorAll<HTMLElement>(".btn,.step,.takeover-btn").forEach(b => b.addEventListener("pointerdown", addRipple));
paintSlider($<HTMLInputElement>("#tgt").value);

type StripKey = number | "master";
interface Strip { el: HTMLElement; cap: HTMLElement; fill: HTMLElement; vdb: HTMLElement; mute: HTMLElement | null; }
const SHORT: Record<string, string> = {lead_vox:"VOX1",harm_vox_l:"VOX2",harm_vox_r:"VOX3",acoustic_gtr:"GTR",bass_di:"BASS",cajon:"CAJ",keys_aux:"KEYS"};
const FUI_MIN = -60, FUI_MAX = 10, FH = 200, CAPH = 32;
const stripEls: Record<number, Strip> = {}; const muteOn: Record<number, boolean> = {}; const dragging = new Set<StripKey>(); let masterEl: Strip | null = null;
const clampF = (v: number): number => Math.max(FUI_MIN, Math.min(FUI_MAX, v));
function capBottom(db: number): number { return (clampF(db)-FUI_MIN)/(FUI_MAX-FUI_MIN)*(FH-CAPH); }
function meterV(db: number): number { return Math.max(0, Math.min(100, (db+60)/60*100)); }
function yToDb(vf: HTMLElement, clientY: number): number { const r=vf.getBoundingClientRect(); let t=(clientY-r.top-CAPH/2)/(r.height-CAPH); t=Math.max(0,Math.min(1,t)); return Math.round((FUI_MAX - t*(FUI_MAX-FUI_MIN))*2)/2; }
function makeStrip(key: StripKey, label: string, isMaster: boolean): Strip {
  const el = document.createElement("div"); el.className = "strip" + (isMaster?" master":"");
  el.innerHTML = `<div class="slabel">${esc(label)}</div>
    <div class="vfader"><div class="vmeter"><span class="vfill"></span></div><div class="vcap"></div></div>
    <div class="vdb mono">0.0</div>
    ${isMaster ? '<div style="height:30px"></div>' : '<button class="mute">M</button>'}`;
  const q = (sel: string) => el.querySelector<HTMLElement>(sel)!;
  const vf=q(".vfader"), cap=q(".vcap"), fill=q(".vfill"), vdb=q(".vdb"), mute=el.querySelector<HTMLElement>(".mute");
  let lastSend = 0;
  function commit(db: number, force?: boolean): void {
    cap.style.bottom = capBottom(db)+"px"; vdb.textContent = (db>=0?"+":"")+db.toFixed(1);
    const now = performance.now();
    if(force || now-lastSend > 55){ lastSend = now; action(isMaster ? {type:"master", db} : {type:"fader", ch:key as number, db}); }
  }
  vf.addEventListener("pointerdown", e => { try{vf.setPointerCapture(e.pointerId)}catch(_){} dragging.add(key); commit(yToDb(vf,e.clientY)); e.preventDefault(); });
  vf.addEventListener("pointermove", e => { if(dragging.has(key)) commit(yToDb(vf,e.clientY)); });
  const end = (e: PointerEvent) => { if(dragging.has(key)){ commit(yToDb(vf,e.clientY), true); dragging.delete(key); } };
  vf.addEventListener("pointerup", end); vf.addEventListener("pointercancel", end);
  vf.addEventListener("lostpointercapture", () => dragging.delete(key));
  if(mute){ mute.addEventListener("click", () => action({type:"mute", ch:key as number, on: !muteOn[key as number]})); mute.addEventListener("pointerdown", addRipple); }
  return {el, cap, fill, vdb, mute};
}
function buildMixer(chs: ChannelT[]): void {
  const root = $("#mixer"); root.innerHTML = "";
  for(const c of (chs||[])){ if(c.is_meas) continue; const s = makeStrip(c.ch, SHORT[c.role] || (c.label||"").slice(0,4).toUpperCase(), false); stripEls[c.ch] = s; root.appendChild(s.el); }
  masterEl = makeStrip("master", "MAIN", true); root.appendChild(masterEl.el);
}

function closeWS(): void { if(ws){ ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null; try{ws.close()}catch(e){} ws=null; } wsReady=false; }
function closeSSE(): void { if(es){ try{es.close()}catch(e){} es=null; } }
function useSSE(): void {
  closeWS();
  if(es) return;
  es = new EventSource("/events");
  es.onopen = () => setConn(true, "connected · SSE");
  es.onerror = () => { setConn(false, "reconnecting…"); checkSession(); };
  es.onmessage = ev => onFrame(ev.data);
}
function connectWS(): void {
  closeSSE(); closeWS();
  let opened = false;
  let sock: WebSocket;
  try{ sock = ws = new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws"); }
  catch(e){ useSSE(); return; }
  sock.onopen = () => { opened = true; wsReady = true; setConn(true, "connected"); };
  sock.onmessage = ev => onFrame(ev.data);
  sock.onerror = () => {};
  sock.onclose = () => {
    wsReady = false; ws = null;
    if(!opened){ checkSession(); useSSE(); }
    else { setConn(false, "reconnecting…"); checkSession(); if(!retryT) retryT = setTimeout(() => { retryT = null; connectWS(); }, 1500); }
  };
}

let wakeLock: WakeLockSentinel | null = null;
async function keepAwake(): Promise<void> {
  if(wakeLock || !("wakeLock" in navigator)) return;
  try{
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  }catch(e){ wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState === "visible") keepAwake();
});

buildJobs();
render(window.__INITIAL__ || null);
applyHashTab();
const _SHOT = new URLSearchParams(location.search).has("shot");
fetch("/state").then(r => r.json()).then((s: Snapshot) => { render(s); applyHashTab(); }).catch(() => {});
if(!_SHOT){ connectWS(); keepAwake(); }
else { setConn(true, "preview"); }
