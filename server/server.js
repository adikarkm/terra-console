// Terra Console local server.
//   - serves dist/index.html
//   - /api/claude     Anthropic Messages API proxy (keeps your API key off the page)
//   - /api/wind       GFS 500/850 hPa steering winds on a 10° grid (Open-Meteo)
//   - /api/quakes     USGS earthquakes (FDSN event service)
//   - /api/events     NASA EONET open natural events
//   - /api/indicators World Bank population / GDP / GDP per capita / urban share
//   - /api/gibs       NASA GIBS WMS imagery proxy
//   - /api/terrain    Terrarium elevation tiles (AWS Terrain Tiles) for high-resolution flooding
//   - /api/live/*     live hazards: NHC storms with forecast cones, NASA FIRMS fires, USGS quakes
//   - /api/tiles      basemap imagery tiles (Esri, EOX Sentinel-2, OpenStreetMap, NASA) with a cache
//   - /ws?room=NAME   WebSocket rooms for multi-user sessions
// Run: npm start   (Node 18+; set ANTHROPIC_API_KEY in .env for Claude)
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import zlib from "node:zlib";
import { OVERPASS, overpassQuery, compactBuildings } from "../src/util/osm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- config (.env) -----------------------------------------------------------------------------
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const PORT = +(process.env.PORT || 3000);
const HTTPS_PORT = +(process.env.HTTPS_PORT || 3443);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
// Free alternative: OpenRouter (https://openrouter.ai/keys). "openrouter/free" picks a free model
// that supports tool calling for each request. Any OpenAI-compatible endpoint works via OPENROUTER_BASE_URL.
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const OR_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const OR_BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const PROVIDER = (process.env.AI_PROVIDER || (API_KEY ? "anthropic" : OR_KEY ? "openrouter" : "none")).toLowerCase();
const AI_ON = PROVIDER === "anthropic" ? !!API_KEY : PROVIDER === "openrouter" ? !!OR_KEY : false;
const AI_NAME = PROVIDER === "openrouter" ? "OpenRouter" : "Claude";
const AI_MODEL = PROVIDER === "openrouter" ? OR_MODEL : MODEL;

// ---- helpers ------------------------------------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": "TerraConsole/1.0" } });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- API handlers -------------------------------------------------------------------------------
async function claude(req, res) {
  if (PROVIDER === "openrouter") return openrouter(req, res);
  if (!API_KEY) return send(res, 503, { error: "Set OPENROUTER_API_KEY (free) or ANTHROPIC_API_KEY in .env to enable the AI." });
  const body = JSON.parse(await readBody(req));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Math.min(4000, body.max_tokens || 2000),
      system: body.system,
      messages: body.messages,
      tools: body.tools,
    }),
  });
  const text = await r.text();
  send(res, r.status, text);
}

// The page speaks the Anthropic Messages format (content blocks, tool_use / tool_result). This
// translates to and from the OpenAI chat-completions format that OpenRouter uses, so the agent loop,
// fact-checker and provenance work unchanged.
export function toOpenAI(body, model) {
  const out = [];
  if (body.system) out.push({ role: "system", content: String(body.system) });
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of blocks) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) out.push({ role: "user", content: text });
    }
  }
  const req = { model, messages: out, max_tokens: Math.min(4000, body.max_tokens || 2000) };
  if (body.tools?.length) {
    req.tools = body.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
    req.tool_choice = "auto";
  }
  return req;
}

