// What-If Earth: sea level (Priority-Flood), steered hurricanes, hazards, impact list.
import * as THREE from "three";
import { S, emit, on } from "../state.js";
import { $, $$, setPressed, toast, fmtKm2, fmtPop, h } from "../util/dom.js";
import { G, flyTo, onFrame } from "../globe/scene.js";
import { group, clearGroup, sprite, disc, tube, label, removeLabels, moveLabel, TEX, Raster, rasterPath } from "../globe/overlays.js";
import { Flood, floodStats, citiesUnderwater } from "../sim/flood.js";
import { simulateStorm, stormImpacts, r34, catLabel, landfall, CAT_WIND } from "../sim/storm.js";
import { placeHazard, setPlumeSources, METEOR } from "../sim/hazards.js";
import { DEM, isLand } from "../data/dem.js";
import { ll2v, haversine, bearing } from "../util/geo.js";

const stormG = () => WI.stormG;
export const WI = { stormG: null, eventG: null, stormSprite: null, stormLabel: null };
const CAT_COLOR = [0x7fd6ff, 0xffe066, 0xffb547, 0xff8a3d, 0xff5d5d, 0xff3fa8];

// slider position <-> metres (square-root scale: fine control at low rises)
const toMetres = (s) => Math.round(((s / 1000) ** 2) * 100 * 10) / 10;
const toSlider = (m) => Math.round(Math.sqrt(Math.max(0, m) / 100) * 1000);

export function initWhatIf() {
  WI.stormG = group("storm");
  WI.eventG = group("events");
  const slider = $("#seaSlider");
  slider.addEventListener("input", () => setSea(toMetres(+slider.value), { fromSlider: true }));
  for (const b of $$("#seaPresets .chip")) b.addEventListener("click", () => setSea(+b.dataset.sea));

  const tools = { rotate: $("#tWiRotate"), storm: $("#tWiStorm"), event: $("#tWiEvent") };
  for (const [k, el] of Object.entries(tools)) el.addEventListener("click", () => setWiTool(k));

  const catRow = $("#catRow");
  for (let c = 1; c <= 5; c++) {
    const b = h("button", { class: "chip", "aria-pressed": String(c === S.stormCat), "data-cat": c, text: `Cat ${c}` });
    b.addEventListener("click", () => { S.stormCat = c; setPressed($$("#catRow .chip"), b); if (S.storm) runStorm(S.storm.genesis, S.storm.push); emit("sim:changed", "storm"); });
    catRow.append(b);
  }
  for (const b of $$("#evRow .chip")) b.addEventListener("click", () => { S.eventType = b.dataset.ev; setPressed($$("#evRow .chip"), b); $("#metRow").hidden = S.eventType !== "meteor"; });
  for (const b of $$("#metRow .chip")) b.addEventListener("click", () => { S.meteorSize = +b.dataset.met; setPressed($$("#metRow .chip"), b); });
  $("#clearSim").addEventListener("click", () => { clearSim(); emit("sim:changed", "clear"); });
  on("wind:source", () => { if (S.storm) runStorm(S.storm.genesis, S.storm.push); });

  onFrame(animate);
}

export function setWiTool(k) {
  S.wiTool = k;
  setPressed([$("#tWiRotate"), $("#tWiStorm"), $("#tWiEvent")], { rotate: $("#tWiRotate"), storm: $("#tWiStorm"), event: $("#tWiEvent") }[k]);
  $("#stormOpts").hidden = k !== "storm";
  $("#eventOpts").hidden = k !== "event";
  emit("tool", k);
}

let seaJob = 0;
export async function setSea(m, { fromSlider = false, silent = false } = {}) {
  S.sea = Math.max(0, Math.min(100, m));
  if (!fromSlider) $("#seaSlider").value = toSlider(S.sea);
  $("#seaVal").textContent = `+${S.sea < 10 ? S.sea.toFixed(1) : Math.round(S.sea)}`;
  const job = ++seaJob;
  const fs = await floodStats(S.sea);
  const area = fs.area;
  if (job !== seaJob) return;
  $("#seaArea").textContent = fmtKm2(area);
  $("#seaPeople").textContent = fs.people ? fmtPop(fs.people) : "0";
  const cl = $("#seaCountries");
  cl.innerHTML = "";
  for (const c of fs.countries.slice(0, 5)) cl.append(h("li", {}, h("span", { text: c.country }), h("span", { text: fmtPop(c.people) })));
  WI.seaStats = fs;
  $("#seaPct").textContent = `${((area / DEM.landArea) * 100).toFixed(S.sea < 5 ? 2 : 1)}%`;
  const under = citiesUnderwater(S.sea);
  const ul = $("#seaCities");
  ul.innerHTML = "";
  if (!under.length) ul.append(h("li", { class: "empty", text: S.sea > 0 && S.sea < 1.3 ? "No major city centres yet. Below ~1.3 m the 20 km grid can't resolve flooding." : "None at this level." }));
  const total = under.reduce((a, c) => a + c.pop, 0);
  for (const c of under.slice(0, 12)) ul.append(h("li", {}, h("span", { text: `${c.name}, ${c.cc}` }), h("span", { text: `${fmtPop(c.pop)} · ${c.est ? "~" : ""}${c.elev} m` })));
  if (under.length > 12) ul.append(h("li", {}, h("span", { text: `+${under.length - 12} more cities` }), h("span", { text: `${fmtPop(total)} people total` })));
  WI.seaArea = area;
  WI.seaCities = under;
  if (!silent) emit("sim:changed", "sea");
  emit("sea", S.sea);
}

