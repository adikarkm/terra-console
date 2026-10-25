// Ask the Earth: draw a region (finger, mouse, XR hand), ask a question, watch the agent work.
import { S, emit, on } from "../state.js";
import { $, $$, h, setPressed, toast, fmtKm2, fmtPop, escapeHtml } from "../util/dom.js";
import { group, clearGroup, tube, label, removeLabels, Raster, rasterPath } from "../globe/overlays.js";
import { flyTo } from "../globe/scene.js";
import { regionStats } from "../sim/flood.js";
import { citiesInPoly, countriesInPoly } from "../data/places.js";
import { polyCentroid, haversine } from "../util/geo.js";
import { ask, AI, critique } from "../ai/agent.js";
import { verify } from "../ai/verify.js";
import { clearLayers } from "../ai/layers.js";
import { setSea, runStorm, addHazard } from "./whatif.js";
import { speak, stopSpeaking } from "../input/voice.js";

export const ASK = { lassoG: null, drawing: null, ctl: null, lastAnswer: null, narrate: false };

const SUGGEST_REGION = ["What are the biggest climate risks here?", "Who lives on land below 5 metres here?", "What if the sea rose 2 metres here?", "Where would a solar farm work best here?"];
const SUGGEST_NONE = ["Compare a 2 metre sea level rise in Durban and Miami", "Which big cities sit below 5 metres?", "Show recent earthquakes near Japan", "What happens if a Cat 4 hurricane hits Houston?"];

export function initAsk() {
  ASK.lassoG = group("lasso");
  $("#tAskRotate").addEventListener("click", () => setAskTool("rotate"));
  $("#tAskLasso").addEventListener("click", () => setAskTool("lasso"));
  $("#clearRegion").addEventListener("click", () => { clearRegion(); emit("region:changed", null); });
  $("#ansClose").addEventListener("click", closeAnswer);
  $("#ansSpeak").addEventListener("click", () => { if (ASK.lastAnswer) speak(ASK.lastAnswer); });
  renderSuggestions();
}

export function setAskTool(k) {
  S.askTool = k;
  setPressed([$("#tAskRotate"), $("#tAskLasso")], k === "rotate" ? $("#tAskRotate") : $("#tAskLasso"));
  emit("tool", k);
}

function renderSuggestions() {
  const box = $("#suggest");
  box.innerHTML = "";
  for (const q of S.region ? SUGGEST_REGION : SUGGEST_NONE) {
    box.append(h("button", { class: "chip q", text: q, onclick: () => submitQuestion(q) }));
  }
}

// ---- lasso -------------------------------------------------------------------------------
export function lassoStart(p) {
  ASK.drawing = [p];
  drawLasso(ASK.drawing, false);
}
export function lassoMove(p) {
  if (!ASK.drawing) return;
  const last = ASK.drawing[ASK.drawing.length - 1];
  if (haversine(last, p) > 15) {
    ASK.drawing.push(p);
    drawLasso(ASK.drawing, false);
  }
}
export async function lassoEnd() {
  const pts = ASK.drawing;
  ASK.drawing = null;
  if (!pts || pts.length < 4) { drawLasso(S.region?.poly || [], true); if (pts) toast("Draw a bigger loop to select a region."); return; }
  await setRegion(simplify(pts));
  emit("region:changed", S.region.poly);
}

function simplify(pts) {
  if (pts.length <= 400) return pts;
  const step = pts.length / 400;
  return Array.from({ length: 400 }, (_, i) => pts[Math.floor(i * step)]);
}

function drawLasso(pts, closed, color = 0x62d6ff, g = ASK.lassoG) {
  clearGroup(g);
  const t = tube(pts, { color, closed, radius: 0.0032 });
  if (t) g.add(t);
}

