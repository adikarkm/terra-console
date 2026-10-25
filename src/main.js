// Terra Console — bootstrap and wiring.
import { S, emit, on } from "./state.js";
import { $, $$, toast, setPressed } from "./util/dom.js";
import { loadDEM } from "./data/dem.js";
import { initScene, setFloodSpill, G, viewCenter, setHolo } from "./globe/scene.js";
import { Raster, rasterPath } from "./globe/overlays.js";
import { initLayers, showDataLayer, clearLayers } from "./ai/layers.js";
import { initFlood, Flood } from "./sim/flood.js";
import { initWindLayer, setWindLayer, loadLiveWind, Wind, windEngine } from "./sim/wind.js";
import { initPlumes, plumesVisible } from "./sim/hazards.js";
import { initWhatIf, simState, applySimState, setWiTool, setSea } from "./modes/whatif.js";
import { initAsk, setAskTool, ASK, showRemoteAnswer, submitQuestion, runSimulation } from "./modes/ask.js";
import { initPointer, updateCursor } from "./input/pointer.js";
import { runCommand } from "./input/commands.js";
import { startVoice, stopVoice, speak } from "./input/voice.js";
import { startHands, stopHands, HandState } from "./input/hands.js";
import { initAI } from "./ai/agent.js";
import { initTimeline, toggleTime } from "./time/timeline.js";
import { initCollab, shareRegion, shareAnswer, shareSim, joinLocalRoom, setNick, Collab } from "./collab/room.js";
import { enterXR, xrSupport, enterLookingGlass } from "./xr/xr.js";
import { setSphereOutput } from "./display/sphere.js";
import { initGround, openGround } from "./ground/ground.js";
import { toggleSound } from "./audio/soundscape.js";
import { initTrainer, openTrainer } from "./ui/trainer.js";
import { initHistory } from "./modes/history.js";
import { initRegional, R as REGIONAL } from "./regional/regional.js";
import { initLive } from "./live/live.js";
import { initEnsembleView } from "./modes/ensembleview.js";
import { initDeixis, onInterim, resolveDeixis } from "./input/deixis.js";
import { initStream, setBasemap, setExaggeration, streamStats, setStream } from "./globe/stream.js";
import { initPlaceLabels, setPlaceLabels } from "./globe/placelabels.js";
import { sampleDEM } from "./data/dem.js";
import { nearestCity, countryAt } from "./data/places.js";
import { fmtLat, fmtLon } from "./util/geo.js";

let lastHover = null;

async function boot() {
  await loadDEM();
  initScene($("#gl"));
  initLayers();
  initWhatIf();
  initAsk();
  initWindLayer();
  initPlumes();
  initPointer($("#gl"));
  initTimeline();
  initGround();
  initTrainer();
  initHistory();
  initRegional();
  initLive();
  initEnsembleView();
  initDeixis();
  initPlaceLabels();
  wireUI();
  setMode("ask");
  initCollab({
    onRegion: () => {},
    onAnswer: (a) => { showRemoteAnswer(a); emit("answer:text", a.text); },
    onSim: (st) => { if (S.mode !== "whatif") setMode("whatif"); applySimState(st); },
  });

  // heavy compute and network checks in parallel
  initFlood()
    .then((f) => {
      setFloodSpill(f.spill);
      $("#floodEng").textContent = `Flood engine: Priority-Flood in ${f.engine === "wasm" ? "WebAssembly" : "JavaScript"} worker · ${Math.round(f.ms)} ms`;
      if (S.sea > 0) setSea(S.sea);
    })
    .catch((e) => { console.error(e); $("#floodEng").textContent = "Flood engine failed to start"; });
  // developer handle for the browser console
  window.terra = { S, G, regional: REGIONAL, flood: Flood, runCommand, streamStats, setStream };
  await initAI();
  initStream();
  if (S.local) loadLiveWind();
  $("#roomLocal").hidden = !S.local;
  if (!S.local && !window.claude) $("#roomInfo").textContent = "Collaboration needs the published page (shared room) or the local server (named rooms).";
}

function setMode(m) {
  S.mode = m;
  document.body.classList.toggle("whatif", m === "whatif");
  setPressed([$("#mAsk"), $("#mWi")], m === "ask" ? $("#mAsk") : $("#mWi"));
  $("#askPanel").hidden = m !== "ask";
  $("#wiPanel").hidden = m !== "whatif";
  G.uniforms.uFloodVis.value = m === "whatif" ? 1 : 0;
  updateCursor();
  emit("mode", m);
}

function chip(id, on, text, busy = false) {
  const el = $(id);
  el.classList.toggle("on", !!on);
  el.classList.toggle("busy", !!busy);
  el.querySelector("span").textContent = text;
}

