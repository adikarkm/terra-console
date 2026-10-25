// Wind model (no rendering): live GFS grid when loaded, otherwise a physically based
// climatology. sample(lat, lon) -> {u, v} m/s (u east, v north). Pure, so Node tools can use it.
import { DEG } from "../util/geo.js";

// Subtropical highs (anticyclones) that steer storms around their flanks.
const HIGHS = [
  { lat: 32, lon: -45, r: 22, a: 7 }, // Azores–Bermuda
  { lat: 34, lon: -150, r: 24, a: 7 }, // North Pacific
  { lat: -29, lon: -12, r: 20, a: 6 }, // St Helena (S Atlantic)
  { lat: -32, lon: -100, r: 24, a: 6 }, // South Pacific
  { lat: -31, lon: 78, r: 24, a: 6 }, // Mascarene (Indian Ocean)
];

export function climatology(lat, lon) {
  const a = Math.abs(lat);
  // zonal mean flow of the deep tropospheric layer (approx. 500-850 hPa)
  let u = -7 * Math.exp(-(((a - 10) / 12) ** 2)) + 16 * Math.exp(-(((a - 45) / 13) ** 2)) - 3 * Math.exp(-(((a - 80) / 8) ** 2));
  let v = 0;
  for (const h of HIGHS) {
    let dlon = lon - h.lon;
    if (dlon > 180) dlon -= 360;
    if (dlon < -180) dlon += 360;
    const dx = dlon * Math.cos(lat * DEG), dy = lat - h.lat;
    const r = Math.hypot(dx, dy);
    if (r > h.r * 3) continue;
    const s = h.a * (r / h.r) * Math.exp(0.5 * (1 - (r / h.r) ** 2)); // Rankine-like vortex profile
    const sign = h.lat > 0 ? -1 : 1; // clockwise in NH, counter-clockwise in SH
    if (r > 1e-3) {
      u += sign * s * (-dy / r);
      v += sign * s * (dx / r);
    }
  }
  return { u, v };
}

export const Wind = {
  source: "climatology",
  grid: null, // { lat0, lon0, dlat, dlon, nlat, nlon, u:Float32Array, v:Float32Array, time, level }
  sample(lat, lon) {
    const g = this.grid;
    if (!g) return climatology(lat, lon);
    const fy = (lat - g.lat0) / g.dlat;
    let fx = (lon - g.lon0) / g.dlon;
    fx = ((fx % g.nlon) + g.nlon) % g.nlon;
    const y0 = Math.max(0, Math.min(g.nlat - 2, Math.floor(fy)));
    const x0 = Math.floor(fx), x1 = (x0 + 1) % g.nlon;
    const ty = Math.max(0, Math.min(1, fy - y0)), tx = fx - x0;
    const at = (arr, y, x) => arr[y * g.nlon + x];
    const bil = (arr) =>
      (at(arr, y0, x0) * (1 - tx) + at(arr, y0, x1) * tx) * (1 - ty) + (at(arr, y0 + 1, x0) * (1 - tx) + at(arr, y0 + 1, x1) * tx) * ty;
    return { u: bil(g.u), v: bil(g.v) };
  },
};