// ---- hurricane -----------------------------------------------------------------------------
export function runStorm(genesis, push = { u: 0, v: 0 }, cat = S.stormCat) {
  S.stormCat = cat;
  setPressed($$("#catRow .chip"), $(`#catRow .chip[data-cat="${cat}"]`));
  const track = simulateStorm(genesis, cat, push);
  S.storm = { genesis, push, cat, track, t: 0 };
  drawStorm();
  WI.stormImpacts = stormImpacts(track);
  renderImpacts();
  const lf = landfall(track);
  toast(lf ? `${catLabel(cat)} storm makes landfall near ${lf.lat.toFixed(1)}°, ${lf.lon.toFixed(1)}° after ${lf.t} h at ${catLabel(lf.cat)}` : `${catLabel(cat)} storm tracked for ${track.length - 1} h without landfall`, 4500);
  return track;
}

function drawStorm() {
  const g = stormG();
  clearGroup(g);
  removeLabels(g);
  const tr = S.storm?.track;
  if (!tr || tr.length < 2) return;
  // track segments coloured by category
  let seg = [tr[0]];
  for (let i = 1; i < tr.length; i++) {
    seg.push(tr[i]);
    if (tr[i].cat !== tr[i - 1].cat || i === tr.length - 1) {
      const t = tube(seg, { color: CAT_COLOR[Math.max(0, tr[i - 1].cat)] ?? 0x7fd6ff, radius: 0.0032 });
      if (t) g.add(t);
      seg = [tr[i]];
    }
  }
  for (let i = 0; i < tr.length; i += 12) {
    const p = tr[i];
    const R = r34(p);
    if (R) g.add(disc(p.lat, p.lon, R, { color: 0xff6a5f, opacity: 0.18 }));
    g.add(sprite(p.lat, p.lon, { color: CAT_COLOR[Math.max(0, p.cat)] ?? 0x7fd6ff, size: 0.02 }));
  }
  WI.stormSprite = sprite(tr[0].lat, tr[0].lon, { color: 0xffffff, size: 0.12, tex: TEX.storm, r: 1.015 });
  WI.stormSprite.material.blending = THREE.NormalBlending;
  WI.stormSprite.material.opacity = 0.9;
  g.add(WI.stormSprite);
  WI.stormLabel = label(tr[0].lat, tr[0].lon, `${catLabel(tr[0].cat)}<small>hour 0</small>`, "", g);
  const lf = landfall(tr);
  if (lf) label(lf.lat, lf.lon, `Landfall<small>${catLabel(lf.cat)} · hour ${lf.t}</small>`, "heat", g);
}

// ---- hazards ---------------------------------------------------------------------------------
export function addHazard(type, at, opts = {}) {
  if (type === "wildfire" && !isLand(at.lat, at.lon)) { toast("Fires need land. Tap on land."); return null; }
  const ev = placeHazard(type, at, { size: opts.size ?? S.meteorSize });
  ev.t0 = G.clock.elapsedTime;
  S.events.push(ev);
  drawEvents();
  setPlumeSources(S.events);
  renderImpacts();
  const n = ev.impacts.length;
  toast(`${type === "meteor" ? METEOR[ev.size].label : type[0].toUpperCase() + type.slice(1)} placed · ${n} ${n === 1 ? "city" : "cities"} affected`);
  return ev;
}

function drawEvents() {
  const g = WI.eventG;
  clearGroup(g);
  removeLabels(g);
  Raster.clear("fire:");
  for (const ev of S.events) {
    const color = ev.type === "volcano" ? 0xff6a3d : ev.type === "wildfire" ? 0xff9a2e : 0xffffff;
    const core = sprite(ev.lat, ev.lon, { color, size: 0.06 });
    core.userData.pulse = true;
    g.add(core);
    if (ev.radiusKm) {
      const d = disc(ev.lat, ev.lon, ev.radiusKm, { color, opacity: 0.55, tex: TEX.ring });
      d.userData.grow = { t0: ev.t0, dur: 2.2 };
      g.add(d);
    }
    if (ev.perimeter) {
      const ring = tube(ev.perimeter, { color: 0xff7a2e, closed: true, radius: 0.0025 });
      if (ring) g.add(ring);
      const per = ev.perimeter;
      Raster.set(`fire:${ev.id}`, (ctx, W, H) => { ctx.beginPath(); rasterPath(ctx, per, W, H); ctx.fillStyle = "rgba(255,110,40,0.55)"; ctx.fill("evenodd"); });
    }
    const name = ev.type === "meteor" ? METEOR[ev.size].label : ev.type === "volcano" ? "Eruption" : "Wildfire";
    label(ev.lat, ev.lon, `${name}<small>${ev.impacts.length} cities affected</small>`, "heat", g);
  }
}

