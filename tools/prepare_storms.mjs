// Compact Atlantic best tracks 1975-2024 (NOAA NHC HURDAT2, as packaged in dplyr's `storms`
// dataset) into src/data/generated/storms.json:
//   [{ n: name, y: year, id, p: [[hoursFromStart, lat, lon, windKt, pressureHpa, r34Km|null], ...] }]
import fs from "node:fs";
const rows = fs.readFileSync("tools/raw/storms.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const byStorm = new Map();
for (const r of rows) {
  const [name, year, month, day, hour, lat, lon, status, cat, wind, pres, tsd] = r;
  const key = `${name}|${year}`;
  if (!byStorm.has(key)) byStorm.set(key, []);
  const t = Date.UTC(+year, +month - 1, +day, +hour);
  byStorm.get(key).push({ t, lat: +lat, lon: +lon, wind: +wind, pres: +pres || null, r34: tsd && tsd !== "NA" ? Math.round((+tsd / 2) * 1.852) : null });
}
const out = [];
for (const [key, pts] of byStorm) {
  pts.sort((a, b) => a.t - b.t);
  // split if a name/year pair holds two storms (gap > 5 days)
  let seg = [pts[0]];
  const flush = () => {
    if (seg.length < 3) return;
    const [n, y] = key.split("|");
    const t0 = seg[0].t;
    out.push({ n, y: +y, id: `${n}-${y}${out.filter((s) => s.n === n && s.y === +y).length ? "b" : ""}`, start: new Date(t0).toISOString().slice(0, 13), p: seg.map((q) => [Math.round((q.t - t0) / 36e5), +q.lat.toFixed(1), +q.lon.toFixed(1), q.wind, q.pres, q.r34]) });
  };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t > 5 * 864e5) { flush(); seg = []; }
    seg.push(pts[i]);
  }
  flush();
}
out.sort((a, b) => a.y - b.y || a.start.localeCompare(b.start));
fs.writeFileSync("src/data/generated/storms.json", JSON.stringify(out));
console.log("storms:", out.length, "points:", out.reduce((a, s) => a + s.p.length, 0), "kB:", (fs.statSync("src/data/generated/storms.json").size / 1024) | 0);
