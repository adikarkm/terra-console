// Fit the hurricane model's steering factor, beta drift and motion-memory time scale to
// 1980-2014 Atlantic best tracks (minimising mean 48 h track error), then report skill on the
// held-out 2015-2024 seasons. Writes build/storm_calibration.json.
//   node tools/calibrate_storms.mjs           full grid search
//   node tools/calibrate_storms.mjs --report  only report skill with the current parameters
import fs from "node:fs";
import { bundleForNode } from "./node/bundle.mjs";
const E = await bundleForNode("tools/node/storm_entry.js", "build/storm_engine.mjs");
await E.loadDEM();
const base = { ...E.STORM_PARAMS };
const report = (p, label) => {
  const tr = E.skill({ params: p, yearFrom: 1980, yearTo: 2014, step: 12 });
  const te = E.skill({ params: p, yearFrom: 2015, yearTo: 2024, step: 12 });
  console.log(`\n${label}`, JSON.stringify(p));
  for (const [name, r] of [["train 1980-2014", tr], ["test 2015-2024", te]]) {
    console.log(`  ${name}: ${r.cases} forecasts`);
    for (const [L, v] of Object.entries(r.leads)) console.log(`    ${L} h: model ${v.modelKm} km | steering only ${v.steeringOnlyKm} km | persistence ${v.persistenceKm} km | skill vs persistence ${v.skillVsPersistencePct}%`);
  }
  return { train: tr, test: te };
};
const before = report(base, "Current parameters");
if (process.argv.includes("--report")) process.exit(0);
let best = { err: Infinity, p: base };
const t0 = Date.now();
for (const steer of [0.3, 0.45, 0.6, 0.75, 0.9])
  for (const betaV of [0.5, 1.0, 1.5, 2.0])
    for (const betaU of [-1.5, -0.75, 0, 0.75])
      for (const tau of [24, 48, 96, 192]) {
        const p = { ...base, steer, betaV, betaU, tau };
        const r = E.skill({ params: p, yearFrom: 1980, yearTo: 2014, step: 24, leads: [48] });
        const err = r.leads[48].modelKm;
        if (err < best.err) { best = { err, p }; process.stdout.write(`\r  best 48 h error ${err} km  ${JSON.stringify({ steer, betaV, betaU, tau })}      `); }
      }
console.log(`\n  search took ${((Date.now() - t0) / 1000) | 0} s`);
const after = report(best.p, "Fitted parameters");
fs.writeFileSync("build/storm_calibration.json", JSON.stringify({ fitted: best.p, before, after, date: new Date().toISOString() }, null, 2));
