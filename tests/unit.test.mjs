// Unit tests for engine modules (bundled for Node with the Node DEM loader).
import assert from "node:assert/strict";
import { bundleForNode } from "../tools/node/bundle.mjs";
const E = await bundleForNode("tools/node/unit_entry.js", "build/unit_engine.mjs");
await E.loadDEM();
let n = 0;
const ok = (msg) => { n++; console.log("ok ", msg); };

// geo
{
  const d = E.haversine({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 });
  assert.ok(Math.abs(d - 344) < 3, `London–Paris ${d}`);
  const v = E.ll2v(35.7, 139.7), b = E.v2ll(v);
  assert.ok(Math.abs(b.lat - 35.7) < 1e-9 && Math.abs(b.lon - 139.7) < 1e-9);
  const poly = E.unwrapPoly([{ lat: -10, lon: 170 }, { lat: -10, lon: -170 }, { lat: 10, lon: -170 }, { lat: 10, lon: 170 }]);
  assert.ok(E.pointInPoly({ lat: 0, lon: 179.5 }, poly) && E.pointInPoly({ lat: 0, lon: -179.5 }, poly), "antimeridian polygon");
  ok("geodesy: distances, lat/lon round trip, antimeridian polygons");
}
// sea level scenarios
{
  assert.ok(Math.abs(E.seaRelativeToToday(2026, "ssp245")) < 1e-9);
  assert.ok(E.seaRelativeToToday(2100, "ssp585") > E.seaRelativeToToday(2100, "ssp126"));
  assert.ok(E.seaRelativeToToday(1900, "ssp245") < -0.2);
  ok("IPCC scenarios ordered and anchored at today");
}
// verification / provenance
{
  const calls = [{ name: "flood_impact", input: { meters: 2 }, result: { floodedLandKm2: 3447, affectedCityPopulation: 884000, landKm2: 20000 } }];
  const v = E.verify("At **+2 m**, 3,447 km² floods (17% of land) and 884k people live in affected cities. About 12.5 million tourists visit.", calls);
  const by = Object.fromEntries(v.numbers.map((x) => [x.text, x.status]));
  assert.equal(by["3,447"], "tool");
  assert.equal(by["884k"], "tool");
  assert.equal(by["17%"], "derived");
  assert.equal(by["12.5 million"], "unverified");
  assert.equal(v.unverified.length, 1);
  ok("provenance: direct, derived (ratio %) and untraced numbers classified");
}
// population surface
{
  assert.ok(E.DEM.pop.reduce((a, b) => a + b, 0) > 7.5e9, "world population on the surface");
  ok("population surface sums to ~8 billion");
}
// classifier
{
  const bases = [0, 1, 2].map(() => Float32Array.from({ length: 63 }, () => Math.random() * 2 - 1));
  const X = [], Y = [];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 40; i++) { X.push(bases[k].map((v) => v + (Math.random() - 0.5) * 0.3)); Y.push(k); }
  const net = new E.MLP(63, 48, 3);
  assert.ok(net.train(X, Y, { epochs: 60 }) > 0.95);
  ok("gesture network trains");
}
// storms
{
  const k = E.findStorm("Katrina", 2005);
  assert.ok(k && Math.max(...k.p.map((q) => q[3])) >= 150, "Katrina peak ≥ 150 kt");
  const r = E.replay(k);
  assert.ok(r.errors[24] < 400, "Katrina 24 h error reasonable");
  const s = E.skill({ yearFrom: 2015, yearTo: 2024 });
  assert.ok(s.leads[72].skillVsPersistencePct > 0, `model beats persistence at 72 h on held-out storms (${s.leads[72].skillVsPersistencePct}%)`);
  const ens = E.stormEnsemble({ lat: 15, lon: -50 }, 3, { u: 0, v: 0 }, 20);
  assert.equal(ens.tracks.length, 20);
  assert.ok(ens.cities.every((c) => c.pHurricaneForce <= c.pStormForce + 1e-9));
  ok(`storm model: Katrina replay, held-out 72 h skill ${s.leads[72].skillVsPersistencePct}%, ensemble probabilities consistent`);
}
// places
{
  assert.equal(E.findCity("naples").cc, "IT");
  assert.ok(E.CITIES.length > 4000);
  ok("city lookup");
}
console.log(`${n} unit test groups passed`);
