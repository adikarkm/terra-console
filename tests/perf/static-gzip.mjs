// Minimal static server with gzip for text types, like GitHub Pages. Usage: node static-gzip.mjs <dir> <port>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
const [dir, port] = [path.resolve(process.argv[2] || "dist"), +(process.argv[3] || 8099)];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".wasm": "application/wasm" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const f = path.join(dir, u.pathname === "/" ? "index.html" : path.normalize(u.pathname));
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const ext = path.extname(f), type = TYPES[ext] || "application/octet-stream";
  let body = fs.readFileSync(f);
  const h = { "content-type": type };
  if (/text|javascript|json|wasm/.test(type) && /gzip/.test(req.headers["accept-encoding"] || "")) { body = zlib.gzipSync(body, { level: 6 }); h["content-encoding"] = "gzip"; }
  h["content-length"] = body.length;
  res.writeHead(200, h);
  res.end(body);
}).listen(port, () => console.log("static on", port));
