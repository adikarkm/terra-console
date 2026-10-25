// Historical tropical cyclones from every ocean basin: replay a real storm, run the model from the
// same starting point, compare track and intensity, and report the model's forecast skill per basin
// on seasons it was not fitted to.
import { $, h, toast, fmtPop } from "../util/dom.js";
import { group, clearGroup, tube, sprite, label, removeLabels, disc } from "../globe/overlays.js";
import { flyTo } from "../globe/scene.js";
import { loadStorms, storms, STORMDATA, findStorm, replay, skill, stormSummary } from "../sim/validate.js";
import { stormImpacts, catFromKt, catLabel, BASINS } from "../sim/storm.js";
import { emit } from "../state.js";

export const HIST = { g: null, last: null, skillCache: new Map() };
const FAMOUS = ["Andrew 1992", "Mitch 1998", "Katrina 2005", "Sandy 2012", "Harvey 2017", "Maria 2017", "Dorian 2019", "Ian 2022", "Milton 2024", "Patricia 2015", "Haiyan 2013", "Mangkhut 2018", "Hagibis 2019", "Nargis 2008", "Amphan 2020", "Gonu 2007", "Idai 2019", "Freddy 2023", "Winston 2016", "Pam 2015", "Yasi 2011", "Tracy 1974"];

export function initHistory() {
  HIST.g = group("history");
  $("#histGo").addEventListener("click", () => runReplay($("#histName").value));
  $("#histName").addEventListener("keydown", (e) => { if (e.key === "Enter") runReplay($("#histName").value); });
  $("#histName").addEventListener("focus", () => loadStorms().then(fillList), { once: true });
  $("#histSkill").addEventListener("click", showSkill);
  $("#histClear").addEventListener("click", clearHistory);
  // the archive (~0.5 MB compressed) loads in the background a few seconds after start
  setTimeout(() => loadStorms().then(fillList).catch((e) => console.warn("storm archive", e)), 4000);
}

let filled = false;
function fillList() {
  if (filled) return;
  filled = true;
  const S = storms();
  const last = Math.max(...S.map((s) => s.y));
  $("#histTitle").textContent = `Real tropical cyclones · every ocean, ${Math.min(...S.map((s) => s.y))}–${last}`;
  const dl = $("#stormList");
  const seen = new Set();
  for (const f of FAMOUS) { const q = parseStormQuery(f); if (q && findStorm(q.name, q.year)) { seen.add(f); dl.append(h("option", { value: f })); } }
  for (const s of S) {
    if (s.n === "Unnamed") continue;
    const v = `${s.n} ${s.y}`;
    if (!seen.has(v) && s.p.some((q) => q[3] >= 96)) { seen.add(v); dl.append(h("option", { value: v, label: `${v} · ${BASINS[s.b] || s.b}` })); }
  }
}