function togglePop(id) {
  for (const p of ["#layersPop", "#roomPop"]) if (p !== id) $(p).hidden = true;
  $(id).hidden = !$(id).hidden;
}

function wireUI() {
  on("mode:set", setMode);
  $("#mAsk").addEventListener("click", () => setMode("ask"));
  $("#mWi").addEventListener("click", () => setMode("whatif"));
  on("tool", updateCursor);

  // command bar
  const input = $("#cmdInput");
  const send = () => { const v = input.value; input.value = ""; const d = resolveDeixis(v, { typed: true }); runCommand(d ? d.text : v, { point: d?.point }); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  $("#sendBtn").addEventListener("click", send);
  const defaultPh = input.placeholder;
  $("#micBtn").addEventListener("click", () => {
    if (S.voice) stopVoice();
    else startVoice(onVoiceFinal, (interim) => {
      onInterim(interim);
      if (S.wake && /^(hey |ok |okay )?terra\b/i.test(interim)) $("#micBtn").classList.add("wake");
      input.placeholder = interim ? `${interim}…` : defaultPh;
    });
  });
  on("voice:state", (v) => { $("#micBtn").classList.toggle("on", v); chip("#stVoice", v, v ? "Voice · listening" : "Voice · off"); });
  $("#camBtn").addEventListener("click", () => (S.hands ? stopHands() : startHands()));
  on("hands:state", (v) => { $("#camBtn").classList.toggle("on", v); chip("#stHands", v, v ? "Hands · tracking" : "Hands · off"); });
  on("ai:status", (a) => chip("#stAI", a.kind !== "offline", a.label));

  // dock
  $("#layersBtn").addEventListener("click", () => togglePop("#layersPop"));
  $("#roomBtn").addEventListener("click", () => togglePop("#roomPop"));
  $("#timeBtn").addEventListener("click", () => toggleTime());
  $("#groundBtn").addEventListener("click", () => openGround(S.region?.centroid || lastHover || viewCenter()));
  $("#trainBtn").addEventListener("click", openTrainer);
  $("#soundBtn").addEventListener("click", async () => { const v = await toggleSound(); $("#soundBtn").classList.toggle("on", v); toast(v ? "Spatial sound on. Hover near storms, fires and floods." : "Sound off"); });
  $("#xrBtn").addEventListener("click", async () => {
    const sup = await xrSupport();
    if (sup.ar) enterXR("immersive-ar");
    else if (sup.vr) enterXR("immersive-vr");
    else toast("No VR or AR headset found. Open the local version in a Quest or Vision Pro browser (see docs/XR.md).", 5000);
  });
  $("#helpBtn").addEventListener("click", () => ($("#help").hidden = false));
  $("#helpClose").addEventListener("click", () => ($("#help").hidden = true));

  // layers
  $("#lyHolo").addEventListener("change", (e) => setHolo(e.target.checked));
  $("#lyWind").addEventListener("change", (e) => setWindLayer(e.target.checked));
  on("wind:layer", (v) => ($("#lyWind").checked = v));
  $("#lyBorders").addEventListener("change", (e) => (e.target.checked ? showDataLayer("base:borders", { kind: "countries" }) : clearLayers("base:borders")));
  $("#lyPlumes").addEventListener("change", (e) => plumesVisible(e.target.checked));
  $("#basemap").addEventListener("change", (e) => setBasemap(e.target.value));
  $("#exag").addEventListener("change", (e) => setExaggeration(+e.target.value));
  $("#lyPlaces").addEventListener("change", (e) => setPlaceLabels(e.target.checked));
  $("#lyDensity").addEventListener("change", (e) => (e.target.checked ? showDataLayer("base:density", { kind: "density" }) : clearLayers("base:density")));
  $("#lyNarrate").addEventListener("change", (e) => (ASK.narrate = e.target.checked));
  $("#sphereOut").addEventListener("change", (e) => setSphereOutput(e.target.value));
  $("#lgBtn").addEventListener("click", enterLookingGlass);
  $("#lyWake").addEventListener("change", (e) => { S.wake = e.target.checked; toast(S.wake ? "Say “Terra, …” before each command." : "Every phrase is a command."); });
  on("wind:source", (s) => ($("#windSrc").textContent = `Winds: ${s} · ${windEngine()}`));
  $("#windSrc").textContent = `Winds: ${Wind.source} · ${windEngine()}`;
  on("view", (h) => ($("#lyHolo").checked = !!h));

  // answer panel layout
  new MutationObserver(() => document.body.classList.toggle("answer-open", !$("#answer").hidden)).observe($("#answer"), { attributes: true, attributeFilter: ["hidden"] });
  on("answer:speak", () => ASK.lastAnswer && speak(ASK.lastAnswer));

  // collaboration
  $("#roomNick").addEventListener("change", (e) => setNick(e.target.value.trim()));
  $("#roomJoin").addEventListener("click", () => joinLocalRoom($("#roomName").value.trim() || "terra"));
  on("collab:state", (v) => chip("#stRoom", v, v ? `${S.collab.name}` : "Solo"));
  on("collab:peers", (list) => {
    const box = $("#peerList");
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<span class="empty">Nobody else here yet.</span>'; return; }
    for (const p of list) {
      const pr = p.presence || {};
      const s = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = /^#[0-9a-f]{6}$/i.test(pr.color || "") ? pr.color : "#ff7ad9";
      s.append(dot, document.createTextNode(`${pr.nick || "Guest"}${p.guest ? " (guest)" : ""} · ${pr.mode === "whatif" ? "What-If" : "Ask"}${pr.hand ? " · hands" : ""}`));
      box.append(s);
    }
    chip("#stRoom", true, `${S.collab.name} · ${list.length + 1}`);
  });
  on("region:changed", (poly) => shareRegion(poly));
  on("answer", (a) => { shareAnswer(a); emit("answer:text", a.text); });
  let simT = 0;
  on("sim:changed", () => { clearTimeout(simT); simT = setTimeout(() => shareSim(simState()), 250); });

  on("hover", (p) => { if (p) lastHover = p; });
  on("zoom:limit", () => toast("Closest zoom on this page. Street-level imagery and 3D terrain stream in the local version (npm start)."));
  on("time:state", (v) => document.body.classList.toggle("time-open", v));
  const clock = () => { const d = new Date(); $("#roClock").textContent = `${d.toISOString().slice(0, 10)}  ${d.toISOString().slice(11, 16)} UTC`; };
  clock();
  setInterval(clock, 15000);

  // custom gestures from the trainer
  on("gesture:custom", ({ action, name, at }) => {
    toast(`Gesture: ${name}`);
    if (action === "clear_overlays") { clearLayers("ai:"); plumesVisible(false); $("#lyPlumes").checked = false; setWindLayer(false); }
    else if (action === "toggle_wind") setWindLayer(!S.windLayer);
    else if (action === "toggle_time") toggleTime();
    else if (action === "switch_mode") setMode(S.mode === "ask" ? "whatif" : "ask");
    else if (action === "reset_view") { G.fly = null; G.rotX = 0.38; G.dist = 3.2; G.autoSpin = true; }
    else if (action === "scoop_data" && lastHover) scoop(lastHover);
    else if (action === "ask_here" && lastHover) submitQuestion(`What is important to know about the area around ${lastHover.lat.toFixed(2)}, ${lastHover.lon.toFixed(2)}?`);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "Escape" && document.body.classList.contains("sphere-out")) { setSphereOutput("off"); $("#sphereOut").value = "off"; }
    if (e.key === "Escape") { $("#help").hidden = true; for (const p of ["#layersPop", "#roomPop"]) $(p).hidden = true; }
    if (e.key === "/") { e.preventDefault(); $("#cmdInput").focus(); }
  });
}

