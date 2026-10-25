// Natural-language command router shared by the text bar and voice.
import { S, emit } from "../state.js";
import { toast } from "../util/dom.js";
import { findCity, findCountry } from "../data/places.js";
import { flyTo, zoomBy, G, setHolo } from "../globe/scene.js";
import { submitQuestion, runSimulation, clearRegion } from "../modes/ask.js";
import { setSea, clearSim, setWiTool, addHazard } from "../modes/whatif.js";
import { setWindLayer } from "../sim/wind.js";
import { clearLayers } from "../ai/layers.js";

const num = (s) => {
  const w = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, fifty: 50, hundred: 100 };
  return w[s] ?? parseFloat(s);
};

export function runCommand(raw, { source = "text", point = null } = {}) {
  const t = raw.trim();
  const q = t.toLowerCase().replace(/[.!?]+$/, "");
  if (!q) return;

  if (/^(switch to |go to )?ask( mode)?$/.test(q)) return emit("mode:set", "ask");
  if (/^(switch to |go to )?(what[- ]?if|simulation|simulate)( mode)?$/.test(q)) return emit("mode:set", "whatif");
  if (/^(reset|clear)( everything| all)?$/.test(q)) { clearSim(); clearRegion(); clearLayers(); return toast("Cleared"); }
  if (/^(zoom in|closer)$/.test(q)) return zoomBy(0.7);
  if (/^(zoom out|further|farther)$/.test(q)) return zoomBy(1.4);
  if (/^(spin|rotate)( the globe)?$/.test(q)) { G.autoSpin = true; return; }
  if (/^(stop|freeze|hold)$/.test(q)) { G.autoSpin = false; return; }
  if (/(show|turn on|enable) (the )?winds?/.test(q)) return setWindLayer(true);
  if (/(hide|turn off|disable) (the )?winds?/.test(q)) return setWindLayer(false);
  if (/(hologram|holo) (view|mode)/.test(q)) return setHolo(true);
  if (/(true|real|natural) colou?r/.test(q)) return setHolo(false);
  if (/^(open |show )?(the )?time(line| travel)?$/.test(q)) return emit("time:toggle", true);
  if (/^(read|say) (it|that)( aloud| out loud)?$/.test(q)) return emit("answer:speak");

  // "show me this region in 2000 vs 2026"
  let y = q.match(/\b((?:19|20)\d\d)\s*(?:vs\.?|versus|and|to|compared (?:to|with))\s*((?:19|20)\d\d)\b/);
  if (y && /(show|compare|region|satellite|imagery|look)/.test(q)) {
    const clampD = (yr) => (+yr < 2000 ? "2000-07-15" : +yr > 2026 ? "2026-07-15" : `${yr}-07-15`);
    emit("time:compare", { a: clampD(y[1]), b: clampD(y[2]), layer: "MODIS_Terra_CorrectedReflectance_TrueColor" });
    return toast(`Comparing ${y[1]} and ${y[2]} imagery`);
  }

  // "go to Tokyo", "fly to Peru", "show me Lagos"
  let m = q.match(/^(?:go to|fly to|take me to|show me|zoom to|focus on)\s+(.+)$/);
  if (m) {
    const c = findCity(m[1]) || findCountry(m[1]);
    if (c) {
      if (c.lat != null) flyTo(c.lat, c.lon, 1.9);
      else { const r = c.rings[0]; let la = 0, lo = 0; for (const p of r) { la += p.lat; lo += p.lon; } flyTo(la / r.length, lo / r.length, 2.4); }
      return toast(`Flying to ${c.name}`);
    }
    if (/^show me/.test(q)) return submitQuestion(t); // "show me high-risk flood zones"
    return toast(`I couldn't find "${m[1]}".`);
  }

  // sea level, direct handoff: "what if the sea rose 3 metres (here)", "raise sea level by 2 m", "sea level 10 meters"
  m = q.match(/(?:sea|ocean)s?(?: level)?.*?\b(rose|rises|rise|raise[ds]?|up|by|to|level)?\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred)\s*(m\b|metres?|meters?|ft|feet)/);
  if (m && !/compare|versus|vs\.?|economic|cost/.test(q)) {
    let metres = num(m[2]) * (/ft|feet/.test(m[3]) ? 0.3048 : 1);
    runSimulation({ type: "sea", meters: Math.round(metres * 10) / 10, ...(point ? { lat: point.lat, lon: point.lon } : {}) });
    return toast(`Simulating +${metres.toFixed(1)} m sea level${S.region ? " for your region" : ""}`);
  }
  // "hurricane category 4 (near Miami)"
  m = q.match(/(?:hurricane|cyclone|typhoon).*?(?:cat(?:egory)?\s*)(\d)/);
  if (m) {
    const near = q.match(/(?:near|at|hits?|over)\s+([a-z\s'-]+)$/);
    const c = near && findCity(near[1]);
    const g = point ? { lat: point.lat, lon: point.lon } : c ? { lat: c.lat - Math.sign(c.lat || 1) * 6, lon: c.lon + 8 } : S.region?.centroid;
    if (g) { runSimulation({ type: "hurricane", category: +m[1], lat: g.lat, lon: g.lon }); return; }
    emit("mode:set", "whatif"); setWiTool("storm"); S.stormCat = +m[1];
    return toast(`Category ${m[1]} ready. Tap the ocean where the storm should form.`);
  }
  m = q.match(/^(?:erupt|trigger|start|place|put|drop)\s+(?:a\s+|an\s+)?(volcano|eruption|wildfire|fire|meteor|asteroid)/);
  if (m && point) {
    const type = /volcano|eruption/.test(m[1]) ? "volcano" : /fire/.test(m[1]) ? "wildfire" : "meteor";
    emit("mode:set", "whatif");
    addHazard(type, point, { size: S.meteorSize });
    emit("sim:changed", "event");
    flyTo(point.lat, point.lon, Math.min(G.dist, 2.4));
    return;
  }
  if (m) {
    emit("mode:set", "whatif"); setWiTool("event");
    S.eventType = /volcano|eruption/.test(m[1]) ? "volcano" : /fire/.test(m[1]) ? "wildfire" : "meteor";
    emit("event:type", S.eventType);
    return toast("Tap the globe to place it.");
  }
  // anything else is a question for the agent
  return submitQuestion(t);
}