export function fromOpenAI(j) {
  const msg = j.choices?.[0]?.message || {};
  const content = [];
  const text = String(msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text) content.push({ type: "text", text });
  (msg.tool_calls || []).forEach((c, i) => {
    let input = {};
    try { input = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function?.arguments || {}; } catch { input = {}; }
    content.push({ type: "tool_use", id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name, input });
  });
  const usesTools = content.some((b) => b.type === "tool_use");
  return { role: "assistant", model: j.model, content, stop_reason: usesTools ? "tool_use" : j.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn" };
}

async function openrouter(req, res) {
  if (!OR_KEY) return send(res, 503, { error: "Set OPENROUTER_API_KEY in .env (free at https://openrouter.ai/keys)." });
  const body = JSON.parse(await readBody(req));
  const payload = JSON.stringify(toOpenAI(body, OR_MODEL));
  let last = "";
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    let r;
    try {
      r = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OR_KEY}`, "HTTP-Referer": "http://localhost", "X-Title": "Terra Console" },
        body: payload,
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) { last = e.name === "TimeoutError" ? "the model took too long" : String(e.message || e); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) return send(res, 429, { error: "OpenRouter free limit reached (about 20 a minute, 50 a day without credit). Try again later." });
    if (r.status === 401 || r.status === 403) return send(res, r.status, { error: "OpenRouter rejected the key. Check OPENROUTER_API_KEY in .env." });
    if (!r.ok || j.error || !j.choices?.length) { last = j.error?.message || `OpenRouter ${r.status}`; if (r.status >= 400 && r.status < 500 && r.status !== 408) break; continue; }
    const msg = fromOpenAI(j);
    if (!msg.content.length) { last = "empty reply"; continue; }
    return send(res, 200, msg);
  }
  send(res, 502, { error: last || "OpenRouter failed" });
}

async function wind() {
  return cached("wind", 60 * 60 * 1000, async () => {
    const lats = [], lons = [];
    for (let la = -80; la <= 80; la += 10) for (let lo = -180; lo < 180; lo += 10) { lats.push(la); lons.push(lo); }
    const u = new Array(lats.length).fill(0), v = new Array(lats.length).fill(0);
    let time = "";
    for (let i = 0; i < lats.length; i += 100) {
      const la = lats.slice(i, i + 100).join(","), lo = lons.slice(i, i + 100).join(",");
      const url = `https://api.open-meteo.com/v1/gfs?latitude=${la}&longitude=${lo}&hourly=wind_speed_500hPa,wind_direction_500hPa,wind_speed_850hPa,wind_direction_850hPa&wind_speed_unit=ms&forecast_days=1&timezone=GMT`;
      const j = await getJSON(url);
      const arr = Array.isArray(j) ? j : [j];
      const hour = new Date().getUTCHours();
      arr.forEach((loc, k) => {
        const h = loc.hourly;
        if (!h) return;
        time = h.time?.[hour] || time;
        let uu = 0, vv = 0;
        for (const lvl of ["500hPa", "850hPa"]) {
          const s = h[`wind_speed_${lvl}`]?.[hour] ?? 0, d = h[`wind_direction_${lvl}`]?.[hour] ?? 0;
          const rad = (d * Math.PI) / 180; // meteorological: direction the wind comes FROM
          uu += -s * Math.sin(rad) / 2;
          vv += -s * Math.cos(rad) / 2;
        }
        u[i + k] = +uu.toFixed(2);
        v[i + k] = +vv.toFixed(2);
      });
    }
    return { lat0: -80, dlat: 10, nlat: 17, lon0: -180, dlon: 10, nlon: 36, u, v, level: "500–850 hPa mean", time: time ? time.replace("T", " ") + " UTC" : "latest", source: "GFS via Open-Meteo" };
  });
}

