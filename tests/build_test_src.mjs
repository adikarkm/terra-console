import fs from "node:fs";
const src = fs.readFileSync("src/regional/swe.js", "utf8");
const m = src.match(/export const WORKER_SRC = `([\s\S]*?)`;/);
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/test_swe_src.mjs", "export const WORKER_SRC = " + JSON.stringify(m[1]) + ";\n");
