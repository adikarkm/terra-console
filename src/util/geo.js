// Geodesy helpers. Convention: lat/lon in degrees; globe-local unit sphere where
// the equirectangular texture maps exactly as three.js SphereGeometry lays out UVs.
import * as THREE from "three";

export const R_EARTH = 6371;
export const DEG = Math.PI / 180;

// WGS84 ellipsoid in units of the equatorial radius. Globe-local axes: +x = (0°N, 0°E),
// +y = north pole, -z = (0°N, 90°E). ll2v/v2ll use geodetic latitude so everything lines up with
// the streamed imagery and terrain tiles, which sit on the true ellipsoid.
export const WGS84_E2 = 0.00669437999014;
export const WGS84_B = 0.9966471893352525; // polar / equatorial radius
const EP2 = WGS84_E2 / (1 - WGS84_E2);

export function ll2v(lat, lon, r = 1, target = new THREE.Vector3()) {
  const phi = lat * DEG, lam = lon * DEG;
  const s = Math.sin(phi), c = Math.cos(phi);
  const N = 1 / Math.sqrt(1 - WGS84_E2 * s * s);
  const X = N * c * Math.cos(lam), Y = N * c * Math.sin(lam), Z = N * (1 - WGS84_E2) * s;
  return target.set(X * r, Z * r, -Y * r);
}

export function v2ll(v) {
  const X = v.x, Y = -v.z, Z = v.y;
  const p = Math.hypot(X, Y);
  const lon = Math.atan2(Y, X) / DEG;
  // Bowring's formula (sub-millimetre for points near the surface)
  const th = Math.atan2(Z, p * WGS84_B);
  const st = Math.sin(th), ct = Math.cos(th);
  const lat = Math.atan2(Z + EP2 * WGS84_B * st * st * st, p - WGS84_E2 * ct * ct * ct) / DEG;
  return { lat, lon };
}

// move a sphere geometry's vertices onto the ellipsoid at the lat/lon its UVs represent
export function geometryToEllipsoid(geo, r = 1) {
  const pos = geo.attributes.position, uv = geo.attributes.uv, nor = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const lat = (uv.getY(i) - 0.5) * 180, lon = uv.getX(i) * 360 - 180;
    ll2v(lat, lon, r, v);
    pos.setXYZ(i, v.x, v.y, v.z);
    if (nor) {
      const phi = lat * DEG, lam = lon * DEG;
      nor.setXYZ(i, Math.cos(phi) * Math.cos(lam), Math.sin(phi), -Math.cos(phi) * Math.sin(lam));
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function unwrapLon(lon, ref) {
  let d = lon - ref;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return ref + d;
}

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * DEG) * Math.cos(b.lat * DEG);
  const x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) - Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lon - a.lon) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

export function destination(p, bearingDeg, km) {
  const d = km / R_EARTH, br = bearingDeg * DEG, la = p.lat * DEG, lo = p.lon * DEG;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / DEG, lon: wrapLon(lo2 / DEG) };
}

// move a point by an east/north displacement in km
export function moveEN(p, eastKm, northKm) {
  const lat = p.lat + (northKm / R_EARTH) / DEG;
  const lon = p.lon + (eastKm / (R_EARTH * Math.max(0.05, Math.cos(p.lat * DEG)))) / DEG;
  return { lat: Math.max(-89.5, Math.min(89.5, lat)), lon: wrapLon(lon) };
}

// polygon: [{lat,lon}] — returns polygon with lon unwrapped around its first vertex
export function unwrapPoly(poly) {
  const ref = poly[0].lon;
  let prev = ref;
  return poly.map((p) => {
    const lon = unwrapLon(p.lon, prev);
    prev = lon;
    return { lat: p.lat, lon };
  });
}

export function pointInPoly(pt, upoly) {
  const lon = unwrapLon(pt.lon, upoly[0].lon);
  const lat = pt.lat;
  let inside = false;
  for (let i = 0, j = upoly.length - 1; i < upoly.length; j = i++) {
    const xi = upoly[i].lon, yi = upoly[i].lat, xj = upoly[j].lon, yj = upoly[j].lat;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyCentroid(poly) {
  const v = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const p of poly) v.add(ll2v(p.lat, p.lon, 1, t));
  return v2ll(v);
}

export function polyBBox(upoly) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of upoly) {
    a = Math.min(a, p.lat); b = Math.max(b, p.lat);
    c = Math.min(c, p.lon); d = Math.max(d, p.lon);
  }
  return { minLat: a, maxLat: b, minLon: c, maxLon: d };
}

export function circlePoly(center, km, n = 48) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(destination(center, (i / n) * 360, km));
  return out;
}

// distance from point to polyline (km), sampled along segments
export function distToPath(p, path, stepKm = 25) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const L = haversine(a, b);
    const n = Math.max(1, Math.ceil(L / stepKm));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const q = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (unwrapLon(b.lon, a.lon) - a.lon) * t };
      const d = haversine(p, q);
      if (d < best) best = d;
    }
  }
  if (path.length === 1) best = haversine(p, path[0]);
  return best;
}

export function fmtLat(lat) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`;
}
export function fmtLon(lon) {
  return `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}
