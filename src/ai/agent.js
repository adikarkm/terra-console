// Agentic orchestrator: plan -> call tools -> observe -> repeat -> answer.
// Transport A: the artifact viewer's `sample` capability (runs the tool loop for us).
// Transport B: the local server's /api/claude proxy (we run the Messages API tool loop).
// Transport C: offline deterministic analysis using the same tools.
import { S, emit } from "../state.js";
import { makeTools } from "./tools.js";
import { findCity } from "../data/places.js";
import { fmtPop, fmtKm2 } from "../util/dom.js";
import { criticPrompt } from "./verify.js";

export const AI = { sample: null, proxy: false, kind: "offline", name: "Claude", model: null };

export async function initAI() {
  const checks = [];
  if (window.claude?.use) {
    checks.push(
      window.claude.use("sample").then((s) => { if (s) { AI.sample = s; } }).catch(() => {})
    );
  }
  checks.push(
    fetch("/api/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.ok) { S.local = true; AI.proxy = !!(j.ai || j.claude); AI.liveData = true; if (j.ai) AI.name = j.ai; AI.model = j.model || null; } })
      .catch(() => {})
  );
  await Promise.all(checks);
  AI.kind = AI.sample ? "sample" : AI.proxy ? "proxy" : "offline";
  S.ai = { kind: AI.kind, name: AI.kind === "sample" ? "Claude" : AI.name, model: AI.model, label: AI.kind === "offline" ? "AI · offline" : AI.kind === "sample" ? "AI · Claude" : `AI · ${AI.name} (local)` };
  emit("ai:status", S.ai);
}

const INSTRUCTIONS = `You are TERRA, the analysis engine inside a holographic Earth console. The user points at the planet and asks questions.

How to work:
- "this", "here" and "there" refer to the place in CONSOLE STATE pointedAt when present (the user pointed while speaking); tools default to it when you omit the area.
- Ground every number in a tool result. Never invent figures. If a tool says data is unavailable, say so and give only clearly labelled general knowledge.
- For multi-part or comparative questions, plan the steps, then call tools for each place (geocode -> region_summary / flood_impact with a circle area -> country_indicators when economics matter), then compare.
- Show, don't just tell: draw at least one layer (show_data_layer for terrain/flood/population, show_layer for your own markers, arcs and polygons) and move the view with set_view.
- If a What-If simulation would make the answer tangible (flooding, storms, eruptions, fires), call propose_simulation once.
- Final answer: plain text, at most 170 words, short paragraphs or "- " bullets, key numbers in **bold**, end with a one-line "Sources:" naming the datasets your tools reported. Be clear about the model's limits (20 km grid, city-centre elevations) when they matter.`;

function contextBlock() {
  const r = S.region;
  return JSON.stringify({
    selectedRegion: r ? { centroid: r.centroid, vertices: r.poly.length, areaKm2: Math.round(r.stats?.areaKm2 || 0) } : null,
    pointedAt: S.deixis && Date.now() - S.deixis.at < 120000 ? S.deixis : null,
    currentSimulation: { seaRiseM: S.sea, storm: S.storm ? { category: S.storm.cat, genesis: S.storm.genesis } : null, events: S.events.map((e) => e.type) },
    windSource: S.windSource,
    year: S.year,
  });
}

// run a question; ui = { step(text)->id, stepDone(id, result), text(partial), proposeSimulation(sim) }
export async function ask(question, ui, signal) {
  const tools = makeTools(ui);
  const prompt = `${INSTRUCTIONS}\n\nCONSOLE STATE: ${contextBlock()}\n\nQUESTION: ${question}`;
  if (AI.sample) {
    try {
      const res = await AI.sample(prompt, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: t.execute })),
        onText: ({ text }) => ui.text?.(text),
        modelTier: "complex",
        cache: false,
        signal,
      });
      return { text: res.text, source: "Claude" };
    } catch (e) {
      if (e?.code === "cancelled") throw e;
      if (e?.code !== "not_granted" && e?.code !== "unavailable") ui.step?.(`Claude call failed (${e?.code || "error"}); running offline analysis`);
      if (!AI.proxy) return offline(question, tools, ui);
    }
  }
  if (AI.proxy) {
    try {
      return await proxyLoop(prompt, tools, ui, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      ui.step?.(`${AI.name} failed (${e.message}); running offline analysis`);
    }
  }
  return offline(question, tools, ui);
}

