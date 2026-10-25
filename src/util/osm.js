// OpenStreetMap buildings: Overpass query for a map tile and conversion of its answer into a compact
// list of footprints with heights. Shared by the browser (direct Overpass on the static site) and the
// local server (/api/buildings, cached), so both produce the same buildings.

export const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

export function tileBBox(z, x, y) {
  const n = 2 ** z;
  const lon0 = (x / n) * 360 - 180, lon1 = ((x + 1) / n) * 360 - 180;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return { s: lat(y + 1), w: lon0, n: lat(y), e: lon1 };
}

export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

export function overpassQuery(z, x, y) {
  const b = tileBBox(z, x, y);
  const bb = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  return `[out:json][timeout:25];(way["building"](${bb});relation["building"]["type"="multipolygon"](${bb}););out geom qt;`;
}

// "12", "12 m", "12.5m", "40'", "40 ft" -> metres
export function parseLength(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(",", ".");
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|')?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  return m[2] && /ft|feet|'/.test(m[2]) ? n * 0.3048 : n;
}

const TYPE_HEIGHT = {
  house: 7, detached: 7, semidetached_house: 7, terrace: 8, residential: 9, bungalow: 4, cabin: 4, hut: 3, shed: 3, garage: 3, garages: 3, carport: 3, roof: 4,
  apartments: 15, dormitory: 15, hotel: 24, office: 20, commercial: 14, retail: 7, supermarket: 8, kiosk: 3,
  industrial: 10, warehouse: 10, factory: 12, hangar: 12, church: 16, cathedral: 30, mosque: 16, temple: 12,
  school: 10, university: 14, hospital: 20, train_station: 14, stadium: 25, public: 12, civic: 12, government: 15,
};
const LEVEL_M = 3.2;

export function buildingHeights(tags = {}) {
  let h = parseLength(tags.height);
  const levels = parseFloat(tags["building:levels"]);
  if (h == null && isFinite(levels) && levels > 0) h = levels * LEVEL_M + (parseLength(tags["roof:height"]) || 0);
  if (h == null) h = TYPE_HEIGHT[tags.building] ?? 8;
  let min = parseLength(tags.min_height);
  const minLevel = parseFloat(tags["building:min_level"]);
  if (min == null && isFinite(minLevel) && minLevel > 0) min = minLevel * LEVEL_M;
  if (tags.building === "roof" && min == null) min = Math.max(0, h - 1.5);
  h = Math.min(830, Math.max(2, h));
  min = Math.max(0, Math.min(h - 1, min || 0));
  return { h: Math.round(h * 10) / 10, min: Math.round(min * 10) / 10 };
}

// Overpass JSON -> [[height, minHeight, lat, lon, lat, lon, ...], ...] (outer rings, open, >= 3 points)
export function compactBuildings(json) {
  const out = [];
  const push = (tags, geom) => {
    if (!geom || geom.length < 4) return;
    const closed = geom[0].lat === geom[geom.length - 1].lat && geom[0].lon === geom[geom.length - 1].lon;
    if (!closed) return; // a multipolygon outer split across several ways; skipped rather than guessed
    const pts = geom.slice(0, -1);
    const { h, min } = buildingHeights(tags);
    const row = [h, min];
    for (const p of pts) row.push(Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6);
    out.push(row);
  };
  for (const el of json?.elements || []) {
    if (el.type === "way") push(el.tags, el.geometry);
    else if (el.type === "relation") for (const m of el.members || []) if (m.role === "outer" && m.type === "way") push(el.tags, m.geometry);
  }
  return out;
}