export async function setRegion(poly, { fly = false } = {}) {
  const centroid = polyCentroid(poly);
  S.region = { poly, centroid, stats: null };
  drawLasso(poly, true);
  Raster.set("region", (ctx, W, H) => { ctx.beginPath(); rasterPath(ctx, poly, W, H); ctx.fillStyle = "rgba(98,214,255,0.12)"; ctx.fill("evenodd"); });
  if (fly) flyTo(centroid.lat, centroid.lon);
  const stats = await regionStats(poly, S.sea);
  if (S.region?.poly !== poly) return;
  S.region.stats = stats;
  const cities = citiesInPoly(poly, 200);
  S.region.cities = cities;
  S.region.countries = countriesInPoly(poly).names;
  $("#regionEmpty").hidden = true;
  $("#regionInfo").hidden = false;
  $("#rgArea").textContent = stats ? fmtKm2(stats.areaKm2) : "–";
  $("#rgLand").textContent = stats ? `${Math.round(stats.landPct)}%` : "–";
  $("#rgElev").textContent = stats ? `${Math.round(stats.meanElev).toLocaleString()} m` : "–";
  $("#rgLow").textContent = stats ? fmtKm2(stats.below5Km2) : "–";
  const ul = $("#rgCities");
  ul.innerHTML = "";
  if (!cities.length) ul.append(h("li", { class: "empty", text: "No cities over 100,000 people inside." }));
  for (const c of cities.slice(0, 6)) ul.append(h("li", {}, h("span", { text: `${c.name}, ${c.cc}` }), h("span", { text: `${fmtPop(c.pop)} · ${c.est ? "~" : ""}${c.elev} m` })));
  if (cities.length > 6) ul.append(h("li", {}, h("span", { text: `${cities.length - 6} more cities` }), h("span", { text: fmtPop(cities.reduce((a, c) => a + c.pop, 0)) + " total" })));
  renderSuggestions();
}

export function clearRegion() {
  S.region = null;
  clearGroup(ASK.lassoG);
  Raster.remove("region");
  $("#regionEmpty").hidden = false;
  $("#regionInfo").hidden = true;
  renderSuggestions();
}

// ---- asking --------------------------------------------------------------------------------
export async function submitQuestion(q, { remote = false } = {}) {
  q = q.trim();
  if (!q) return;
  if (S.mode !== "ask") emit("mode:set", "ask");
  ASK.ctl?.abort();
  ASK.ctl = new AbortController();
  stopSpeaking();
  clearLayers("ai:");
  const panel = $("#answer");
  panel.hidden = false;
  const content = $("#ansContent");
  content.innerHTML = "";
  const title = h("h3", { class: "title", text: q });
  const steps = h("ol", { class: "steps" });
  const body = h("div", { class: "body" }, h("div", { class: "thinking" }, h("i"), h("span", { text: AI.kind === "offline" ? "Analysing offline…" : "Claude is thinking…" })));
  const handoffBox = h("div");
  content.append(title, steps, body, handoffBox);
  $("#ansSrc").textContent = AI.kind === "offline" ? "Offline analysis" : `${S.ai?.name || "Claude"} · grounded`;
  let stepId = 0;
  const calls = [];
  const ui = {
    record(c) { calls.push(c); },
    step(text, result, running) {
      const id = ++stepId;
      const li = h("li", { "data-id": id, class: running ? "run" : "done" }, h("span", { text }));
      steps.append(li);
      if (ASK.narrate) speak(text, { queue: true });
      emit("agent:step", text);
      return id;
    },
    stepDone(id, r) {
      const li = steps.querySelector(`[data-id="${id}"]`);
      if (!li) return;
      li.className = r?.error ? "err" : "done";
      const s = summarizeResult(r);
      if (s) li.append(h("small", { text: s }));
    },
    text(t) { body.innerHTML = renderMarkdown(t); },
    proposeSimulation(sim) { showHandoff(handoffBox, sim); },
  };
  try {
    const res = await ask(q, ui, ASK.ctl.signal);
    let text = res.text || "No answer.";
    let check = verify(text, calls);
    let revised = false;
    if (check.unverified.length && res.source !== "Offline") {
      const id = ui.step(`Fact-checking ${check.unverified.length} untraced number${check.unverified.length > 1 ? "s" : ""}`, null, true);
      const fixed = await critique(text, calls, check.unverified, ASK.ctl.signal);
      if (fixed) {
        const c2 = verify(fixed, calls);
        if (c2.unverified.length < check.unverified.length || (c2.unverified.length === check.unverified.length && c2.verified >= check.verified)) { text = fixed; check = c2; revised = true; }
      }
      ui.stepDone(id, { note: revised ? "revised" : "kept" });
    }
    res.text = text;
    renderAnswer(body, text, check, calls);
    ASK.lastAnswer = stripMd(text);
    ASK.lastCheck = check;
    $("#ansSrc").textContent = `${res.source !== "Offline" ? `${res.source} · grounded in tools` : "Offline analysis"} · ${check.verified}/${check.total} numbers traced${revised ? " · revised by fact-checker" : ""}`;
    if (!remote) emit("answer", { q, text: res.text, source: res.source });
    if (ASK.narrate) speak(ASK.lastAnswer, { queue: true });
  } catch (e) {
    if (e?.code === "cancelled" || e?.name === "AbortError") return;
    body.innerHTML = `<p>Couldn't finish: ${escapeHtml(e.message || e.code || String(e))}</p>`;
  }
}

