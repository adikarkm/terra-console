// Physics checks for the shallow-water engine (CPU code path, run in a Node worker shim).
import assert from "node:assert/strict";
import { WORKER_SRC } from "../build/test_swe_src.mjs";
function makeEngine() {
  const ctx = { postMessage: (m) => ctx.out.push(m), out: [], performance };
  new Function("self", "postMessage", "performance", WORKER_SRC + "\nself.onmessage = onmessage;")(ctx, ctx.postMessage, performance);
  const send = (m) => { ctx.out = []; ctx.onmessage({ data: m }); return ctx.out.pop(); };
  let t = 0;
  // advance until simulated time reaches t + seconds (the worker yields every ~120 ms of wall time)
  const run = (seconds, forcing) => { const target = t + seconds; let r; do { r = send({ type: "advance", seconds: target - t, forcing }); t = r.t; } while (t < target - 1e-6); return r; };
  return { send, run };
}
function grid(W, H, zfn, oceanfn) {
  const z = new Float32Array(W * H), ocean = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { z[j * W + i] = zfn(i, j); ocean[j * W + i] = oceanfn(i, j) ? 1 : 0; }
  return { W, H, z, ocean, dxRow: new Float32Array(H).fill(100), dy: 100 };
}
const F = (sea, surge = 0) => ({ sea, surge, tPeakH: 6, sigmaH: 2, tide: 0 });

// 1. still water stays still (no spurious flow on flat dry land, sea below)
{
  const g = grid(40, 20, (i) => (i < 5 ? -5 : 2), (i) => i < 5);
  const e = makeEngine(); e.send({ type: "init", ...g });
  const r = e.run(3600, F(0));
  const wet = [...r.h].filter((d, k) => !g.ocean[k] && d > 0.001).length;
  assert.equal(wet, 0, "land above sea must stay dry");
  console.log("ok  still water: land at +2 m stays dry with sea at 0 m");
}
// 2. sea rise floods low land connected to the sea, not land behind a dyke
{
  const g = grid(60, 10, (i) => (i < 5 ? -5 : i === 30 ? 6 : 1), (i) => i < 5);
  const e = makeEngine(); e.send({ type: "init", ...g });
  const r = e.run(6 * 3600, F(2));
  const front = r.h[5 * 60 + 20], behind = r.h[5 * 60 + 45];
  assert.ok(Math.abs(front - 1) < 0.15, `cell in front of the dyke should be ~1 m deep, got ${front}`);
  assert.ok(behind < 0.01, `cell behind a 6 m dyke must stay dry, got ${behind}`);
  console.log(`ok  sea +2 m: front of dyke ${front.toFixed(2)} m deep, behind dyke ${behind.toFixed(3)} m`);
}
// 3. surge pulse floods inland then drains back (water returns to the sea)
{
  const g = grid(80, 10, (i) => (i < 5 ? -5 : 0.2 + i * 0.02), (i) => i < 5);
  const e = makeEngine(); e.send({ type: "init", ...g });
  const atPeak = e.run(6 * 3600, F(0, 1.5));
  const wetPeak = [...atPeak.h].filter((d, k) => !g.ocean[k] && d > 0.05).length;
  const later = e.run(30 * 3600, F(0, 1.5));
  const wetLater = [...later.h].filter((d, k) => !g.ocean[k] && d > 0.05).length;
  assert.ok(wetPeak > 100, `surge should flood inland, wet cells ${wetPeak}`);
  assert.ok(wetLater < wetPeak * 0.5, `water should drain after the surge, ${wetLater} vs ${wetPeak}`);
  console.log(`ok  surge: ${wetPeak} wet cells at peak, ${wetLater} after draining`);
}
// 4. mass conservation: a sea pulse fills a closed lagoon over a sill; after the pulse the lagoon
//    keeps the water above its sill (it cannot drain), and depths never go negative
{
  const g = grid(60, 12, (i) => (i < 5 ? -5 : i < 20 ? 0.5 : i === 20 ? 1.2 : -1), (i) => i < 5);
  const e = makeEngine(); e.send({ type: "init", ...g });
  e.run(6 * 3600, F(0, 2.5));
  const end = e.run(40 * 3600, F(0, 2.5));
  const lagoon = end.h[6 * 60 + 40];
  assert.ok(lagoon > 1.5 && lagoon < 2.4, `lagoon should hold water up to about its sill (~2.2 m deep), got ${lagoon}`);
  assert.ok([...end.h].every((d) => d >= 0), "no negative depths");
  console.log(`ok  closed lagoon keeps ${lagoon.toFixed(2)} m after the surge passes (sill at +1.2 m, floor at -1 m)`);
}
console.log("swe tests passed");
