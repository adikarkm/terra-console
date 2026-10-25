// Export intermediate data for the Python population builder:
//   build/countries50.geojson  Natural Earth 1:50m countries (world-atlas)
//   build/towns.json           every GeoNames place with population (all-the-cities): [lat, lon, pop, cc]
import fs from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
const require = createRequire(import.meta.url);
fs.mkdirSync("build", { recursive: true });
const topo = JSON.parse(fs.readFileSync("node_modules/world-atlas/countries-50m.json", "utf8"));
fs.writeFileSync("build/countries50.geojson", JSON.stringify(feature(topo, topo.objects.countries)));
const towns = require("all-the-cities").filter((c) => c.population > 0).map((c) => [c.loc.coordinates[1], c.loc.coordinates[0], c.population, c.country]);
fs.writeFileSync("build/towns.json", JSON.stringify(towns));
console.log("towns", towns.length);
