// Mock backend for end-to-end tests: serves the built app and stands in for Claude, the terrain
// tiles and the live hazard feeds, so every code path can run without network access.
import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import { PNG } from "pngjs";

const PORT = +(process.argv[2] || 8777);
// imagery source for mock basemap tiles: the 4096 x 2048 world image, decoded once
import jpeg from "jpeg-js";
const earthImg = jpeg.decode(fs.readFileSync("assets/earth.jpg"), { useTArray: true });
const LEVEL_TINT = [[255, 80, 80], [255, 160, 0], [255, 230, 0], [80, 220, 80], [0, 200, 255], [120, 120, 255], [220, 100, 255]];
function imageryTile(z, x, y) {
  const png = new PNG({ width: 256, height: 256 });
  const tint = LEVEL_TINT[z % LEVEL_TINT.length];
  for (let py = 0; py < 256; py++) {
    const n = Math.PI - (2 * Math.PI * (y + (py + 0.5) / 256)) / 2 ** z;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    const sy = Math.min(earthImg.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * earthImg.height)));
    for (let px = 0; px < 256; px++) {
      const lon = ((x + (px + 0.5) / 256) / 2 ** z) * 360 - 180;
      const sx = Math.min(earthImg.width - 1, Math.floor(((lon + 180) / 360) * earthImg.width));
      const si = (sy * earthImg.width + sx) * 4, o = (py * 256 + px) * 4;
      const edge = px < 2 || py < 2;
      const fine = z >= 6 && (px % 32 === 0 || py % 32 === 0);
      for (let c = 0; c < 3; c++) png.data[o + c] = edge ? tint[c] : fine ? Math.min(255, earthImg.data[si + c] * 0.7 + tint[c] * 0.3) : earthImg.data[si + c];
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
const tilesServed = { imagery: 0, terrain: 0, maxZ: 0, failed: 0 };
const flaky = new Set();
const dem = PNG.sync.read(fs.readFileSync("assets/dem.png"));
const W = dem.width, H = dem.height;
function demRaw(xi, yi) {
  const x = ((xi % W) + W) % W, y = Math.min(H - 1, Math.max(0, yi));
  const i = (y * W + x) * 4;
  return dem.data[i + 2] < 64 ? -40 : ((dem.data[i] * 256 + dem.data[i + 1]) / 65535) * 9500 - 500;
}
function elevAt(lat, lon) {
  // bilinear DEM plus smooth multi-scale relief, so mock terrain shades like real terrain
  const fx = ((lon + 180) / 360) * W - 0.5, fy = ((90 - lat) / 180) * H - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const e = (demRaw(x0, y0) * (1 - tx) + demRaw(x0 + 1, y0) * tx) * (1 - ty) + (demRaw(x0, y0 + 1) * (1 - tx) + demRaw(x0 + 1, y0 + 1) * tx) * ty;
  if (e <= 0) return e;
  const r = (Math.sin(lat * 37) * Math.cos(lon * 41) + 0.5 * Math.sin(lat * 151 + 1) * Math.cos(lon * 139)) * Math.min(1, e / 400);
  return e + 60 * r + 8;
}
function tile(z, x, y) {
  const png = new PNG({ width: 256, height: 256 });
  for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
    const lon = ((x + px / 256) / 2 ** z) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * (y + py / 256)) / 2 ** z;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    const v = elevAt(lat, lon) + 32768;
    const o = (py * 256 + px) * 4;
    png.data[o] = Math.floor(v / 256); png.data[o + 1] = Math.floor(v % 256); png.data[o + 2] = Math.floor((v % 1) * 256); png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const log = [];
function claudeReply(body) {
  const msgs = body.messages;
  const first = typeof msgs[0].content === "string" ? msgs[0].content : "";
  if (first.includes("fact-checker")) {
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Miami's surge peak floods **PEAK_KM2 km²** with up to **PEAK_PEOPLE** people in flooded cells.\nSources: Terra DEM, population surface." }] };
  }
  const round = msgs.filter((m) => m.role === "assistant").length;
  if (round === 0) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "a1", name: "geocode", input: { query: "Miami" } }] };
  if (round === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "a2", name: "simulate_surge", input: { lat: 25.77, lon: -80.19, surgeM: 3, hours: 24 } }] };
  if (round === 2) {
    // build an answer from the surge result, plus one invented number for the critic to catch
    const res = JSON.parse(msgs[msgs.length - 1].content[0].content);
    globalThis.PEAK = res;
    return { stop_reason: "end_turn", content: [{ type: "text", text: `A 3 m surge at Miami peaks at hour ${res.peakHour}, flooding **${res.peakFloodedKm2} km²** with **${res.peakPeopleInFloodedCells.toLocaleString()}** people in flooded cells. About 12.5 million tourists visit each year.\nSources: Terra DEM.` }] };
  }
  return { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
}

