// OSM building conversion: heights from tags, closed rings only, tile maths.
import assert from "node:assert/strict";
import { parseLength, buildingHeights, compactBuildings, tileOf, tileBBox, overpassQuery } from "../src/util/osm.js";

assert.equal(parseLength("12"), 12);
assert.equal(parseLength("12.5 m"), 12.5);
assert.equal(parseLength("40'"), 40 * 0.3048);
assert.equal(parseLength("abc"), null);
assert.deepEqual(buildingHeights({ building: "yes", height: "30" }), { h: 30, min: 0 });
assert.deepEqual(buildingHeights({ building: "apartments", "building:levels": "5" }), { h: 16, min: 0 });
assert.deepEqual(buildingHeights({ building: "house" }), { h: 7, min: 0 });
assert.deepEqual(buildingHeights({ building: "yes", height: "20", min_height: "8" }), { h: 20, min: 8 });
assert.equal(buildingHeights({ building: "roof", height: "5" }).min, 3.5);

const sq = (la, lo) => [{ lat: la, lon: lo }, { lat: la, lon: lo + 1e-4 }, { lat: la + 1e-4, lon: lo + 1e-4 }, { lat: la + 1e-4, lon: lo }, { lat: la, lon: lo }];
const rows = compactBuildings({ elements: [
  { type: "way", tags: { building: "yes", "building:levels": "3" }, geometry: sq(40.85, 14.26) },
  { type: "way", tags: { building: "yes" }, geometry: sq(40.85, 14.27).slice(0, 4) }, // open: skipped
  { type: "relation", tags: { building: "office", height: "50" }, members: [{ type: "way", role: "outer", geometry: sq(40.86, 14.26) }, { type: "way", role: "inner", geometry: sq(40.86, 14.26) }] },
] });
assert.equal(rows.length, 2);
assert.equal(rows[0][0], 9.6);
assert.equal(rows[0].length, 2 + 4 * 2);
assert.equal(rows[1][0], 50);

const t = tileOf(40.8518, 14.2681, 15);
const b = tileBBox(15, t.x, t.y);
assert.ok(b.s <= 40.8518 && 40.8518 <= b.n && b.w <= 14.2681 && 14.2681 <= b.e);
assert.match(overpassQuery(15, t.x, t.y), /way\["building"\]\(40\.\d+,14\.\d+,40\.\d+,14\.\d+\)/);
console.log("ok   OSM buildings: heights from tags, closed outer rings, tile bounds and query");
