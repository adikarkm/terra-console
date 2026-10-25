// Build src/data/generated/*.json from open datasets.
//   cities.json    — every GeoNames city with population >= 100,000 (all-the-cities, CC-BY GeoNames)
//                    as [name, countryCode, lat, lon, population, elevationMetres, estimated(0|1)]
//   countries.json — Natural Earth 1:110m country boundaries (world-atlas, public domain) as TopoJSON
// Elevation: a hand-checked table for well-known low-lying and major cities, otherwise sampled
// from assets/dem.png. Run after tools/prepare_textures.py:  node tools/prepare_data.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { PNG } from "pngjs";

const require = createRequire(import.meta.url);
const allCities = require("all-the-cities");
fs.mkdirSync("src/data/generated", { recursive: true });

const dem = PNG.sync.read(fs.readFileSync("assets/dem.png"));
const W = dem.width, H = dem.height;
function demAt(lat, lon) {
  const x = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
  const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
  const i = (y * W + x) * 4;
  const enc = dem.data[i] * 256 + dem.data[i + 1];
  return { elev: (enc / 65535) * 9500 - 500, cls: dem.data[i + 2] };
}

// Approximate mean elevation (m) of city centres; keyed "Name|CC".
const ELEV = {
  "Tokyo|JP": 40, "Shanghai|CN": 4, "Dhaka|BD": 6, "Mumbai|IN": 10, "Kolkata|IN": 9, "Karachi|PK": 10,
  "Lagos|NG": 41, "Manila|PH": 5, "Bangkok|TH": 2, "Jakarta|ID": 8, "Ho Chi Minh City|VN": 5,
  "New York City|US": 10, "Miami|US": 2, "New Orleans|US": -1, "Houston|US": 15, "Tampa|US": 14,
  "Boston|US": 6, "Charleston|US": 4, "Norfolk|US": 2, "Virginia Beach|US": 3, "Galveston|US": 2,
  "Amsterdam|NL": -2, "Rotterdam|NL": -1, "The Hague|NL": 1, "Venice|IT": 1, "Hamburg|DE": 8,
  "London|GB": 11, "Copenhagen|DK": 5, "Saint Petersburg|RU": 3, "Alexandria|EG": 5, "Basra|IQ": 5,
  "Guangzhou|CN": 21, "Shenzhen|CN": 10, "Tianjin|CN": 5, "Hong Kong|HK": 10, "Osaka|JP": 12,
  "Nagoya|JP": 10, "Chennai|IN": 6, "Yangon|MM": 15, "Chittagong|BD": 4, "Khulna|BD": 4,
  "Surabaya|ID": 5, "Semarang|ID": 3, "Abidjan|CI": 18, "Accra|GH": 61, "Dakar|SN": 22,
  "Dar es Salaam|TZ": 10, "Mombasa|KE": 50, "Luanda|AO": 6, "Durban|ZA": 8, "Cape Town|ZA": 15,
  "Rio de Janeiro|BR": 5, "Buenos Aires|AR": 25, "Montevideo|UY": 43, "Guayaquil|EC": 4,
  "Havana|CU": 59, "Santo Domingo|DO": 14, "Port-au-Prince|HT": 98, "Dubai|AE": 5, "Doha|QA": 10,
  "Male|MV": 1, "Singapore|SG": 15, "Taipei|TW": 9, "Sydney|AU": 39, "Melbourne|AU": 31,
  "Auckland|NZ": 30, "Vancouver|CA": 70, "Seattle|US": 52, "San Francisco|US": 16, "Los Angeles|US": 93,
  "Lisbon|PT": 10, "Barcelona|ES": 12, "Istanbul|TR": 39, "Casablanca|MA": 27, "Cairo|EG": 23,
  "Delhi|IN": 216, "Beijing|CN": 44, "Mexico City|MX": 2240, "Bogotá|CO": 2640, "São Paulo|BR": 760,
  "Kinshasa|CD": 240, "Moscow|RU": 156, "Paris|FR": 35, "Seoul|KR": 38, "Tehran|IR": 1190,
  "Nairobi|KE": 1795, "Johannesburg|ZA": 1753, "Madrid|ES": 667, "Lima|PE": 154, "Chicago|US": 181,
  "Philadelphia|US": 12, "Washington, D.C.|US": 22, "Baltimore|US": 10, "Jacksonville|US": 5,
};

const out = [];
for (const c of allCities) {
  if (c.population < 100000) continue;
  const [lon, lat] = c.loc.coordinates;
  let elev = ELEV[`${c.name}|${c.country}`];
  let est = 0;
  if (elev === undefined) {
    const s = demAt(lat, lon);
    // The 20 km DEM can't resolve coastal city heights (its lowland values are a coastal ramp, and
    // some city cells fall in the sea). Unknown coastal cities get a conservative 6 m estimate.
    if (s.cls !== 255 || s.elev < 10) { elev = 6; est = 1; }
    else elev = Math.round(s.elev);
  }
  out.push([c.name, c.country, +lat.toFixed(3), +lon.toFixed(3), c.population, elev, est]);
}
out.sort((a, b) => b[4] - a[4]);
fs.writeFileSync("src/data/generated/cities.json", JSON.stringify(out));
fs.copyFileSync("node_modules/world-atlas/countries-110m.json", "src/data/generated/countries.json");
console.log("cities:", out.length, "kB:", (fs.statSync("src/data/generated/cities.json").size / 1024) | 0);

// place names for zoom-dependent labels: every GeoNames place with >= 5,000 people
// as a flat array [name, lat, lon, pop, ...] to keep the bundle small
const towns = [];
for (const c of allCities) {
  if (c.population < 5000) continue;
  towns.push([c.population, c.name, +c.loc.coordinates[1].toFixed(3), +c.loc.coordinates[0].toFixed(3)]);
}
towns.sort((a, b) => b[0] - a[0]);
fs.writeFileSync("src/data/generated/towns.json", JSON.stringify(towns.flatMap(([p, n, la, lo]) => [n, la, lo, p])));
console.log("towns:", towns.length, "kB:", (fs.statSync("src/data/generated/towns.json").size / 1024) | 0);
