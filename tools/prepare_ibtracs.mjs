// Global tropical cyclone best tracks (NOAA IBTrACS v04, all basins since 1980) -> compact
// src/data/generated/storms.json used for replay, calibration and validation.
//
//   node tools/prepare_ibtracs.mjs tools/raw/ibtracs.since1980.list.v04r01.csv
//
// Kept: main tracks (not spurs) of storms that reached tropical-storm strength (34 kt), at the
// 6-hourly synoptic times. Wind is the 1-minute sustained wind from the US agencies (NHC, CPHC,
// JTWC), which cover every basin; where that is missing, the WMO agency's 10-minute wind is
// converted to 1-minute (/0.88). R34 is the mean of the four USA quadrant radii.
// Output: { v: 2, source, basins, s: [[name, year, basin, sid, startIso, h,lat10,lon10,kt,hPa,r34km, h,...], ...] }
import fs from "node:fs";
import readline from "node:readline";

const file = process.argv[2] || "tools/raw/ibtracs.since1980.list.v04r01.csv";
if (!fs.existsSync(file)) {
  console.error(`missing ${file}\nDownload it from https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/`);
  process.exit(1);
}

// CSV line splitter (IBTrACS has no embedded commas in practice, but quoted fields are handled)
function split(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const num = (s) => { const t = (s ?? "").trim(); if (!t) return null; const v = +t; return isFinite(v) ? v : null; };

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
let H = null, line = 0;
const storms = new Map();
for await (const raw of rl) {
  line++;
  if (!H) { H = Object.fromEntries(split(raw).map((k, i) => [k.trim(), i])); continue; }
  if (line === 2) continue; // units row
  const f = split(raw);
  const g = (k) => f[H[k]];
  if ((g("TRACK_TYPE") || "").trim() !== "main") continue;
  const time = (g("ISO_TIME") || "").trim();
  const hour = +time.slice(11, 13), minute = +time.slice(14, 16);
  if (hour % 6 || minute) continue; // synoptic times only (the 3-hourly points are interpolated)
  const sid = g("SID").trim();
  let wind = num(g("USA_WIND"));
  if (wind == null) { const w = num(g("WMO_WIND")); wind = w == null ? null : Math.round(w / 0.88); }
  const pres = num(g("USA_PRES")) ?? num(g("WMO_PRES"));
  const r34q = ["USA_R34_NE", "USA_R34_SE", "USA_R34_SW", "USA_R34_NW"].map((k) => num(g(k))).filter((v) => v != null && v > 0);
  const r34 = r34q.length ? Math.round((r34q.reduce((a, b) => a + b, 0) / r34q.length) * 1.852) : null;
  const lat = num(g("LAT")), lon = num(g("LON"));
  if (lat == null || lon == null) continue;
  if (!storms.has(sid)) {
    const name = g("NAME").trim();
    storms.set(sid, { sid, name: name === "NOT_NAMED" || name === "UNNAMED" || !name ? "Unnamed" : name[0] + name.slice(1).toLowerCase(), year: +g("SEASON"), basin: g("BASIN").trim() || "NA", pts: [] });
  }
  storms.get(sid).pts.push({ t: Date.parse(time.replace(" ", "T") + "Z"), lat, lon: ((lon + 540) % 360) - 180, wind, pres, r34 });
}

const out = [];
const basins = {};
for (const s of storms.values()) {
  const pts = s.pts.filter((p) => p.wind != null);
  if (pts.length < 3 || Math.max(...pts.map((p) => p.wind)) < 34) continue;
  const t0 = pts[0].t;
  const row = [s.name, s.year, s.basin, s.sid, new Date(t0).toISOString().slice(0, 13)];
  for (const p of pts) row.push(Math.round((p.t - t0) / 36e5), Math.round(p.lat * 10), Math.round(p.lon * 10), Math.round(p.wind), p.pres == null ? 0 : Math.round(p.pres), p.r34 ?? 0);
  out.push(row);
  basins[s.basin] = (basins[s.basin] || 0) + 1;
}
out.sort((a, b) => a[4].localeCompare(b[4]));
fs.writeFileSync("src/data/generated/storms.json", JSON.stringify({ v: 2, source: "NOAA NCEI IBTrACS v04r01 (since 1980)", basins, s: out }));
const pts = out.reduce((a, r) => a + (r.length - 5) / 6, 0);
console.log(`storms: ${out.length} (${Object.entries(basins).map(([b, n]) => `${b} ${n}`).join(", ")}), points: ${pts}, ${(fs.statSync("src/data/generated/storms.json").size / 1024) | 0} kB`);