function onVoiceFinal(raw) {
  let text = raw.trim();
  $("#micBtn").classList.remove("wake");
  if (S.wake) {
    const m = text.match(/^(?:hey |ok |okay )?terra\b[,.!]?\s*(.*)$/i);
    if (!m) return; // not addressed to Terra
    text = m[1];
    if (!text) { toast("Terra is listening"); return; }
  }
  const d = resolveDeixis(text);
  toast(`“${text}”${d ? ` · pointing at ${d.point.lat.toFixed(1)}, ${d.point.lon.toFixed(1)}` : ""}`);
  runCommand(d ? d.text : text, { source: "voice", point: d?.point });
}

function scoop(p) {
  const d = sampleDEM(p.lat, p.lon), nc = nearestCity(p), co = countryAt(p.lat, p.lon), w = Wind.sample(p.lat, p.lon);
  toast(`${fmtLat(p.lat)} ${fmtLon(p.lon)} · ${d.kind === "ocean" ? "ocean" : Math.round(d.elev) + " m"}${co ? " · " + co.name : ""}${nc ? ` · ${Math.round(nc.distKm)} km from ${nc.name}` : ""} · wind ${Math.hypot(w.u, w.v).toFixed(0)} m/s`, 5000);
}

boot().catch((e) => {
  console.error(e);
  toast("Terra Console couldn't start: " + (e.message || e), 8000);
});