async function quakes(q) {
  const days = Math.max(1, Math.min(90, +q.get("days") || 30));
  const minmag = Math.max(0, Math.min(9, +q.get("minmag") || 4.5));
  return cached(`q${days}-${minmag}`, 10 * 60 * 1000, () => {
    const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    return getJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=${minmag}&limit=2000&orderby=magnitude`);
  });
}

async function events(q) {
  const days = Math.max(1, Math.min(365, +q.get("days") || 30));
  const cat = (q.get("category") || "all").replace(/[^a-zA-Z]/g, "");
  return cached(`e${days}-${cat}`, 15 * 60 * 1000, () =>
    getJSON(`https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=${days}${cat && cat !== "all" ? `&category=${cat}` : ""}`)
  );
}

async function indicators(q) {
  const name = (q.get("country") || "").trim().toLowerCase();
  if (!name) throw new Error("country required");
  const list = await cached("wbc", 24 * 3600 * 1000, async () => (await getJSON("https://api.worldbank.org/v2/country?format=json&per_page=400"))[1] || []);
  const c = list.find((x) => x.region?.id !== "NA" && (x.id.toLowerCase() === name || x.iso2Code.toLowerCase() === name || x.name.toLowerCase() === name))
    || list.find((x) => x.region?.id !== "NA" && x.name.toLowerCase().startsWith(name));
  if (!c) throw new Error(`No World Bank country matched "${name}"`);
  const ids = { population: "SP.POP.TOTL", gdpUSD: "NY.GDP.MKTP.CD", gdpPerCapitaUSD: "NY.GDP.PCAP.CD", urbanPct: "SP.URB.TOTL.IN.ZS" };
  const out = { country: c.name, iso3: c.id, incomeLevel: c.incomeLevel?.value };
  await Promise.all(Object.entries(ids).map(async ([k, id]) => {
    try {
      const j = await cached(`${c.id}-${id}`, 24 * 3600 * 1000, () => getJSON(`https://api.worldbank.org/v2/country/${c.id}/indicator/${id}?format=json&mrnev=1`));
      const row = j?.[1]?.[0];
      if (row) { out[k] = row.value; out[`${k}Year`] = row.date; }
    } catch {}
  }));
  return out;
}

