# Testing

`npm test` runs everything below. The end-to-end suite needs Python with Playwright (`pip install playwright && playwright install chromium`).

## Physics (`tests/swe.test.mjs`)

The CPU shallow-water engine on synthetic terrain:

| Test | Expectation | Result |
|---|---|---|
| Still water | land at +2 m stays dry with the sea at 0 m | dry |
| Dyke | +2 m sea fills land at +1 m to 1.0 m; nothing behind a 6 m dyke | 1.00 m / 0.000 m |
| Surge and drain | a 1.5 m surge floods a slope, then drains | 280 wet cells → 0 |
| Lagoon | a lagoon behind a +1.2 m sill on a −1 m floor keeps ~2.2 m after the surge | 2.22 m |

## Unit (`tests/unit.test.mjs`)

Engine modules bundled for Node: geodesy (distances, antimeridian polygons), IPCC scenarios, number provenance (direct, derived, untraced), population surface total, gesture network training, Katrina replay with intensity, held-out storm track and intensity skill > persistence (Atlantic) and 72 h track skill > persistence in every other basin, Haiyan 2013 in the West Pacific, ensemble probability consistency, city lookup. Plus `tools/test_flood.mjs` (Wasm Priority-Flood: areas and people at +1/2/7/66 m).

## End-to-end (`tests/e2e/run.py`)

Headless Chromium with WebGL and WebGPU on SwiftShader, against `tests/e2e/mock-server.mjs`, which stands in for Claude (scripted tool calls and a fact-checker reply), Terrarium tiles (generated from the DEM) and the live feeds:

boot and Wasm flood · local AI transport · 1 M GPU wind particles · streamed imagery refining from zoom ~2 at global view to zoom 15–17 at a few km altitude (mock tiles cut from the world image) · neighbourhood labels at street zoom · 3D buildings at street level (mock footprints) · failed imagery tiles retried or filled · live storms, fires, quakes · Katrina replay and skill table · storm ensemble · point-and-say volcano · regional terrain from tiles on WebGPU · dynamic surge advancing · equilibrium flood · agent calls the surge model · fact-checker removes an untraced number · numbers linked to sources · provenance popover · spherical output · no page errors. Screenshots land in `build/e2e/`.

A separate browser check (`tests/browser/swe_entry.js`) runs the WebGPU and CPU solvers side by side: identical wet-cell counts and volumes, max depth difference < 0.1 mm after 8 simulated hours.

The end-to-end run takes 5–8 minutes in a software-rendered browser; run it on its own (two at once compete for the CPU and time out).

## Load time (`tests/perf/load.py`)

`python3 tests/perf/load.py [dist-dir] [mbit/s]` serves a build with gzip (as GitHub Pages does), opens it in headless Chromium on a throttled connection with 40 ms latency, and reports time to the first globe frame and bytes transferred. Outside requests (map tiles) are blocked so only the app itself is measured.

## Unit: OSM buildings (`tests/osm.test.mjs`)

Heights from `height`, `building:levels`, `min_height` and building type; multipolygon outer rings; open rings skipped; tile bounds and the Overpass query.

## Not covered by automated tests

Real camera, microphone, headsets, Looking Glass hardware, physical spheres, and the live third-party services. The mock server proves the code paths and data formats; the real services need a first run on your machine.
