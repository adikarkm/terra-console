# Simulation

## Elevation model (`assets/dem.png`)

A 2048 × 1024 equirectangular grid (~20 km cells at the equator), built by `tools/prepare_textures.py`:

- **Source.** The three-globe topology map (NASA SRTM / GTOPO-derived) stores ~25 m per grey level. Calibrated against known heights (Denver 1,609 m → level 65; Mexico City 2,240 m → 83; Tibet ~4,900 m → 196).
- **Coastal lowlands.** That map flattens everything below ~25 m to zero, which would make every coast flood at once. Lowland cells are rebuilt as `0.3 m + 0.06 m per km from the ocean`, capped at 12 m, so wide deltas and flat coasts (Bangladesh, the Netherlands, Florida, the Mekong) flood first and narrow coasts last.
- **Lakes vs ocean.** Water bodies are labelled as connected components. The world ocean, plus seas within ~60 km of it (behind straits the grid can't resolve, such as the Black Sea), are ocean. Everything else is an inland lake with its real surface level from a table (Caspian −28 m, Superior 183 m, Victoria 1,134 m …). Lakes never act as flood sources.
- **Packing.** R,G = 16-bit elevation (`(R·256+G)/65535·9500 − 500` m); B = 255 land, 128 lake, 0 ocean.

## Priority-Flood (`wasm/flood.ts`)

A flat "bathtub" cutoff floods any cell below the new sea level, including basins walled off by hills. Priority-Flood (Barnes, Lehman & Mulla, 2014) instead computes, for every land cell, the **spill level**: the lowest sea level at which water can reach that cell along some path from the ocean, which equals the highest point on the best path in.

```
seed: every ocean cell touching land, priority 0
while heap not empty:
    pop cell c with level L
    for each unvisited 8-neighbour n:
        spill[n] = max(L, elevation[n])
        push n with priority spill[n]
```

Every cell is pushed once, so it runs in O(N log N): about 200 ms for 2 million cells in the browser. After that, the flood for any sea level is `spill <= sea`, evaluated per pixel in the shader. Effects you can see:

- Water reaches a valley only once the sea tops the ridge in front of it, then fills the valley.
- A basin below sea level (the Caspian depression, the Qattara depression) stays dry until the sea tops its rim, then fills completely. The model puts the Caspian rim at ~25 m, close to the real Manych spillway (~26 m).

`floodArea(sea)` sums flooded land area weighted by `cos(latitude)`; `regionStats(polygon, sea)` returns area, land share, mean/max elevation, land below 2/5/10 m and flooded area inside a polygon. Both run in Wasm in the worker. A JavaScript port of the same algorithm is used if WebAssembly is unavailable.

Measured with `npm run test:flood`: +2 m floods ~2.1 M km² (1.4% of land), +7 m ~3.8 M km² (2.6%), +66 m ~14.7 M km² (10%).

**Limits.** Below ~1.3 m the grid can't resolve flooding. Levees, sea walls, subsidence, tides and storm surge are not modelled. City exposure uses city-centre elevation, so partial flooding of large cities is missed.

## Population surface (`assets/pop.png`, `tools/prepare_population.py`)

A settlement-based dasymetric model on the same 2048 × 1024 grid:

1. All 122,000 GeoNames places with a population are spread with a Gaussian (σ = 4 km + 10 km·√(pop/1 M)).
2. Per country, the World Bank national population (latest year, 2024–2025) minus the town total is the rural remainder. It is spread over the country's land with three normalised weights: nearness to towns (a ~60 km town-density field, raised to 1.6, 63%), NASA night lights above background (raised to 1.3, 35%) and a floor on habitable land (2%).
3. If towns exceed the national total, they are scaled to 90% of it.

The surface sums to 8.35 B (World Bank world 8.22 B). Checks: 98.7% of Niger's people live south of 18°N; Egypt's top 10% of cells hold 95.5% of its people (Nile valley). The country index of every cell (Natural Earth 1:50m) is stored in the blue channel, so exposure is reported by country.

**Exposure numbers** count everyone living in a 20 km cell the sea reaches, so they are an upper bound: +2 m reaches cells holding ~470 M people. The regional surge model (below) gives much tighter figures for a specific place.

## Regional surge model (`regional/`)

For a window of up to ~6° (the drawn region, or the view centre):

- **Terrain.** Terrarium elevation tiles (AWS Terrain Tiles: SRTM, GMTED, ETOPO1, national lidar where available, with bathymetry) at a zoom whose pixels are at least as fine as the grid cells, up to 64 tiles, resampled to a regular grid (512² on WebGPU, 256² on CPU). Draw a small region for ~30–100 m cells. Without tile access it falls back to the global DEM.
- **Open sea** = cells at or below 0 m that the global model classes as ocean; polders and inland depressions stay dry until water reaches them overland.
- **Equilibrium mode**: regional Priority-Flood at sea rise + surge held indefinitely.
- **Dynamic mode**: the local inertial shallow-water equations (Bates, Horritt & Fewtrell 2010; de Almeida & Bates 2013 — the LISFLOOD-FP scheme). On each face, `q ← (q − g·h_f·Δt·∂η/∂x) / (1 + g·Δt·n²·|q|/h_f^(7/3))`, then `h ← h − Δt·∇·q`. Manning n = 0.03, CFL Δt = 0.7·Δx/√(g·h_max) (≤ 60 s), closed side boundaries, sea cells follow `η_b(t) = sea rise + surge·exp(−((t − 18 h)/6 h)²) + tide·sin(2πt/12.42 h)`. A storm passing within ~4° sets the surge from its category.
- **Engines.** WebGPU compute shaders (three passes per step, up to 64 steps per submit, depth read back each frame) or the same code in a Web Worker. In tests, the two engines agree to better than 0.1 mm after 8 simulated hours.
- **Verified behaviour** (`tests/swe.test.mjs`): still water stays still; a +2 m sea fills land in front of a 6 m dyke to 1.00 m and nothing behind it; a surge floods a slope and fully drains; a lagoon behind a sill keeps exactly its sill-limited depth (2.22 m vs 2.2 m expected).

## Wind field (`sim/wind.js`)

`Wind.sample(lat, lon)` returns `{u, v}` in m/s (east, north) at the steering level.

- **Live (local server).** `/api/wind` fetches GFS winds at 500 and 850 hPa from Open-Meteo on a 10° grid, averages the two levels (a common deep-layer steering approximation), converts meteorological direction to u/v, and caches for an hour. Sampling is bilinear.
- **Climatology (fallback).** A zonal-mean profile (trade easterlies near 10°, westerlies peaking near 45°, polar easterlies) plus the five subtropical anticyclones (Azores–Bermuda, North Pacific, St Helena, South Pacific, Mascarene) as vortices that turn clockwise in the north and anticlockwise in the south. This reproduces the classic hurricane track: westward in the trades, curving poleward around the high, recurving east in the westerlies.

The wind layer advects ~1 million particles entirely on the GPU (WebGL2 float render targets; state = lat, lon, age, life; the field is uploaded as a 1° float texture). Without float render targets it falls back to 3,500 CPU streaks.

## Tropical cyclones (`sim/storm.js`)

Hurricanes, typhoons and cyclones use one model with parameters per ocean basin (North Atlantic, Eastern Pacific, Western Pacific, North Indian, South Indian, South Pacific; `basinAt` assigns a point to a basin with IBTrACS-like boundaries). The drag sets the genesis point and an initial push. Each hourly step for up to 7 days:

- **Motion** = steering factor × steering wind (live GFS or climatology) + beta drift (westward and poleward, mirrored in the southern hemisphere) + the initial push, which decays with time scale τ.
- **Intensity** over water relaxes toward a potential intensity that depends on latitude: `mpiMax` equatorward of `mpiLat0`, falling linearly to 25 kt at `mpiLat1`, with time scale `tauI` when strengthening and `tauW` when weakening. Over land it follows the Kaplan & DeMaria (1995) inland decay, `V(t) = 26.7 + (V₀ − 26.7)·e^(−0.095 t)`, with extra loss over high terrain.
- **Category** from the Saffir–Simpson thresholds. The run ends when winds fall below 30 kt.
- **Wind radius** (34 kt) grows with category and latitude.
- **Impacts**: cities within the 34 kt radius at closest approach; "hurricane winds" inside 40% of it; surge risk where the storm is over water, the city is coastal and its elevation is below the typical peak surge for that category (NHC SLOSH ranges: Cat 1 ~1.5 m … Cat 5 ~7 m).

### Calibration and validation against history (`sim/validate.js`, `tools/calibrate_storms.mjs`)

4,083 tropical cyclones from every basin, 1980–2026 (NOAA IBTrACS v04r01, 6-hourly, 1-minute winds from the US agencies, which cover all basins). From every 12-hourly fix of a tropical storm the model forecasts 24/48/72 h ahead from the observed position, intensity and motion over the previous 12 h. For each basin a grid search on **1980–2014** fits first the track (steering factor, beta drift, τ; minimising 48 h position error), then the intensity (`mpiMax`, `mpiLat0`, `mpiLat1`, `tauI`, `tauW`; minimising 48 h wind error). Skill is reported on held-out **2015–2026** against persistence (keep moving the way the storm moved over the last 12 h; keep today's intensity):

| Basin | Forecasts | 24 h track | 48 h track | 72 h track | 24 h wind | 48 h wind | 72 h wind |
|---|---|---|---|---|---|---|---|
| North Atlantic | 1,969 | +7% | +14% | +19% | +18% | +22% | +27% |
| Eastern Pacific | 1,854 | +2% | +5% | +8% | +8% | +14% | +19% |
| Western Pacific | 2,107 | +5% | +9% | +13% | +22% | +27% | +29% |
| North Indian | 388 | +3% | +6% | +7% | +26% | +25% | +24% |
| South Indian | 1,597 | +4% | +8% | +13% | +8% | +17% | +19% |
| South Pacific | 755 | +3% | +7% | +12% | +13% | +18% | +22% |

Percentages are error reduction versus persistence (positive = better). In the North Atlantic, for example, the 72 h track error is 826 km against 1,012 km for persistence, and the 72 h wind error 17 kt against 24 kt. The fitted parameters are in `src/sim/storm_params.json`; the full report (training and test errors in km and kt) is written to `build/storm_calibration.json`. The South Atlantic has too few storms (3) to fit and uses the defaults.

How to read this honestly: the fitted intensity model is mostly a slow relaxation toward each basin's typical strength, in the spirit of statistical baselines such as SHIFOR, not a physical model of rapid intensification; it beats "no change" because storms regress toward typical intensities. Track forecasts are driven by a climatological or present-day steering field, not the weather on the storm's actual dates. Operational centres reach ~150 km at 72 h; this is a teaching-grade model, and the table says exactly how good it is.

### Ensembles (`sim/ensemble.js`)

50 members perturb genesis (σ 0.8°), intensity (±1 category), steering wind (σ 2 m/s) and initial motion. For each city the share of members bringing hurricane-force winds (within 40% of the 34-kt radius) and storm-force winds is reported, with landfall share and median landfall time. The globe shows the member tracks and a probability map. Sea-level ensembles sweep rises (default 0.3–5 m) over an area.

## Ash, smoke and fire (`sim/hazards.js`)

- **Plumes** are Lagrangian particles advected each hour by the wind (1.3× steering speed for ash aloft, 1.0× for smoke) with random-walk diffusion (~9 km/h). The live view runs a time-lapse at 6 simulated hours per second. Impact lists come from a quick offline run of 90–160 particles over 48–72 h, counting how often particles pass within 45–70 km of each city.
- **Wildfire perimeter** after 48 h: an ellipse with the ignition point at the rear focus, oriented downwind, using Anderson's (1983) length-to-breadth ratio `1 + 0.25·U` (U in m/s) and a head spread rate rising with wind speed. Vertices over water are pulled back to the last land along that bearing.
- **Meteors**: severe-damage radius by impactor size (50 m ~25 km, Tunguska-class airburst; 300 m ~110 km; 1 km ~450 km). Ocean impacts of 300 m and larger flag low-lying coastal cities as tsunami risk.

These are deliberately simple physics models meant to show how winds and terrain shape outcomes, not forecasts.

## Sea level timeline (`time/scenarios.js`)

Global mean sea level relative to 1995–2014: historical reconstruction (≈ −0.16 m in 1900, +0.09 m in 2026), then approximate medians from IPCC AR6 WG1 Table 9.9 for SSP1-2.6, SSP2-4.5 and SSP5-8.5 at 2050, 2100 and 2150, plus the SSP5-8.5 low-likelihood, high-impact storyline (83rd percentile including ice-sheet instability: ~1.6 m in 2100, ~4.8 m in 2150). Scrubbing sets the What-If sea level to the value relative to today; past years lower than today are noted rather than drawn.

## Ground view conditions (`ground/ground.js`)

For a chosen point: elevation from the city table when a known city centre is within 15 km, otherwise the DEM cell (editable). Water depth = `max(0, sea − elevation)`, only if Priority-Flood says the sea can reach that cell. Fire if inside 25 km of a wildfire, smoke within its plume range or 400 km of an eruption, storm conditions if any track point passes within its 34 kt radius.