// ---- live hazards ---------------------------------------------------------------------------------
// minimal ZIP reader (enough for NHC KMZ files): returns { name: Buffer }
export function unzip(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
// coordinates of KML Polygons, LineStrings and Points -> GeoJSON features
export function kmlToFeatures(kml) {
  const feats = [];
  const coords = (txt) => txt.trim().split(/\s+/).map((c) => c.split(",").slice(0, 2).map(Number)).filter((c) => c.length === 2 && c.every(Number.isFinite));
  for (const m of kml.matchAll(/<Placemark[\s\S]*?<\/Placemark>/g)) {
    const pm = m[0];
    const name = (pm.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() || "";
    for (const pg of pm.matchAll(/<Polygon>[\s\S]*?<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) feats.push({ type: "Feature", properties: { name }, geometry: { type: "Polygon", coordinates: [coords(pg[1])] } });
    for (const ls of pm.matchAll(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) feats.push({ type: "Feature", properties: { name }, geometry: { type: "LineString", coordinates: coords(ls[1]) } });
    for (const pt of pm.matchAll(/<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) { const c = coords(pt[1])[0]; if (c) feats.push({ type: "Feature", properties: { name }, geometry: { type: "Point", coordinates: c } }); }
  }
  return feats;
}
async function kmz(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`KMZ ${r.status}`);
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  const kmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".kml"));
  return kmlName ? kmlToFeatures(files[kmlName].toString("utf8")) : [];
}
async function liveStorms() {
  return cached("nhc", 10 * 60 * 1000, async () => {
    const j = await getJSON("https://www.nhc.noaa.gov/CurrentStorms.json");
    const storms = [];
    for (const s of j.activeStorms || []) {
      const out = { id: s.id, name: s.name, classification: s.classification, windKt: +s.intensity || null, pressureHpa: +s.pressure || null, lat: s.latitudeNumeric, lon: s.longitudeNumeric, movement: s.movementDir != null ? { dirDeg: s.movementDir, speedMph: s.movementSpeed } : null, updated: s.lastUpdate, cone: [], track: [] };
      try { if (s.trackCone?.kmzFile) out.cone = await kmz(s.trackCone.kmzFile); } catch {}
      try { if (s.forecastTrack?.kmzFile) out.track = await kmz(s.forecastTrack.kmzFile); } catch {}
      storms.push(out);
    }
    return { storms, source: "NOAA National Hurricane Center", fetched: new Date().toISOString() };
  });
}
async function liveFires() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw new Error("Set FIRMS_MAP_KEY in .env (free from firms.modaps.eosdis.nasa.gov/api/map_key)");
  return cached("firms", 30 * 60 * 1000, async () => {
    const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`);
    if (!r.ok) throw new Error(`FIRMS ${r.status}`);
    const lines = (await r.text()).trim().split(/\r?\n/);
    const head = lines.shift().split(",");
    const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"), iFrp = head.indexOf("frp"), iConf = head.indexOf("confidence");
    let fires = lines.map((l) => l.split(",")).map((c) => [+(+c[iLat]).toFixed(3), +(+c[iLon]).toFixed(3), +c[iFrp] || 0, c[iConf]]).filter((f) => Number.isFinite(f[0]));
    fires.sort((a, b) => b[2] - a[2]);
    const total = fires.length;
    fires = fires.slice(0, 25000);
    return { count: total, fires, source: "NASA FIRMS VIIRS S-NPP NRT, last 24 h", fetched: new Date().toISOString() };
  });
}

// Terrarium elevation tiles (AWS Terrain Tiles): proxied and cached in memory
const tileCache = new Map();
async function terrain(pathname, res) {
  const m = pathname.match(/^\/api\/terrain\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
  if (!m) return send(res, 400, { error: "bad tile" });
  const [z, x, y] = m.slice(1).map(Number);
  if (z > 14 || x >= 2 ** z || y >= 2 ** z) return send(res, 400, { error: "tile out of range" });
  const key = `${z}/${x}/${y}`;
  let buf = tileCache.get(key);
  if (!buf) {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`);
    if (!r.ok) throw new Error(`terrain tiles ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    tileCache.set(key, buf);
    if (tileCache.size > 6000) tileCache.delete(tileCache.keys().next().value);
  }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
  res.end(buf);
}

// Basemap imagery tiles, proxied with an in-memory cache (and a proper User-Agent, which the
// OpenStreetMap tile policy requires).
const BASEMAP_URLS = {
  satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  sentinel: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
  streets: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  topo: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  night: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
};
const imgCache = new Map();
let imgBytes = 0;
// Upstream tile fetches: at most 12 at once, 12 s timeout, 3 attempts with backoff. Errors are never
// cached, so a tile that failed once is tried again the next time the globe asks for it.
const imgInflight = new Map();
let imgActive = 0;
const imgQueue = [];
async function withSlot(fn) {
  if (imgActive >= 12) await new Promise((r) => imgQueue.push(r));
  imgActive++;
  try { return await fn(); } finally { imgActive--; imgQueue.shift()?.(); }
}
async function fetchTileWithRetry(url) {
  let last = "failed";
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 400 * 2 ** (i - 1)));
    try {
      const r = await withSlot(() => fetch(url, { headers: { "user-agent": "TerraConsole/1.0 (+local research viewer)" }, signal: AbortSignal.timeout(12000) }));
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0) return { type: r.headers.get("content-type") || "image/jpeg", buf };
        last = "empty";
      } else {
        last = String(r.status);
        if (r.status === 404 || r.status === 400) return { status: 404, error: last };
      }
    } catch (e) {
      last = e.name === "TimeoutError" ? "timeout" : String(e.message || e);
    }
  }
  return { status: 502, error: last };
}

async function imageryTile(pathname, res) {
  const m = pathname.match(/^\/api\/tiles\/([a-z]+)\/(\d{1,2})\/(\d+)\/(\d+)$/);
  if (!m || !BASEMAP_URLS[m[1]]) return send(res, 400, { error: "bad tile" });
  const [src, z, x, y] = [m[1], +m[2], +m[3], +m[4]];
  if (z > 20 || x >= 2 ** z || y >= 2 ** z) return send(res, 400, { error: "tile out of range" });
  const key = `${src}/${z}/${x}/${y}`;
  let hit = imgCache.get(key);
  if (!hit) {
    const url = BASEMAP_URLS[src].replace("{z}", z).replace("{x}", x).replace("{y}", y);
    let p = imgInflight.get(key);
    if (!p) {
      p = fetchTileWithRetry(url).finally(() => imgInflight.delete(key));
      imgInflight.set(key, p);
    }
    const out = await p;
    if (out.status) return send(res, out.status, { error: `${src} ${out.error}` });
    hit = out;
    if (!imgCache.has(key)) {
      imgCache.set(key, hit);
      imgBytes += hit.buf.length;
      while (imgBytes > 300e6 && imgCache.size) { const [k, v] = imgCache.entries().next().value; imgCache.delete(k); imgBytes -= v.buf.length; }
    }
  }
  res.writeHead(200, { "content-type": hit.type, "cache-control": "public, max-age=604800", "access-control-allow-origin": "*" });
  res.end(hit.buf);
}

// ---- OpenStreetMap buildings (Overpass), one zoom-15 tile per request, cached --------------------
// Overpass is a shared free service: one request at a time from this server, a 45 s timeout, the
// next mirror on failure, and answers kept in memory (and on disk in build/cache) so a city is
// fetched once.
const bCache = new Map();
const bInflight = new Map();
let bChain = Promise.resolve();
const B_DIR = path.join(ROOT, "build", "cache", "buildings");
async function buildings(pathname, res) {
  const m = pathname.match(/^\/api\/buildings\/(\d{1,2})\/(\d+)\/(\d+)$/);
  if (!m) return send(res, 400, { error: "bad tile" });
  const [z, x, y] = [+m[1], +m[2], +m[3]];
  if (z < 14 || z > 16 || x >= 2 ** z || y >= 2 ** z) return send(res, 400, { error: "zoom 14-16 only" });
  const key = `${z}-${x}-${y}`;
  let hit = bCache.get(key);
  const file = path.join(B_DIR, key + ".json");
  if (!hit && fs.existsSync(file)) { hit = fs.readFileSync(file); bCache.set(key, hit); }
  if (!hit) {
    let p = bInflight.get(key);
    if (!p) {
      p = (bChain = bChain.catch(() => {}).then(async () => {
        let last = "failed";
        for (const ep of OVERPASS) {
          try {
            const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "TerraConsole/1.0 (+local research viewer)" }, body: "data=" + encodeURIComponent(overpassQuery(z, x, y)), signal: AbortSignal.timeout(45000) });
            if (r.ok) return Buffer.from(JSON.stringify({ b: compactBuildings(await r.json()) }));
            last = `${new URL(ep).host} ${r.status}`;
          } catch (e) { last = `${new URL(ep).host} ${e.name === "TimeoutError" ? "timeout" : e.message}`; }
        }
        throw new Error(last);
      })).finally(() => bInflight.delete(key));
      bInflight.set(key, p);
    }
    hit = await p;
    bCache.set(key, hit);
    if (bCache.size > 400) bCache.delete(bCache.keys().next().value);
    try { fs.mkdirSync(B_DIR, { recursive: true }); fs.writeFileSync(file, hit); } catch {}
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=86400" });
  res.end(hit);
}

const GIBS_OK = new Set(["MODIS_Terra_CorrectedReflectance_TrueColor", "VIIRS_SNPP_CorrectedReflectance_TrueColor", "VIIRS_Black_Marble", "MODIS_Terra_NDVI_8Day"]);
async function gibs(q, res) {
  const layer = q.get("layer"), date = q.get("date") || "";
  if (!GIBS_OK.has(layer) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: "bad layer or date" });
  const w = Math.min(4096, +q.get("w") || 2048), h = Math.min(2048, +q.get("h") || 1024);
  const fmt = layer === "VIIRS_Black_Marble" || layer.includes("NDVI") ? "image/png" : "image/jpeg";
  const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${w}&HEIGHT=${h}&FORMAT=${encodeURIComponent(fmt)}&TIME=${date}`;
  const buf = await cached(`g${layer}${date}${w}`, 24 * 3600 * 1000, async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`GIBS ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  res.writeHead(200, { "content-type": fmt, "cache-control": "public, max-age=86400" });
  res.end(buf);
}

// ---- static files -------------------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".wasm": "application/wasm" };
function serveStatic(pathname, res) {
  const file = path.join(ROOT, "dist", pathname === "/" ? "index.html" : path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(path.join(ROOT, "dist"))) return send(res, 403, "forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, pathname === "/" ? "Run `npm run build` first." : "not found", "text/plain");
    // hashed build outputs never change, so the browser can keep them; the page itself is revalidated
    const hashed = /[\\/](app|c)-[^\\/]+\.js$|[\\/]assets[\\/]/.test(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(data);
  });
}

async function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  try {
    switch (u.pathname) {
      case "/api/health": return send(res, 200, { ok: true, claude: AI_ON, ai: AI_ON ? AI_NAME : null, model: AI_ON ? AI_MODEL : null });
      case "/api/claude": return req.method === "POST" ? await claude(req, res) : send(res, 405, { error: "POST only" });
      case "/api/wind": return send(res, 200, await wind());
      case "/api/quakes": return send(res, 200, await quakes(u.searchParams));
      case "/api/events": return send(res, 200, await events(u.searchParams));
      case "/api/indicators": return send(res, 200, await indicators(u.searchParams));
      case "/api/gibs": return await gibs(u.searchParams, res);
      case "/api/live/storms": return send(res, 200, await liveStorms());
      case "/api/live/fires": return send(res, 200, await liveFires());
      case "/api/live/quakes": return send(res, 200, await quakes(new URLSearchParams("days=1&minmag=2.5")));
      default:
        if (u.pathname.startsWith("/api/terrain/")) return await terrain(u.pathname, res);
        if (u.pathname.startsWith("/api/buildings/")) return await buildings(u.pathname, res);
        if (u.pathname.startsWith("/api/tiles/")) return await imageryTile(u.pathname, res);
        return serveStatic(u.pathname, res);
    }
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}

// ---- WebSocket rooms ----------------------------------------------------------------------------
const rooms = new Map(); // name -> Map(id -> {ws, presence})
function attachRooms(server) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
  wss.on("connection", (ws, req) => {
    const name = (new URL(req.url, "http://x").searchParams.get("room") || "terra").slice(0, 48).replace(/[^a-z0-9_.-]/gi, "-");
    if (!rooms.has(name)) rooms.set(name, new Map());
    const room = rooms.get(name);
    const id = Math.random().toString(36).slice(2, 10);
    room.set(id, { ws, presence: {} });
    const others = [...room.entries()].filter(([k]) => k !== id).map(([k, p]) => ({ id: k, presence: p.presence }));
    ws.send(JSON.stringify({ type: "hello", id, peers: others }));
    const broadcast = (msg) => { const s = JSON.stringify(msg); for (const p of room.values()) if (p.ws.readyState === 1) p.ws.send(s); };
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "presence" && m.presence && typeof m.presence === "object") {
        const me = room.get(id);
        me.presence = { ...me.presence, ...m.presence };
        if (JSON.stringify(me.presence).length > 4096) return;
        broadcast({ type: "presence", id, presence: me.presence });
      } else if (m.type === "event" && typeof m.topic === "string" && /^[a-z]{1,24}$/.test(m.topic)) {
        broadcast({ type: "event", id, topic: m.topic, data: m.data });
      }
    });
    ws.on("close", () => { room.delete(id); broadcast({ type: "leave", id }); if (!room.size) rooms.delete(name); });
  });
}

export { handler, attachRooms };
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const server = http.createServer(handler);
if (isMain) attachRooms(server);
if (isMain) server.listen(PORT, () => {
  console.log(`Terra Console → http://localhost:${PORT}`);
  console.log(AI_ON ? `AI: ${AI_NAME} (${AI_MODEL})` : "AI: off — add OPENROUTER_API_KEY (free) or ANTHROPIC_API_KEY to .env for full answers");
});

// optional HTTPS (needed for WebXR on a headset and camera access from other devices on your LAN)
if (isMain && process.env.CERT_FILE && process.env.KEY_FILE) {
  const s = https.createServer({ cert: fs.readFileSync(process.env.CERT_FILE), key: fs.readFileSync(process.env.KEY_FILE) }, handler);
  attachRooms(s);
  s.listen(HTTPS_PORT, "0.0.0.0", () => console.log(`HTTPS → https://<this-computer's-LAN-IP>:${HTTPS_PORT}`));
}
