// Historical validation of the hurricane model against best tracks (IBTrACS, every basin, 1980+).
// For each fix of a tropical storm, the model forecasts 24/48/72 h ahead from the observed position,
// motion and intensity, and we measure:
//  - track error: great-circle distance to where the storm actually was
//  - intensity error: |model wind - observed wind| (kt)
// against two standard baselines: persistence (keep moving the way the storm moved over the
// previous 12 h; keep today's intensity) and, for track, steering only (no knowledge of recent motion).
import { storms, loadStorms, STORMDATA } from "./stormdata.js";
import { simulateStorm, pushFromMotion, paramsFor, basinAt } from "./storm.js";
import { haversine, moveEN, unwrapLon, DEG } from "../util/geo.js";
import { isLand } from "../data/dem.js";

export { loadStorms, storms, STORMDATA };

const fix = (s, i) => ({ t: s.p[i][0], lat: s.p[i][1], lon: s.p[i][2], wind: s.p[i][3], pres: s.p[i][4], r34: s.p[i][5] });

// observed position and wind at time t (hours from storm start), linear interpolation
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

const peak = (s) => s.p.reduce((m, q) => Math.max(m, q[3]), 0);

export function findStorm(name, year, basin) {
  const n = name.toLowerCase();
  const cands = storms().filter((s) => s.n.toLowerCase() === n && (!year || s.y === +year) && (!basin || s.b === basin));
  if (!cands.length) return null;
  return cands.sort((a, b) => peak(b) - peak(a))[0]; // most intense if several share the name
}

export function stormSummary(s) {
  const pk = s.p.reduce((m, q) => (q[3] > m[3] ? q : m), s.p[0]);
  return { id: s.id, name: s.n, year: s.y, basin: s.b, start: s.start, hours: s.p[s.p.length - 1][0], peakWindKt: pk[3], minPressureHpa: Math.min(...s.p.map((q) => q[4] || 9999)), points: s.p.length };
}

// Replay: initialise the model at the first fix with hurricane-force winds over water (or the first
// tropical-storm fix) and compare with the observed track and intensity for up to 120 h.
export function replay(s, params = null, hours = 120) {
  let i0 = s.p.findIndex((q, i) => q[3] >= 64 && i > 1 && !isLand(q[1], q[2]));
  if (i0 < 0) i0 = s.p.findIndex((q, i) => q[3] >= 34 && i > 1);
  if (i0 < 0) i0 = Math.min(2, s.p.length - 1);
  const f = fix(s, i0);
  const P = params || paramsFor(s.b);
  const motion = motionBefore(s, f.t) || { u: 0, v: 0 };
  const push = pushFromMotion(f, motion, P);
  const model = simulateStorm({ lat: f.lat, lon: f.lon }, 1, push, hours, { v0: f.wind, params: P, noStop: true });
  const errors = {}, windErrors = {};
  for (const lead of [24, 48, 72, 96, 120]) {
    const o = obsAt(s, f.t + lead);
    if (o && model[lead]) {
      errors[lead] = Math.round(haversine(o, model[lead]));
      windErrors[lead] = { model: Math.round(model[lead].v), observed: Math.round(o.wind) };
    }
  }
  const observed = s.p.map((q) => ({ t: q[0] - f.t, lat: q[1], lon: q[2], v: q[3], r34: q[5] }));
  return { init: { ...f, index: i0 }, model, observed, errors, windErrors };
}

// Forecast skill over many storms. basin: one of BASINS or null for all.
export function skill({ params = null, basin = null, yearFrom = 1980, yearTo = 2014, step = 12, leads = [24, 48, 72], maxCases = Infinity, every = 1 } = {}) {
  const sum = { model: {}, steering: {}, persistence: {}, wModel: {}, wPersist: {} };
  const n = {};
  for (const L of leads) { for (const k in sum) sum[k][L] = 0; n[L] = 0; }
  let cases = 0, idx = 0;
  for (const s of storms()) {
    if (s.y < yearFrom || s.y > yearTo || (basin && s.b !== basin)) continue;
    if (idx++ % every) continue;
    const P = params || paramsFor(s.b);
    for (let i = 0; i < s.p.length; i++) {
      const f = fix(s, i);
      if (f.t % step || f.wind < 34 || f.t < 12) continue;
      if (!obsAt(s, f.t + leads[0])) break;
      const motion = motionBefore(s, f.t);
      if (!motion) continue;
      const maxL = leads[leads.length - 1];
      const m1 = simulateStorm(f, 1, pushFromMotion(f, motion, P), maxL, { v0: f.wind, params: P, noStop: true });
      const m0 = simulateStorm(f, 1, { u: 0, v: 0 }, maxL, { v0: f.wind, params: P, noStop: true });
      for (const L of leads) {
        const o = obsAt(s, f.t + L);
        if (!o) continue;
        const per = moveEN(f, motion.u * 3.6 * L, motion.v * 3.6 * L);
        sum.model[L] += haversine(o, m1[L]);
        sum.steering[L] += haversine(o, m0[L]);
        sum.persistence[L] += haversine(o, per);
        sum.wModel[L] += Math.abs(m1[L].v - o.wind);
        sum.wPersist[L] += Math.abs(f.wind - o.wind);
        n[L]++;
      }
      if (++cases >= maxCases) break;
    }
    if (cases >= maxCases) break;
  }
  const out = { cases, basin: basin || "all", years: [yearFrom, yearTo], leads: {} };
  for (const L of leads) {
    const k = n[L] || 1;
    out.leads[L] = {
      n: n[L],
      modelKm: Math.round(sum.model[L] / k),
      steeringOnlyKm: Math.round(sum.steering[L] / k),
      persistenceKm: Math.round(sum.persistence[L] / k),
      skillVsPersistencePct: Math.round((1 - sum.model[L] / (sum.persistence[L] || 1)) * 100),
      windModelKt: +(sum.wModel[L] / k).toFixed(1),
      windPersistenceKt: +(sum.wPersist[L] / k).toFixed(1),
      windSkillPct: Math.round((1 - sum.wModel[L] / (sum.wPersist[L] || 1)) * 100),
    };
  }
  return out;
}

export { basinAt };
