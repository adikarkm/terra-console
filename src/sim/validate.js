// Historical validation of the hurricane model against Atlantic best tracks (1975-2024).
// For each 6-hourly fix of a tropical storm over water, the model forecasts 24/48/72 h ahead and
// we measure the great-circle error to where the storm actually was. Two baselines:
//  - persistence: keep moving the way the storm moved over the previous 12 h
//  - model (steering only): no knowledge of the storm's recent motion
// and the full model, which starts from the observed motion and relaxes to the steering flow.
import STORMS from "../data/generated/storms.json";
import { simulateStorm, pushFromMotion, STORM_PARAMS } from "./storm.js";
import { haversine, moveEN, unwrapLon, DEG } from "../util/geo.js";
import { isLand } from "../data/dem.js";

export { STORMS };

const fix = (s, i) => ({ t: s.p[i][0], lat: s.p[i][1], lon: s.p[i][2], wind: s.p[i][3], pres: s.p[i][4], r34: s.p[i][5] });

// observed position at time t (hours from storm start), linear interpolation
export function obsAt(s, t) {
  const p = s.p;
  if (t < p[0][0] || t > p[p.length - 1][0]) return null;
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i][0]) {
      const a = p[i - 1], b = p[i], k = (t - a[0]) / (b[0] - a[0] || 1);
      return { lat: a[1] + (b[1] - a[1]) * k, lon: a[2] + (unwrapLon(b[2], a[2]) - a[2]) * k, wind: a[3] + (b[3] - a[3]) * k };
    }
  }
  return null;
}

// observed motion (m/s) over the previous `hrs` hours
export function motionBefore(s, t, hrs = 12) {
  const a = obsAt(s, t - hrs), b = obsAt(s, t);
  if (!a || !b) return null;
  const northKm = (b.lat - a.lat) * 111.32;
  const eastKm = (unwrapLon(b.lon, a.lon) - a.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * DEG);
  return { u: (eastKm * 1000) / (hrs * 3600), v: (northKm * 1000) / (hrs * 3600) };
}

export function findStorm(name, year) {
  const n = name.toLowerCase();
  const cands = STORMS.filter((s) => s.n.toLowerCase() === n && (!year || s.y === +year));
  if (!cands.length) return null;
  // most intense if several years share the name
  return cands.sort((a, b) => Math.max(...b.p.map((q) => q[3])) - Math.max(...a.p.map((q) => q[3])))[0];
}

export function stormSummary(s) {
  const peak = s.p.reduce((m, q) => (q[3] > m[3] ? q : m), s.p[0]);
  return { id: s.id, name: s.n, year: s.y, start: s.start, hours: s.p[s.p.length - 1][0], peakWindKt: peak[3], minPressureHpa: Math.min(...s.p.map((q) => q[4] || 9999)), points: s.p.length };
}

// Replay: initialise the model at the first fix with hurricane-force winds over water (or the first
// tropical-storm fix) and compare with the observed track for up to 120 h.
export function replay(s, params = STORM_PARAMS, hours = 120) {
  let i0 = s.p.findIndex((q, i) => q[3] >= 64 && i > 1 && !isLand(q[1], q[2]));
  if (i0 < 0) i0 = s.p.findIndex((q, i) => q[3] >= 34 && i > 1);
  if (i0 < 0) i0 = Math.min(2, s.p.length - 1);
  const f = fix(s, i0);
  const motion = motionBefore(s, f.t) || { u: 0, v: 0 };
  const push = pushFromMotion(f, motion, params);
  const model = simulateStorm({ lat: f.lat, lon: f.lon }, 1, push, hours, { v0: f.wind, params, noStop: true });
  const errors = {};
  for (const lead of [24, 48, 72, 96, 120]) {
    const o = obsAt(s, f.t + lead);
    if (o && model[lead]) errors[lead] = Math.round(haversine(o, model[lead]));
  }
  const observed = s.p.map((q) => ({ t: q[0] - f.t, lat: q[1], lon: q[2], v: q[3], r34: q[5] }));
  return { init: { ...f, index: i0 }, model, observed, errors };
}

// Forecast skill over many storms
export function skill({ params = STORM_PARAMS, yearFrom = 1980, yearTo = 2024, step = 12, leads = [24, 48, 72], maxCases = Infinity } = {}) {
  const sum = { model: {}, steering: {}, persistence: {} };
  const n = {};
  for (const L of leads) { sum.model[L] = sum.steering[L] = sum.persistence[L] = 0; n[L] = 0; }
  let cases = 0;
  for (const s of STORMS) {
    if (s.y < yearFrom || s.y > yearTo) continue;
    for (let i = 0; i < s.p.length; i++) {
      const f = fix(s, i);
      if (f.t % step || f.wind < 34 || f.t < 12) continue;
      if (!obsAt(s, f.t + leads[0])) break;
      const motion = motionBefore(s, f.t);
      if (!motion) continue;
      const maxL = leads[leads.length - 1];
      const m1 = simulateStorm(f, 1, pushFromMotion(f, motion, params), maxL, { v0: f.wind, params, noStop: true });
      const m0 = simulateStorm(f, 1, { u: 0, v: 0 }, maxL, { v0: f.wind, params, noStop: true });
      for (const L of leads) {
        const o = obsAt(s, f.t + L);
        if (!o) continue;
        const per = moveEN(f, motion.u * 3.6 * L, motion.v * 3.6 * L);
        sum.model[L] += haversine(o, m1[L]);
        sum.steering[L] += haversine(o, m0[L]);
        sum.persistence[L] += haversine(o, per);
        n[L]++;
      }
      if (++cases >= maxCases) break;
    }
    if (cases >= maxCases) break;
  }
  const out = { cases, years: [yearFrom, yearTo], leads: {} };
  for (const L of leads) {
    const k = n[L] || 1;
    out.leads[L] = {
      n: n[L],
      modelKm: Math.round(sum.model[L] / k),
      steeringOnlyKm: Math.round(sum.steering[L] / k),
      persistenceKm: Math.round(sum.persistence[L] / k),
      skillVsPersistencePct: Math.round((1 - sum.model[L] / (sum.persistence[L] || 1)) * 100),
    };
  }
  return out;
}
