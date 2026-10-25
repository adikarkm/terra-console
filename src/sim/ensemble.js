// Ensembles: run many perturbed simulations and report ranges and probabilities instead of a
// single answer.
import { simulateStorm, r34, STORM_PARAMS } from "./storm.js";
import { regionStats } from "./flood.js";
import { CITIES } from "../data/places.js";
import { haversine } from "../util/geo.js";

// deterministic RNG so the same question gives the same ensemble
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/**
 * Storm ensemble: perturb genesis (±~1°), intensity (±1 category), steering wind (σ 2 m/s,
 * representing forecast uncertainty in the large-scale flow) and the initial push.
 * Returns member tracks and, for each city, the share of members bringing hurricane-force
 * (and storm-force) winds.
 */
export function stormEnsemble(genesis, cat = 3, push = { u: 0, v: 0 }, members = 50, seed = 7) {
  const r = rng(seed + Math.round(genesis.lat * 100) * 31 + Math.round(genesis.lon * 100));
  const tracks = [];
  for (let m = 0; m < members; m++) {
    const g = { lat: genesis.lat + gauss(r) * 0.8, lon: genesis.lon + gauss(r) * 0.8 };
    const c = Math.max(1, Math.min(5, cat + Math.round(gauss(r) * 0.7)));
    const off = { u: gauss(r) * 2, v: gauss(r) * 2 };
    const p = { u: push.u + gauss(r) * 1, v: push.v + gauss(r) * 1 };
    tracks.push(simulateStorm(g, c, p, 168, { windOffset: off }));
  }
  const hitsH = new Map(), hitsT = new Map();
  for (const tr of tracks) {
    const seenH = new Set(), seenT = new Set();
    for (const p of tr) {
      if (p.v < 34) continue;
      const R = r34(p);
      for (const c of CITIES) {
        if (Math.abs(c.lat - p.lat) > 4) continue;
        const d = haversine(c, p);
        if (d < R) seenT.add(c);
        if (p.cat >= 1 && d < R * 0.4) seenH.add(c);
      }
    }
    for (const c of seenT) hitsT.set(c, (hitsT.get(c) || 0) + 1);
    for (const c of seenH) hitsH.set(c, (hitsH.get(c) || 0) + 1);
  }
  const cities = [...hitsT.entries()].map(([c, n]) => ({ name: c.name, cc: c.cc, pop: c.pop, lat: c.lat, lon: c.lon, pStormForce: n / members, pHurricaneForce: (hitsH.get(c) || 0) / members }))
    .sort((a, b) => b.pHurricaneForce - a.pHurricaneForce || b.pStormForce - a.pStormForce || b.pop - a.pop);
  const landfalls = tracks.map((tr) => tr.findIndex((p, i) => i > 0 && p.land && !tr[i - 1].land)).filter((i) => i > 0);
  return { members, tracks, cities, landfallShare: landfalls.length / members, medianLandfallHour: landfalls.length ? landfalls.sort((a, b) => a - b)[landfalls.length >> 1] : null };
}

/** Sea-level ensemble: flooded area and people over a set of sea levels for an area. */
export async function seaEnsemble(poly, levels = [0.3, 0.5, 0.8, 1, 1.5, 2, 3, 5]) {
  const rows = [];
  for (const m of levels) {
    const st = await regionStats(poly, m);
    rows.push({ seaRiseM: m, floodedKm2: Math.round(st?.floodedKm2 || 0), peopleInFloodedCells: Math.round(st?.peopleFlooded || 0) });
  }
  return rows;
}
