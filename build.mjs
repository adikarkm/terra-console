// Build: AssemblyScript -> Wasm, then two bundles from the same source:
//
//   dist/index.html + app-*.js + chunks/ + assets/   the web build (local server, GitHub Pages).
//       Code-split ES modules; textures and data are separate cached files; heavy parts
//       (town names, Gaussian Splat renderer, storm archive) load only when needed.
//   dist/terra-console-offline.html                   one self-contained file (open from disk).
//   dist/artifact.html                                the same, without a document head, for the
//                                                     published artifact (its host wraps it).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const t0 = Date.now();
const dev = process.argv.includes("--dev");
fs.mkdirSync("build", { recursive: true });
fs.mkdirSync("dist", { recursive: true });

execSync("npx asc wasm/flood.ts -o build/flood.wasm -O3 --runtime stub --noAssert", { stdio: "inherit" });

// `import x from "./a.webp?inline"` always becomes a data URL (small images needed on first paint)
const inlinePlugin = {
  name: "inline",
  setup(b) {
    b.onResolve({ filter: /\?inline$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/\?inline$/, "")), namespace: "inline" }));
    b.onLoad({ filter: /.*/, namespace: "inline" }, (a) => ({ contents: fs.readFileSync(a.path), loader: "dataurl" }));
  },
};
const common = {
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: !dev,
  sourcemap: false,
  target: ["es2020"],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  charset: "ascii",
  plugins: [inlinePlugin],
};
const src = fs.readFileSync("src/index.src.html", "utf8");
const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>';

// ---- single-file builds ----
const one = await esbuild.build({
  ...common,
  format: "iife",
  write: false,
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".wasm": "binary", ".json": "json" },
});
const js = one.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = src.replace("__APP__", () => js);
fs.writeFileSync("dist/terra-console-offline.html", HEAD + html + "</body></html>");
fs.writeFileSync("dist/artifact.html", html);

// ---- web build ----
for (const f of fs.readdirSync("dist")) if (/^(app|c)-.*\.js$/.test(f)) fs.rmSync(path.join("dist", f));
for (const d of ["chunks", "assets"]) fs.rmSync(path.join("dist", d), { recursive: true, force: true });
const web = await esbuild.build({
  ...common,
  format: "esm",
  splitting: true,
  outdir: "dist",
  entryNames: "app-[hash]",
  chunkNames: "c-[name]-[hash]", // chunks sit next to the entry so their relative imports and the "./assets" URLs share one base
  assetNames: "assets/[name]-[hash]",
  publicPath: "./",
  metafile: true,
  loader: { ".png": "file", ".jpg": "file", ".webp": "file", ".wasm": "binary", ".json": "json" },
});
const outs = Object.entries(web.metafile.outputs);
const entry = outs.find(([, o]) => o.entryPoint)[0];
const rel = (p) => "./" + path.relative("dist", p).split(path.sep).join("/");
// fetch the data the first frame needs in parallel with the script, not after it
const eager = outs.filter(([p]) => /assets\/(dem|pop)-[^/]+\.webp$/.test(p)).map(([p]) => `<link rel="preload" as="image" href="${rel(p)}">`);
const imports = outs.find(([p]) => p === entry)[1].imports.filter((i) => i.kind === "import-statement").map((i) => `<link rel="modulepreload" href="${rel(i.path)}">`);
const webHtml = src.replace("<script>__APP__</script>", () => `<script type="module" src="${rel(entry)}"></script>`);
const webHead = HEAD.replace("</head>", `${eager.join("")}<link rel="modulepreload" href="${rel(entry)}">${imports.join("")}</head>`);
fs.writeFileSync("dist/index.html", webHead + webHtml + "</body></html>");

const size = (f) => fs.statSync(f).size;
const webBytes = outs.reduce((a, [p]) => a + size(p), 0) + size("dist/index.html");
console.log(`dist/index.html + ${outs.length} files (${(webBytes / 1048576).toFixed(1)} MB, main script ${(size(entry) / 1024) | 0} KB) · dist/terra-console-offline.html ${(size("dist/terra-console-offline.html") / 1048576).toFixed(1)} MB · ${Date.now() - t0} ms`);
