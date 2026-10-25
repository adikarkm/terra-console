// Fit the hurricane model per ocean basin on 1980-2014 best tracks (IBTrACS), then report skill on
// the held-out seasons 2015 onward. Two stages per basin:
//   1. track: steering factor, beta drift and motion memory, minimising mean 48 h track error
//   2. intensity: potential-intensity curve and relaxation times, minimising mean 48 h wind error
// Writes src/sim/storm_params.json (used by the model) and build/storm_calibration.json (report).
//   node tools/calibrate_storms.mjs           fit and report
//   node tools/calibrate_storms.mjs --report  only report skill with the current parameters
import fs from "node:fs";
import { bundleForNode } from "./node/bundle.mjs";
const E = await bundleForNode("tools/node/storm_entry.js", "build/storm_engine.mjs");
await E.loadDEM();
await E.loadStorms();
const S = E.storms();
const lastYear = Math.max(...S.map((s) => s.y));
const TRAIN = [1980, 2014], TEST = [2015, lastYear];
const basins = Object.keys(E.BASINS).filter((b) => S.filter((s) => s.b === b && s.y <= TRAIN[1]).length >= 15);
console.log(`${S.length} storms (${STORMDATA_SOURCE()}), ${lastYear} latest; fitting basins: ${basins.join(", ")}`);
function STORMDATA_SOURCE() { return E.STORMDATA.source; }

const fmt = (r) => Object.entries(r.leads).map(([L, v]) => `${L} h: track ${v.modelKm} km (persistence ${v.persistenceKm}, ${v.skillVsPersistencePct > 0 ? "+" : ""}${v.skillVsPersistencePct}%) · wind ${v.windModelKt} kt (persistence ${v.windPersistenceKt}, ${v.windSkillPct > 0 ? "+" : ""}${v.windSkillPct}%)`).join("\n      ");
const reportOnly = process.argv.includes("--report");

const fitted = { global: { ...E.STORM_PARAMS }, basins: {} };
const report = { train: TRAIN, test: TEST, basins: {}, date: new Date().toISOString(), source: E.STORMDATA.source };
const t0 = Date.now();

for (const b of basins) {
  const nTrain = S.filter((s) => s.b === b && s.y >= TRAIN[0] && s.y <= TRAIN[1]).length;
  const every = Math.max(1, Math.round(nTrain / 260)); // a few hundred storms per basin keep the search quick
  let best = { ...E.paramsFor(b) };
  if (!reportOnly) {
    const fit = (grid, key) => {
      let bestErr = Infinity, bestP = best;
      for (const p of grid) {
        const P = { ...best, ...p };
        const r = E.skill({ params: P, basin: b, yearFrom: TRAIN[0], yearTo: TRAIN[1], step: 24, leads: [48], every });
        const err = r.leads[48][key];
        if (err < bestErr) { bestErr = err; bestP = P; }
      }
      return bestP;
    };
    const trackGrid = [];
    for (const steer of [0.3, 0.45, 0.6, 0.75, 0.9]) for (const betaV of [0.5, 1, 1.5, 2]) for (const betaU of [-1.5, -0.75, 0, 0.75]) for (const tau of [24, 48, 96, 192]) trackGrid.push({ steer, betaV, betaU, tau });
    best = fit(trackGrid, "modelKm");
    const windGrid = [];
    for (const mpiMax of [90, 105, 120, 140]) for (const mpiLat0 of [12, 17, 22]) for (const mpiLat1 of [35, 42, 50]) for (const tauI of [36, 72, 144, 240]) for (const tauW of [12, 24, 48]) windGrid.push({ mpiMax, mpiLat0, mpiLat1, tauI, tauW });
    best = fit(windGrid, "windModelKt");
    fitted.basins[b] = Object.fromEntries(["steer", "betaU", "betaV", "tau", "mpiMax", "mpiLat0", "mpiLat1", "tauI", "tauW"].map((k) => [k, best[k]]));
  }
  const tr = E.skill({ params: best, basin: b, yearFrom: TRAIN[0], yearTo: TRAIN[1] });
  const te = E.skill({ params: best, basin: b, yearFrom: TEST[0], yearTo: TEST[1] });
  report.basins[b] = { name: E.BASINS[b], params: fitted.basins[b] || null, train: tr, test: te };
  console.log(`\n${b} ${E.BASINS[b]} (${((Date.now() - t0) / 1000) | 0} s)\n  train ${tr.cases} forecasts\n      ${fmt(tr)}\n  test ${te.cases} forecasts\n      ${fmt(te)}`);
}

if (!reportOnly) {
  fs.writeFileSync("src/sim/storm_params.json", JSON.stringify(fitted, null, 1));
  console.log("\nwrote src/sim/storm_params.json");
}
fs.writeFileSync("build/storm_calibration.json", JSON.stringify(report, null, 1));
console.log(`wrote build/storm_calibration.json in ${((Date.now() - t0) / 1000) | 0} s`);
