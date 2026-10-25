// Hurricane model: the storm is advected by the steering wind field plus beta drift,
// intensifies over warm tropical water, weakens poleward and decays over land
// (Kaplan & DeMaria 1995 inland decay). The user's drag only gives the initial push.
import { Wind } from "./windmodel.js";
import { isLand, sampleDEM } from "../data/dem.js";
import { CITIES } from "../data/places.js";
import { moveEN, haversine, DEG } from "../util/geo.js";
import FITTED from "./storm_params.json";

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

// Ocean basins as IBTrACS defines them (approximate boundaries).
export const BASINS = { NA: "North Atlantic", EP: "Eastern Pacific", WP: "Western Pacific", NI: "North Indian", SI: "South Indian", SP: "South Pacific", SA: "South Atlantic" };
export function basinAt(lat, lon) {
  if (lat >= 0) {
    if (lon >= 30 && lon < 100) return "NI";
    if (lon >= 100) return "WP";
    if (lon < -100 || (lon < -77 && lat < 8 + (-77 - lon) * 0.4)) return "EP"; // Pacific side of Central America
    return "NA";
  }
  if (lon >= 10 && lon < 135) return "SI";
  if (lon >= 135 || lon < -70) return "SP";
  return "SA";
}

// Model constants. Track: steering factor, beta drift (m/s, westward u, poleward v) and the memory
// of the initial motion (tau, h). Intensity: over water the wind relaxes toward a latitude-dependent
// potential intensity (mpiMax kt equatorward of mpiLat0, falling to 25 kt at mpiLat1) with time scale
// tauI (strengthening) or tauW (weakening); over land it decays as Kaplan & DeMaria (1995).
// Defaults below; tools/calibrate_storms.mjs fits a set per basin on 1980-2014 and writes them to
// storm_params.json, which is used when present. See docs/SIMULATION.md.
export const STORM_PARAMS = { steer: 0.45, betaU: -0.75, betaV: 2.0, tau: 48, mpiMax: 140, mpiLat0: 20, mpiLat1: 40, tauI: 48, tauW: 24, ...(FITTED.global || {}) };
export const BASIN_PARAMS = FITTED.basins || {};
export function paramsFor(basin) {
  return { ...STORM_PARAMS, ...(BASIN_PARAMS[basin] || {}) };
}
export function potentialIntensity(lat, P) {
  const a = Math.abs(lat);
  if (a <= P.mpiLat0) return P.mpiMax;
  if (a >= P.mpiLat1) return 25;
  return P.mpiMax + (25 - P.mpiMax) * ((a - P.mpiLat0) / (P.mpiLat1 - P.mpiLat0));
}

// genesis {lat,lon}; cat 1-5 (or opts.v0 in kt); push {u,v} m/s initial motion beyond the
// steering flow, decaying with e-folding time tau hours
export function simulateStorm(genesis, cat = 3, push = { u: 0, v: 0 }, hours = 168, opts = {}) {
  const P = { ...paramsFor(opts.basin || basinAt(genesis.lat, genesis.lon)), ...(opts.params || {}) };
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
      const mpi = potentialIntensity(p.lat, P);
      V += (mpi - V) / (V < mpi ? P.tauI : P.tauW);
    }
    track.push({ ...p, t, v: V, cat: catFromKt(V), land });
    if (!opts.noStop && (V < 30 || a > 65)) break;
  }
  return track;
}

// initial push so the model starts moving the way the storm was observed to move
export function pushFromMotion(at, motion /* {u,v} m/s observed */, params = paramsFor(basinAt(at.lat, at.lon))) {
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