export function showRemoteAnswer({ q, text, source, from }) {
  $("#answer").hidden = false;
  $("#ansSrc").textContent = `${from || "Peer"} asked · ${source}`;
  $("#ansContent").innerHTML = "";
  $("#ansContent").append(h("h3", { class: "title", text: q }), (() => { const d = h("div", { class: "body" }); d.innerHTML = renderMarkdown(text); return d; })());
  ASK.lastAnswer = stripMd(text);
}

function summarizeResult(r) {
  if (!r) return "";
  if (r.error) return r.error === "unavailable" ? "unavailable here" : String(r.error).slice(0, 80);
  if (r.kind === "city") return `${r.name}, ${r.country} · ${fmtPop(r.population)}`;
  if (r.floodedLandKm2 != null) return `${fmtKm2(r.floodedLandKm2)} flooded · ${fmtPop(r.affectedCityPopulation)} in cities below sea level`;
  if (r.citiesOver100k != null) return `${fmtKm2(r.areaKm2 || 0)} · ${r.citiesOver100k} cities · mean ${r.meanElevationM} m`;
  if (r.count != null) return `${r.count} found`;
  if (r.vsTodayM != null) return `+${r.vsTodayM} m vs today`;
  if (r.speedMs != null) return `${r.speedMs} m/s toward ${r.towardDeg}°`;
  if (r.gdpPerCapitaUSD != null) return `GDP/capita $${Math.round(r.gdpPerCapitaUSD).toLocaleString()}`;
  if (r.peakPeopleInFloodedCells != null) return `peak ${fmtPop(r.peakPeopleInFloodedCells)} people · ${fmtKm2(r.peakFloodedKm2)} at hour ${r.peakHour}`;
  if (r.errors && r.summary) return `${r.summary.name} ${r.summary.year}: 48 h error ${r.errors[48] ?? "–"} km`;
  if (r.heldOut2015to2024) return `72 h skill ${r.heldOut2015to2024.leads[72].skillVsPersistencePct}% vs persistence`;
  if (r.members && r.cities) return `${r.members} members · ${Math.round(r.landfallShare * 100)}% landfall`;
  if (r.rows) return `${r.rows.length} sea levels`;
  if (r.note) return r.note;
  if (r.areaKm2 != null) return fmtKm2(r.areaKm2);
  return "";
}

function showHandoff(box, sim) {
  box.innerHTML = "";
  const desc = sim.type === "sea" ? `Raise the sea by ${sim.meters} m` : sim.type === "hurricane" ? `Spin up a Cat ${sim.category || 3} hurricane` : `Trigger a ${sim.event || "volcano"}`;
  const btn = h("button", { class: "btn amber", text: "Simulate in What-If →" });
  btn.addEventListener("click", () => { runSimulation(sim); emit("sim:changed", "handoff"); });
  box.append(h("div", { class: "handoff" }, h("p", { text: `${desc}. ${sim.why || ""}` }), btn));
}