function renderImpacts() {
  const ul = $("#impactList");
  ul.innerHTML = "";
  const all = [];
  for (const i of WI.stormImpacts || []) all.push({ ...i, src: "Storm" });
  for (const ev of S.events) for (const i of ev.impacts) all.push({ ...i, src: ev.type === "meteor" ? "Impact" : ev.type === "volcano" ? "Volcano" : "Fire" });
  if (!all.length) { ul.append(h("li", { class: "empty", text: "Draw a storm or place an event to see who is hit." })); WI.impacts = []; return; }
  all.sort((a, b) => b.sev - a.sev || b.pop - a.pop);
  WI.impacts = all;
  const total = all.reduce((a, c) => a + c.pop, 0);
  ul.append(h("li", {}, h("span", { text: `${all.length} cities` }), h("span", { text: `${fmtPop(total)} people` })));
  for (const i of all.slice(0, 14)) ul.append(h("li", { class: i.sev > 1 ? "sev" : "" }, h("span", { text: `${i.name}, ${i.cc}` }), h("span", { text: `${i.src} · ${i.why}` })));
}

export function clearSim() {
  import("./ensembleview.js").then((m) => m.clearEnsemble());
  S.storm = null;
  S.events = [];
  WI.stormImpacts = [];
  clearGroup(WI.stormG); removeLabels(WI.stormG);
  clearGroup(WI.eventG); removeLabels(WI.eventG);
  Raster.clear("fire:");
  setPlumeSources([]);
  renderImpacts();
  setSea(0, { silent: true });
}

export function simState() {
  return {
    sea: S.sea,
    storm: S.storm ? { genesis: S.storm.genesis, push: S.storm.push, cat: S.storm.cat } : null,
    events: S.events.map((e) => ({ type: e.type, lat: e.lat, lon: e.lon, size: e.size })),
  };
}

export function applySimState(st) {
  if (!st) return;
  if (typeof st.sea === "number" && Math.abs(st.sea - S.sea) > 0.05) setSea(st.sea, { silent: true });
  const sameStorm = JSON.stringify(st.storm) === JSON.stringify(S.storm ? { genesis: S.storm.genesis, push: S.storm.push, cat: S.storm.cat } : null);
  if (!sameStorm) {
    if (st.storm) runStorm(st.storm.genesis, st.storm.push, st.storm.cat);
    else { S.storm = null; WI.stormImpacts = []; clearGroup(WI.stormG); removeLabels(WI.stormG); renderImpacts(); }
  }
  const evKey = (a) => JSON.stringify(a.map((e) => [e.type, e.lat.toFixed(3), e.lon.toFixed(3), e.size]));
  if (evKey(st.events || []) !== evKey(S.events)) {
    S.events = [];
    for (const e of st.events || []) { const ev = placeHazard(e.type, e, { size: e.size }); ev.t0 = G.clock.elapsedTime; S.events.push(ev); }
    drawEvents();
    setPlumeSources(S.events);
    renderImpacts();
  }
}

function animate(dt, t) {
  const st = S.storm;
  if (st?.track?.length > 1 && WI.stormSprite) {
    const loop = 14; // seconds per full replay
    const f = ((t % loop) / loop) * (st.track.length - 1);
    const i = Math.floor(f), k = f - i;
    const a = st.track[i], b = st.track[Math.min(st.track.length - 1, i + 1)];
    const lat = a.lat + (b.lat - a.lat) * k, lon = a.lon + (((b.lon - a.lon + 540) % 360) - 180) * k;
    ll2v(lat, lon, 1.015, WI.stormSprite.position);
    const sz = 0.05 + 0.025 * Math.max(0, a.cat);
    WI.stormSprite.scale.setScalar(a.v < 34 ? 0.04 : sz);
    WI.stormSprite.material.rotation += dt * (st.genesis.lat >= 0 ? 2.5 : -2.5);
    WI.stormSprite.material.color.setHex(CAT_COLOR[Math.max(0, a.cat)] ?? 0x7fd6ff);
    if (WI.stormLabel) { moveLabel(WI.stormLabel, lat, lon); WI.stormLabel.el.innerHTML = `${catLabel(a.cat)}<small>hour ${a.t} · ${Math.round(a.v)} kt</small>`; }
  }
  for (const o of WI.eventG?.children || []) {
    if (o.userData.grow) {
      const g = o.userData.grow;
      const p = Math.min(1, (t - g.t0) / g.dur);
      o.scale.setScalar(Math.max(0.01, p));
      o.material.opacity = 0.25 + 0.3 * (1 - p) + 0.12 * Math.sin(t * 2);
    }
    if (o.userData.pulse) o.material.opacity = 0.7 + 0.3 * Math.sin(t * 5);
  }
}

export { CAT_WIND, haversine, bearing };
