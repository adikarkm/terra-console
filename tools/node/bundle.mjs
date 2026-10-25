// Bundle a browser-side engine module for Node, swapping the DEM loader for the Node version.
import * as esbuild from "esbuild";
import path from "node:path";
export async function bundleForNode(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, logLevel: "warning",
    loader: { ".json": "json", ".wasm": "binary", ".png": "dataurl", ".jpg": "dataurl" },
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    plugins: [{ name: "dem-node", setup(b) { b.onResolve({ filter: /data\/dem\.js$/ }, () => ({ path: path.resolve("tools/node/dem-node.js") })); } }],
  });
  return import(path.resolve(outfile) + "?t=" + Date.now());
}
