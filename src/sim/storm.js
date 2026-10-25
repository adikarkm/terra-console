// Hurricane model: the storm is advected by the steering wind field plus beta drift,
// intensifies over warm tropical water, weakens poleward and decays over land
// (Kaplan & DeMaria 1995 inland decay). The user's drag only gives the initial push.
import { Wind } from "./windmodel.js";
import { isLand, sampleDEM } from "../data/dem.js";
import { CITIES } from "../data/places.js";
import { moveEN, haversine, DEG } from "../util/geo.js";

export const CAT_WIND = [0, 75, 90, 105, 125, 145]; // kt at genesis per category
export const SURGE_M = [0.5, 1.5, 2.4, 3.7, 5.5, 7.0]; // typical peak surge by category (NHC SLOSH ranges, midpoints)

export function catFromKt(v) {
  if (v >= 137) return 5;
  if (v >= 113) return 4;
  if (v >= 96) return 3;
  if (v >= 83) return 2;
  if (v >= 64) return 1;
  if (v >= 34) return 0; // tropical storm
  return -1; // depression / remnant
}
export function catLabel(c) {
  return c >= 1 ? `Cat ${c}` : c === 0 ? "Tropical storm" : "Remnant low";
}

// Model constants. steer/beta/tau were fitted to 1980-2014 Atlantic best tracks by
// tools/calibrate_storms.mjs (minimising 48 h track error); see docs/SIMULATION.md.
export const STORM_PARAMS = { steer: 0.45, betaU: -0.75, betaV: 2.0, tau: 48, warmGain: 0.6, coolLoss: 1.3, coldLoss: 2.6 };

// genesis {lat,lon}; cat 1-5 (or opts.v0 in kt); push {u,v} m/s initial motion beyond the
// steering flow, decaying with e-folding time tau hours
export function simulateStorm(genesis, cat = 3, push = { u: 0, v: 0 }, hours = 168, opts = {}) {
  const P = { ...STORM_PARAMS, ...(opts.params || {}) };
  let p = { ...genesis };
  let V = opts.v0 ?? CAT_WIND[cat];
  let landHours = 0;
  let V0land = V;
  const track = [{ ...p, t: 0, v: V, cat: catFromKt(V), land: isLand(p.lat, p.lon) }];
  const ns = genesis.lat >= 0 ? 1 : -1;
  for (let t = 1; t <= hours; t++) {
    const w0 = Wind.sample(p.lat, p.lon);
    const w = opts.windOffset ? { u: w0.u + opts.windOffset.u, v: w0.v + opts.windOffset.v } : w0;
    const decay = Math.exp(-t / P.tau);
    const u = P.steer * w.u + P.betaU + push.u * decay;
    const v = P.steer * w.v + P.betaV * ns + push.v * decay;
    p = moveEN(p, u * 3.6, v * 3.6);
    const land = isLand(p.lat, p.lon);
    const a = Math.abs(p.lat);
    if (land) {
      if (landHours === 0) V0land = V;
      landHours++;
      V = 26.7 + (V0land - 26.7) * Math.exp(-0.095 * landHours);
      const elev = sampleDEM(p.lat, p.lon).elev;
      if (elev > 1000) V -= 2; // mountains shred the core
    } else {
      landHours = 0;
      if (a > 6 && a < 26) V = Math.min(160, V + P.warmGain); // warm water
      else if (a >= 30 && a < 40) V -= P.coolLoss;
      else if (a >= 40) V -= P.coldLoss;
    }
    track.push({ ...p, t, v: V, cat: catFromKt(V), land });
    if (!opts.noStop && (V < 30 || a > 65)) break;
  }
  return track;
}

// initial push so the model starts moving the way the storm was observed to move
export function pushFromMotion(at, motion /* {u,v} m/s observed */, params = STORM_PARAMS) {
  const w = Wind.sample(at.lat, at.lon);
  const ns = at.lat >= 0 ? 1 : -1;
  return { u: motion.u - (params.steer * w.u + params.betaU), v: motion.v - (params.steer * w.v + params.betaV * ns) };
}

// radius of tropical-storm-force (34 kt) winds, km
export function r34(pt) {
  if (pt.v < 34) return 0;
  return 120 + 35 * Math.max(0, pt.cat) + Math.max(0, Math.abs(pt.lat) - 25) * 4;
}

function coastal(c) {
  // a cell of the ~20 km DEM within ~40 km is ocean
  for (const [dy, dx] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
    if (sampleDEM(c.lat + dy, c.lon + dx).kind === "ocean") return true;
  }
  return false;
}

export function stormImpacts(track) {
  const out = [];
  if (!track?.length) return out;
  for (const c of CITIES) {
    let best = Infinity, bp = null;
    for (let i = 0; i < track.length; i += 1) {
      const d = haversine(c, track[i]);
      if (d < best) { best = d; bp = track[i]; }
    }
    const R = r34(bp);
    if (!R || best > R) continue;
    const hurricane = bp.cat >= 1 && best < R * 0.4;
    const surge = SURGE_M[Math.max(0, bp.cat)];
    const surgeRisk = !bp.land && best < R * 0.6 && c.elev < surge && coastal(c);
    out.push({
      name: c.name, cc: c.cc, pop: c.pop, distKm: best, cat: bp.cat,
      sev: hurricane || surgeRisk ? 2 : 1,
      why: `${hurricane ? catLabel(bp.cat) + " winds" : "Storm-force winds"}${surgeRisk ? ` · surge ~${surge} m` : ""}`,
    });
  }
  out.sort((a, b) => b.sev - a.sev || b.pop - a.pop);
  return out;
}

export function landfall(track) {
  for (let i = 1; i < track.length; i++) if (track[i].land && !track[i - 1].land) return track[i];
  return null;
}

export { DEG };