// Ask -> What-If handoff
export function runSimulation(sim) {
  emit("mode:set", "whatif");
  const where = sim.lat != null ? { lat: sim.lat, lon: sim.lon } : S.region?.centroid;
  if (sim.type === "sea") {
    setSea(+sim.meters || 2);
    if (where) flyTo(where.lat, where.lon, 2.0);
  } else if (sim.type === "hurricane") {
    const g = where || { lat: 18, lon: -60 };
    runStorm(g, { u: 0, v: 0 }, Math.max(1, Math.min(5, sim.category || 3)));
    flyTo(g.lat, g.lon, 2.4);
  } else if (sim.type === "event" && where) {
    addHazard(sim.event || "volcano", where, { size: sim.size ?? 1 });
    flyTo(where.lat, where.lon, 2.2);
  }
}

export function closeAnswer() {
  ASK.ctl?.abort();
  stopSpeaking();
  $("#answer").hidden = true;
}

// answer with every number linked to its source
function renderAnswer(body, text, check, calls) {
  // mark numbers with sentinels before markdown rendering so offsets survive escaping
  let out = "", last = 0;
  check.numbers.forEach((n, i) => {
    out += text.slice(last, n.index) + `\u0001${i}\u0002` + n.text + "\u0003";
    last = n.index + n.text.length;
  });
  out += text.slice(last);
  let html = renderMarkdown(out);
  html = html.replace(/\u0001(\d+)\u0002([\s\S]*?)\u0003/g, (_, i, inner) => {
    const n = check.numbers[+i];
    const cls = n.status === "unverified" ? "num bad" : n.status === "trivial" ? "num" : "num ok";
    return `<button class="${cls}" data-n="${i}" type="button">${inner}</button>`;
  });
  body.innerHTML = html;
  body.querySelectorAll("button.num").forEach((b) => b.addEventListener("click", (e) => showProvenance(e.currentTarget, check.numbers[+b.dataset.n])));
}

function showProvenance(el, n) {
  document.querySelector(".prov")?.remove();
  const box = document.createElement("div");
  box.className = "prov";
  const fmt = (p) => `${p.tool}(${escapeHtml(JSON.stringify(p.input).slice(0, 90))}) → ${escapeHtml(p.path)} = ${escapeHtml(String(Math.round(p.value * 1000) / 1000))}`;
  if (n.status === "tool") box.innerHTML = `<b>From a tool</b><code>${fmt(n.source)}</code>`;
  else if (n.status === "derived") box.innerHTML = `<b>Derived from two tool values</b><code>${fmt(n.source)}</code><code>${fmt(n.source2)}</code>`;
  else if (n.status === "trivial") box.innerHTML = `<b>Small count</b><span>Not checked.</span>`;
  else box.innerHTML = `<b>Not traced</b><span>No tool result supports this number. Treat it with caution.</span>`;
  document.body.append(box);
  const r = el.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(innerWidth - box.offsetWidth - 8, r.left)) + "px";
  box.style.top = r.bottom + 6 + "px";
  setTimeout(() => document.addEventListener("click", function off(ev) { if (!box.contains(ev.target)) { box.remove(); document.removeEventListener("click", off); } }), 0);
}

function renderMarkdown(t) {
  const lines = escapeHtml(t).split(/\n/);
  let html = "", inList = false;
  for (const raw of lines) {
    const l = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^\s*[-•]\s+/.test(l)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${l.replace(/^\s*[-•]\s+/, "")}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (l.trim()) html += /^sources?:/i.test(l.trim()) ? `<p class="srcline">${l}</p>` : `<p>${l}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}
const stripMd = (t) => t.replace(/\*\*/g, "").replace(/^\s*[-•]\s+/gm, "");

on("region:remote", () => {});
export { $$ };