const storms = { storms: [{ id: "al052026", name: "Testa", classification: "HU", windKt: 105, pressureHpa: 958, lat: 24.5, lon: -72, movement: { dirDeg: 300, speedMph: 12 }, cone: [{ type: "Feature", properties: { name: "Cone" }, geometry: { type: "Polygon", coordinates: [[[-72, 24.5], [-77, 28], [-79, 31], [-75, 31], [-72, 24.5]]] } }], track: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-72, 24.5], [-75, 27], [-77, 30]] } }] }], source: "mock NHC" };
const fires = { count: 3, fires: [[37.5, -120.5, 300, "h"], [-3.1, -60, 80, "n"], [61, 129, 40, "n"]], source: "mock FIRMS" };
const quakes = { features: [{ properties: { mag: 6.1, place: "mock quake, Japan" }, geometry: { coordinates: [142.4, 38.3, 30] } }] };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/api/health") return json({ ok: true, claude: true });
  if (u.pathname === "/api/claude") {
    let b = ""; for await (const c of req) b += c;
    const body = JSON.parse(b);
    let reply = claudeReply(body);
    if (reply.content[0]?.text?.includes("PEAK_")) {
      const p = globalThis.PEAK || {};
      reply.content[0].text = reply.content[0].text.replace("PEAK_KM2", String(p.peakFloodedKm2)).replace("PEAK_PEOPLE", (p.peakPeopleInFloodedCells || 0).toLocaleString());
    }
    log.push({ round: body.messages.length, critic: String(body.messages[0].content).includes("fact-checker") });
    fs.writeFileSync("build/mock-claude.log", JSON.stringify(log));
    return json(reply);
  }
  let m = u.pathname.match(/^\/api\/terrain\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (m) { tilesServed.terrain++; res.writeHead(200, { "content-type": "image/png" }); return res.end(tile(+m[1], +m[2], +m[3])); }
  m = u.pathname.match(/^\/api\/tiles\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)$/);
  if (m) {
    // Simulate a flaky provider: some tiles always fail, some fail on the first attempt only.
    const [z, x, y] = [+m[2], +m[3], +m[4]], k = `${z}/${x}/${y}`;
    if (z >= 3 && (x * 7 + y * 3) % 11 === 0) { tilesServed.failed++; res.writeHead(502); return res.end("upstream down"); }
    if (z >= 3 && (x + y) % 7 === 0 && !flaky.has(k)) { flaky.add(k); tilesServed.failed++; res.writeHead(503); return res.end("busy"); }
  }
  if (m) { tilesServed.imagery++; tilesServed.maxZ = Math.max(tilesServed.maxZ, +m[2]); res.writeHead(200, { "content-type": "image/png" }); return res.end(imageryTile(+m[2], +m[3], +m[4])); }
  if (u.pathname === "/__tiles") return json(tilesServed);
  if (u.pathname === "/api/live/storms") return json(storms);
  if (u.pathname === "/api/live/fires") return json(fires);
  if (u.pathname === "/api/live/quakes") return json(quakes);
  if (u.pathname.startsWith("/api/")) return json({ error: "offline in mock" }, 502);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync("dist/index.html"));
}).listen(PORT, () => console.log("mock on", PORT));
