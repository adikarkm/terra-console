# Data and licences

## Bundled

| Data | Use | Source | Licence |
|---|---|---|---|
| Blue Marble imagery (4096 × 2048) | built-in globe (published page, offline) | NASA Visible Earth, via the `three-globe` example assets | public domain (NASA) |
| Place names ≥ 5,000 people (49,025) | zoom-dependent labels | GeoNames via `all-the-cities` | CC BY 4.0 |
| Topology bump map | elevation model | NASA SRTM / GTOPO-derived, via `three-globe` | public domain (NASA) |
| Water mask | ocean / lake classes | via `three-globe` | public domain |
| Cities ≥ 100,000 (4,442) | population, places, impacts | GeoNames via `all-the-cities` | CC BY 4.0 (GeoNames) |
| Country boundaries 1:110m | borders, country lookup | Natural Earth via `world-atlas` | public domain |
| City-centre elevations (~90 cities) | flood exposure | compiled reference values | — |
| Sea level scenarios | timeline | IPCC AR6 WG1 Table 9.9 (approximate medians), historical reconstructions | cite IPCC AR6 |
| All GeoNames places with population (122k) | population surface | GeoNames via `all-the-cities` | CC BY 4.0 |
| National population and GDP (to 2025) | population surface, offline indicators | World Bank via github.com/datasets (population, gdp) | CC BY 4.0 |
| Country codes | ISO / M49 mapping | github.com/datasets/country-codes | ODC-PDDL |
| Night lights | population weighting | NASA Black Marble via `three-globe` | public domain |
| Country boundaries 1:50m | country raster | Natural Earth via `world-atlas` | public domain |
| Atlantic hurricane tracks 1975–2024 | replay, calibration, validation | NOAA NHC HURDAT2, as packaged in dplyr's `storms` | public domain |

The browser loads lossless WebP copies of `dem.png` and `pop.png` (`assets/*.webp`, identical pixels, ~40% smaller) and a lossy WebP of the world image; regenerate them with `python3 tools/make_webp.py` after changing the PNGs.

Rebuild with `npm run prepare-data` (requires Python 3 with numpy, scipy, Pillow).

## Live (local server)

| Feed | Endpoint | Source | Notes |
|---|---|---|---|
| Steering winds | `/api/wind` | NOAA GFS via Open-Meteo | free, no key, cached 1 h |
| Earthquakes | `/api/quakes` | USGS FDSN event service | public domain, cached 10 min |
| Natural events | `/api/events` | NASA EONET v3 | public, cached 15 min |
| Country indicators | `/api/indicators` | World Bank Open Data | CC BY 4.0, cached 24 h |
| Satellite imagery | `/api/gibs` | NASA GIBS WMS | public; attribute NASA EOSDIS GIBS |
| Basemap imagery tiles | `/api/tiles/<basemap>/z/x/y` | Esri World Imagery and World Topo Map; EOX Sentinel-2 cloudless 2016 (CC BY 4.0); OpenStreetMap (ODbL, tile usage policy); NASA GIBS Black Marble | attribution shown on screen; Esri basemaps are for non-commercial / development use without an ArcGIS account |
| Elevation tiles | `/api/terrain/z/x/y.png` | AWS Terrain Tiles (Terrarium; SRTM, GMTED, ETOPO1, NED and others) | see AWS Terrain Tiles attribution |
| Active hurricanes | `/api/live/storms` | NOAA NHC CurrentStorms.json + KMZ cones/tracks | public domain |
| Active fires | `/api/live/fires` | NASA FIRMS VIIRS S-NPP NRT (needs `FIRMS_MAP_KEY`) | NASA open data |
| Recent earthquakes | `/api/live/quakes` | USGS FDSN | public domain |
| 3D buildings | `/api/buildings/15/x/y` (local, cached in memory and `build/cache/`) or the Overpass API directly (static site) | OpenStreetMap via Overpass (overpass-api.de, with mirrors) | ODbL; "© OpenStreetMap contributors" shown on screen while buildings are visible |
| Photorealistic 3D Tiles | browser, your key | Google Map Tiles API | Google terms; attribution shown in ground view |
| Hand tracking model | browser | MediaPipe Hands via jsDelivr | Apache 2.0 |

These endpoints were written against the providers' documented APIs. They could not be exercised from the build environment (no outbound access), so verify them on first run; each degrades to an "unavailable" result rather than breaking the app.

## Libraries

three.js (MIT), Looking Glass WebXR (Apache 2.0, loaded on demand), 3d-tiles-renderer (Apache 2.0), @mkkellogg/gaussian-splats-3d (MIT), topojson-client (ISC), ws (MIT), AssemblyScript (Apache 2.0), esbuild (MIT). Fonts: Oxanium (OFL), IBM Plex Sans and Mono (OFL) from Google Fonts.
