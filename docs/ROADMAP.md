# Roadmap and known limits

## Verified in the build environment (see TESTING.md)

- Second build round: population surface, WebGPU and CPU shallow-water models (physics tests and cross-engine agreement), regional terrain from tiles (mocked), storm calibration and held-out skill, ensembles, provenance and fact-checker (mocked Claude), live hazards (mocked feeds), point-and-say, GPU wind particles, spherical output.


- Bundle builds; the page boots with no console errors in headless Chromium (desktop and phone widths).
- WebAssembly Priority-Flood runs in the worker (~200 ms) and in Node (`npm run test:flood`).
- Region drawing, region statistics, sea level presets and slider, hurricane simulation and impacts, volcano placement and plumes, wind layer, timeline scrubbing, ground view conditions, layers panel, trainer UI.
- Agent tool loop end to end against a scripted Claude: parallel tool calls, tool results, GeoJSON layers (point, arc, polygon), simulation handoff, final answer.
- Offline analysis path.
- Gesture network: trains to 100% on synthetic separable data in ~0.2 s; save/load round-trips.
- Local server: static serving, health, WebSocket rooms (presence and events relay).

## Not yet verified (needs your hardware or network)

- Real basemap and terrain tiles (Esri, EOX, OSM, NASA, AWS). Streaming, level-of-detail, compositing, tilt and labels are verified with generated tiles (zoom 4 at global view to zoom 16–18 at street level).
- Real Terrarium tiles, NHC, FIRMS and USGS responses (formats implemented from documentation; mocked in tests).
- Looking Glass with real hardware; physical sphere output on a real sphere.
- Wake word and point-and-say timing with a real microphone (latency offset may need tuning, `LATENCY_MS` in `deixis.js`).
- Webcam hand tracking and gesture recording with a real camera.
- Voice recognition with a real microphone.
- Live feeds: Open-Meteo winds, USGS, EONET, World Bank, NASA GIBS.
- Claude through the local proxy with a real API key, and through the published page's `sample` capability.
- WebXR on Quest / Vision Pro.
- Gaussian Splat loading with a real capture; Google Photorealistic 3D Tiles with a real key.
- Spatial audio by ear.

## Known limits

- **Resolution.** Imagery and terrain stream to street level in the local version, but the global flood connectivity is still computed on ~20 km cells and the regional model reaches ~30–300 m depending on window size, without levees, drainage networks or rainfall. The published page is limited to a ~10 km built-in image.
- **Buildings.** No 3D buildings yet (Google Photorealistic 3D Tiles are available in ground view with your key).
- **City elevations** are surveyed values for ~90 cities and a ~6 m estimate elsewhere.
- **Population** is a modelled 20 km surface; swap in WorldPop or GHS-POP for local studies.
- **Storm and plume physics** are simplified; the storm model beats persistence by 6–19% on held-out seasons but is far from operational models (~150 km at 72 h). Live GFS steering would improve it; intensity is not yet validated.
- **Ground view** places a splat's origin at the coordinate's ground level; there is no automatic georeferencing of captures.
- **Multi-user** rooms on the local server are in memory on one process.

## Ideas

- Rainfall-driven (pluvial) flooding in the shallow-water model.
- Global basins (IBTrACS) beyond the Atlantic.
- Validating flood extents against observed maps (Copernicus EMS) for past events.
- Rust port of the kernel with SIMD for the regional tiles.
- Recording and sharing a session as a replayable timeline.
- More trainable gesture actions (draw shapes, select layers).
