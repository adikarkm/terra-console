// Cities (GeoNames, population >= 100k) and countries (Natural Earth 1:110m).
import CITY_ROWS from "./generated/cities.json";
import WORLD from "./generated/countries.json";
import { feature } from "topojson-client";
import { haversine, pointInPoly, unwrapPoly } from "../util/geo.js";

export const CITIES = CITY_ROWS.map(([name, cc, lat, lon, pop, elev, est]) => ({ name, cc, lat, lon, pop, elev, est: !!est }));

const fc = feature(WORLD, WORLD.objects.countries);
export const COUNTRIES = fc.features.map((f) => {
  const polys = f.geometry ? (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) : [];
  const rings = polys.map((p) => unwrapPoly(p[0].map(([lon, lat]) => ({ lat, lon }))));
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const r of rings) for (const p of r) { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon); }
  return { id: f.id, name: f.properties.name, rings, polys, bbox: [a, b, c, d], feature: f };
});

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const byName = new Map();
for (const c of CITIES) {
  const k = norm(c.name);
  if (!byName.has(k)) byName.set(k, c); // already sorted by population: keep the largest
}

export function findCity(q) {
  const k = norm(q.replace(/[,.].*$/, ""));
  if (!k) return null;
  if (byName.has(k)) return byName.get(k);
  for (const c of CITIES) if (norm(c.name).startsWith(k)) return c;
  return null;
}

export function findCountry(q) {
  const k = norm(q);
  return COUNTRIES.find((c) => norm(c.name) === k) || COUNTRIES.find((c) => norm(c.name).startsWith(k)) || null;
}

export function countryAt(lat, lon) {
  for (const c of COUNTRIES) {
    const [a, b] = c.bbox;
    if (lat < a || lat > b) continue;
    for (const r of c.rings) if (pointInPoly({ lat, lon }, r)) return c;
  }
  return null;
}

export function citiesInPoly(poly, limit = 50) {
  const up = unwrapPoly(poly);
  const out = [];
  for (const c of CITIES) {
    if (pointInPoly(c, up)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function citiesNear(p, km, limit = 50) {
  const out = [];
  for (const c of CITIES) {
    const d = haversine(p, c);
    if (d <= km) out.push({ ...c, distKm: d });
  }
  out.sort((a, b) => b.pop - a.pop);
  return out.slice(0, limit);
}

export function nearestCity(p) {
  let best = null, bd = Infinity;
  for (const c of CITIES) {
    const d = haversine(p, c);
    if (d < bd) { bd = d; best = c; }
  }
  return best ? { ...best, distKm: bd } : null;
}

export function countriesInPoly(poly) {
  const up = unwrapPoly(poly);
  const hits = new Map();
  for (const c of CITIES) if (pointInPoly(c, up)) hits.set(c.cc, (hits.get(c.cc) || 0) + c.pop);
  // also test country label points (first ring vertex mean) for city-less areas
  const names = [];
  for (const co of COUNTRIES) {
    for (const r of co.rings) {
      let la = 0, lo = 0;
      for (const p of r) { la += p.lat; lo += p.lon; }
      if (pointInPoly({ lat: la / r.length, lon: lo / r.length }, up)) { names.push(co.name); break; }
    }
  }
  return { byCityCode: [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([cc, pop]) => ({ cc, cityPop: pop })), names };
}