export function parseStormQuery(q) {
  const m = String(q).trim().match(/^([A-Za-z' -]+?)\s*(\d{4})?$/);
  return m ? { name: m[1].trim(), year: m[2] ? +m[2] : null } : null;
}

export async function runReplay(q) {
  await loadStorms();
  fillList();
  const pq = parseStormQuery(q);
  const s = pq && findStorm(pq.name, pq.year);
  if (!s) { toast(`No storm named "${q}" in the archive (all basins since 1980).`); return null; }
  const r = replay(s);
  HIST.last = { s, r };
  draw(s, r);
  const imp = stormImpacts(r.observed.map((p) => ({ lat: p.lat, lon: p.lon, v: p.v, cat: catFromKt(p.v), t: p.t, land: false })));
  const sum = stormSummary(s);
  const box = $("#histOut");
  box.innerHTML = "";
  box.append(
    h("p", { class: "note", text: `${s.n} ${s.y} (${BASINS[s.b] || s.b}): peak ${sum.peakWindKt} kt (${catLabel(catFromKt(sum.peakWindKt))}), ${sum.minPressureHpa < 9999 ? sum.minPressureHpa + " hPa, " : ""}${Math.round(sum.hours / 24)} days. Model started at hour ${r.init.t} (${r.init.wind} kt) from the observed motion.` }),
    h("ul", { class: "list" }, ...Object.entries(r.errors).map(([L, km]) => h("li", {}, h("span", { text: `${L} h track error` }), h("span", { text: `${km} km · wind ${r.windErrors[L].model} kt (obs ${r.windErrors[L].observed})` })))),
    h("p", { class: "note", text: `Observed track hit ${imp.length} cities over 100k (${fmtPop(imp.reduce((a, c) => a + c.pop, 0))} people) within its storm-force wind radius.` })
  );
  emit("history:replay", { id: s.id });
  return { summary: sum, errors: r.errors, windErrors: r.windErrors, init: r.init, citiesHit: imp.length, peopleInCitiesHit: imp.reduce((a, c) => a + c.pop, 0), topCities: imp.slice(0, 8).map((c) => `${c.name}, ${c.cc}`), source: STORMDATA.source };
}

function draw(s, r) {
  clearGroup(HIST.g);
  removeLabels(HIST.g);
  const obs = r.observed;
  const t1 = tube(obs, { color: 0xffffff, radius: 0.0028, opacity: 0.9 });
  if (t1) HIST.g.add(t1);
  for (const p of obs) if (p.t % 24 === 0) HIST.g.add(sprite(p.lat, p.lon, { color: 0xffffff, size: 0.018 }));
  for (const p of obs) if (p.r34 && p.t % 24 === 0) HIST.g.add(disc(p.lat, p.lon, p.r34, { color: 0xffffff, opacity: 0.08 }));
  const model = r.model.filter((p, i) => i % 3 === 0);
  const t2 = tube(model, { color: 0xffb547, radius: 0.0028, opacity: 0.95 });
  if (t2) HIST.g.add(t2);
  for (const L of [24, 48, 72, 96, 120]) {
    const m = r.model[L];
    if (!m) continue;
    HIST.g.add(sprite(m.lat, m.lon, { color: 0xffb547, size: 0.03 }));
    label(m.lat, m.lon, `Model +${L} h`, "heat", HIST.g);
  }
  const first = obs[0];
  label(first.lat, first.lon, `${s.n} ${s.y}<small>observed (white) vs model (amber)</small>`, "", HIST.g);
  flyTo(r.init.lat, r.init.lon, 2.6);
}

export function clearHistory() {
  clearGroup(HIST.g);
  removeLabels(HIST.g);
  $("#histOut").innerHTML = "";
  HIST.last = null;
}

export async function showSkill() {
  const basin = $("#histBasin").value || null;
  const box = $("#histOut");
  box.innerHTML = `<div class="thinking"><i></i><span>Running forecasts against ${basin ? BASINS[basin] : "every basin"} since 2015…</span></div>`;
  await loadStorms();
  setTimeout(() => {
    const r = modelSkill(basin);
    box.innerHTML = "";
    const pct = (v) => `${v > 0 ? "+" : ""}${v}%`;
    const tbl = h("table", { class: "skill" }, h("tr", {}, h("th", { text: "Lead" }), h("th", { text: "Track" }), h("th", { text: "Persist." }), h("th", { text: "Skill" }), h("th", { text: "Wind" }), h("th", { text: "Persist." }), h("th", { text: "Skill" })));
    for (const [L, v] of Object.entries(r.test.leads)) tbl.append(h("tr", {}, h("td", { text: `${L} h` }), h("td", { text: `${v.modelKm} km` }), h("td", { text: `${v.persistenceKm} km` }), h("td", { text: pct(v.skillVsPersistencePct) }), h("td", { text: `${v.windModelKt} kt` }), h("td", { text: `${v.windPersistenceKt} kt` }), h("td", { text: pct(v.windSkillPct) })));
    box.append(h("p", { class: "note", text: `Mean track and intensity error on held-out seasons ${r.test.years[0]}–${r.test.years[1]} (${r.test.cases} forecasts, ${basin ? BASINS[basin] : "all basins"}). Parameters were fitted per basin on 1980–2014. Positive skill means the model beats persistence ("keep moving the same way, keep today's strength").` }), tbl);
  }, 30);
}

export function modelSkill(basin = null) {
  const key = basin || "all";
  if (!HIST.skillCache.has(key)) {
    const last = Math.max(...storms().map((s) => s.y));
    HIST.skillCache.set(key, { test: skill({ basin, yearFrom: 2015, yearTo: last }), train: skill({ basin, yearFrom: 1980, yearTo: 2014, every: 2 }) });
  }
  return HIST.skillCache.get(key);
}
