// Build: AssemblyScript -> Wasm, then bundle everything (three.js, libraries, data, textures,
// Wasm) into one self-contained dist/index.html that works as a file, behind the local
// server, or as a published artifact.
import { execSync } from "node:child_process";
import fs from "node:fs";
import * as esbuild from "esbuild";

const t0 = Date.now();
fs.mkdirSync("build", { recursive: true });
fs.mkdirSync("dist", { recursive: true });

execSync("npx asc wasm/flood.ts -o build/flood.wasm -O3 --runtime stub --noAssert", { stdio: "inherit" });

const result = await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "iife",
  minify: process.argv.includes("--dev") ? false : true,
  sourcemap: false,
  target: ["es2020"],
  write: false,
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".wasm": "binary", ".json": "json" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  charset: "ascii",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("src/index.src.html", "utf8").replace("__APP__", () => js);
// standalone page (local server / file) gets its own document head; the artifact build is
// the bare content, which the artifact host wraps in its own skeleton.
const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>';
fs.writeFileSync("dist/index.html", head + html + "</body></html>");
fs.writeFileSync("dist/artifact.html", html);
const kb = (fs.statSync("dist/index.html").size / 1024) | 0;
console.log(`dist/index.html ${kb} KB in ${Date.now() - t0} ms`);