async function proxyLoop(prompt, tools, ui, signal) {
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages = [{ role: "user", content: prompt }];
  for (let round = 0; round < 12; round++) {
    const r = await fetch("/api/claude", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, tools: apiTools, max_tokens: 2000 }), signal });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    const msg = await r.json();
    messages.push({ role: "assistant", content: msg.content });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) ui.text?.(text);
    const calls = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !calls.length) return { text, source: AI.name };
    const results = [];
    for (const c of calls) {
      const t = tools.find((x) => x.name === c.name);
      const out = t ? await t.execute(c.input) : { error: "unknown tool" };
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "Stopped after 12 tool rounds.", source: AI.name };
}

// Offline: deterministic plan using the same tools, so the panel still shows real numbers.
async function offline(question, tools, ui) {
  const T = Object.fromEntries(tools.map((t) => [t.name, t]));
  const q = question.toLowerCase();
  const m = q.match(/(\d+(?:\.\d+)?)\s*(?:m\b|metre|meter|ft|feet)/);
  let meters = m ? parseFloat(m[1]) * (/ft|feet/.test(m[0]) ? 0.3048 : 1) : null;
  // places named in the question (longest first, avoid tiny words)
  const words = question.replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 2);
  const places = [];
  for (let n = 3; n >= 1; n--) for (let i = 0; i + n <= words.length; i++) {
    const phrase = words.slice(i, i + n).join(" ");
    if (/^(what|where|show|compare|versus|with|and|the|sea|level|rise|risk|flood|if|how|many|much|people|city|cities|region|this|here|impact|economic|between|metre|meter|meters|metres)$/i.test(phrase)) continue;
    const c = findCity(phrase);
    if (c && c.name.toLowerCase() === phrase.toLowerCase() && !places.find((p) => p.name === c.name)) places.push(c);
  }
  const lines = [];
  const areas = places.length ? places.slice(0, 3).map((p) => ({ name: p.name, area: { lat: p.lat, lon: p.lon, radiusKm: 120 } })) : [{ name: S.region ? "Selected region" : "View centre", area: undefined }];
  if (!meters && /flood|sea|rise|water|coast|surge/.test(q)) meters = 2;
  for (const A of areas) {
    const s = await T.region_summary.execute({ area: A.area });
    lines.push(`**${A.name}**: ${fmtKm2(s.areaKm2 || 0)}, ${s.landPct}% land, mean elevation ${s.meanElevationM} m. ${s.citiesOver100k} cities over 100k (${fmtPop(s.cityPopulationTotal)} people).`);
    if (meters) {
      const f = await T.flood_impact.execute({ meters, area: A.area });
      lines.push(`- At **+${meters} m**: ${fmtKm2(f.floodedLandKm2 || 0)} of land floods (${f.floodedSharePct}%); ${f.citiesBelowNewSeaLevel.length} city centres fall below sea level (${fmtPop(f.affectedCityPopulation)} people).`);
    }
  }
  await T.show_data_layer.execute({ kind: meters ? "flood" : "lowland", sea: meters || undefined, area: areas[0].area });
  if (areas[0].area) await T.set_view.execute({ lat: areas[0].area.lat, lon: areas[0].area.lon, zoom: 3 });
  if (meters) await T.propose_simulation.execute({ type: "sea", meters, why: `See +${meters} m spread across the coast` });
  lines.push("", "Offline analysis: numbers come from the built-in models. Connect an AI (free OpenRouter key or Claude in .env, or the published page) for full reasoning.", "Sources: Terra DEM, GeoNames, Natural Earth.");
  const text = lines.join("\n");
  ui.text?.(text);
  return { text, source: "Offline" };
}

// Critic pass: ask Claude to correct numbers that don't trace to tool results.
export async function critique(answer, calls, unverified, signal) {
  const prompt = criticPrompt(answer, calls, unverified);
  if (AI.sample) {
    try { return (await AI.sample(prompt, { modelTier: "default", cache: false, signal })).text?.trim() || null; } catch { /* fall through */ }
  }
  if (AI.proxy) {
    try {
      const r = await fetch("/api/claude", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: 1500 }), signal });
      if (!r.ok) return null;
      const msg = await r.json();
      return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
    } catch { return null; }
  }
  return null;
}
