# AI agent

Ask the Earth runs an agent loop: **plan → call tools → observe → repeat → answer**. The model never has to guess a figure, because every number comes back from a tool that measures it from data. The panel shows each step live (and can speak it), and the globe fills with layers as the agent works.

## Why tools instead of a vector database

Retrieval-augmented generation with a vector database (Chroma, Pinecone) finds text that *means* something similar. Spatial questions need things that are *located* somewhere: "cities inside this polygon", "land below 5 m in this box", "flood extent at +2 m". Those are geometric queries, so the agent gets geometric tools: point-in-polygon over GeoNames cities, raster statistics over the DEM in WebAssembly, the Priority-Flood result, Natural Earth borders, and live feeds through the local server. A vector store becomes useful later for document knowledge (reports, policies); it can be added as one more tool.

## Transports (`ai/agent.js`)

| Where | How |
|---|---|
| Published artifact | `claude.use("sample")`. The page passes its tools as functions; Claude decides which to call, the runtime executes them in the page and feeds the results back. Answers stream into the panel. Runs on the viewer's own Claude account after a one-time consent. |
| Local server | `POST /api/claude` forwards to the Anthropic Messages API with your key (`ANTHROPIC_API_KEY`, model `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`). The page runs the loop: send → execute every `tool_use` → send `tool_result`s → repeat, up to 12 rounds. |
| Local server, free | With `OPENROUTER_API_KEY` set (and no Anthropic key, or `AI_PROVIDER=openrouter`), the same endpoint translates to OpenRouter's OpenAI-compatible chat completions: `tool_use`/`tool_result` blocks become `tool_calls`/`tool` messages and back, `<think>` blocks are stripped, failures retry twice. Default model `openrouter/free` picks a free model that supports tool calling for each request; set `OPENROUTER_MODEL` to pin one. `OPENROUTER_BASE_URL` points it at any OpenAI-compatible server (Ollama: `http://localhost:11434/v1`). Free limits: ~20 requests/min and 50/day without credit; a 429 shows a clear message and the console falls back to offline analysis. Free models are weaker at multi-step tool use than Claude; the fact-checker still runs. Tested with a mock upstream (`tests/openrouter.test.mjs`). |
| Offline | A deterministic planner over the same tools: finds place names and a sea level in the question, runs `region_summary` and `flood_impact` for each place, draws a layer and offers a simulation. Real numbers, no reasoning. |

## Tools (`ai/tools.js`)

Areas are `"selected"` (the drawn region), a circle `{lat, lon, radiusKm}`, or omitted (selected region, else a circle around the view centre sized by zoom).

| Tool | Returns | Source |
|---|---|---|
| `geocode` | city or country, coordinates, population, elevation | GeoNames, Natural Earth |
| `region_summary` | area, land %, elevation, land below 2/5/10 m, population and people below 5 m, countries, largest cities | DEM + population surface (Wasm), GeoNames |
| `list_cities` | cities in an area, optionally below an elevation | GeoNames |
| `flood_impact` | flooded km², people in flooded cells by country, cities below the new sea level, optional exposed-economy proxy | Priority-Flood, population surface, GeoNames |
| `elevation_at` | elevation, surface, country, nearest city | DEM |
| `wind_at` | speed, direction, source | GFS or climatology |
| `sea_level_projection` | sea level for a year and scenario | IPCC AR6 |
| `earthquakes` | recent quakes in an area | USGS (local server) |
| `natural_events` | open wildfires, storms, volcanoes, floods | NASA EONET (local server) |
| `country_indicators` | population, GDP, GDP per capita (live via the server, else a bundled 2024–25 snapshot) | World Bank |
| `historical_storm` | replays a real hurricane vs the model: peak, track errors, cities hit | NOAA HURDAT2 |
| `storm_model_skill` | held-out forecast skill vs persistence | NOAA HURDAT2 |
| `simulate_surge` | runs the shallow-water surge model: peak flooded area, people, depth, timing | Terrarium tiles, population surface |
| `run_ensemble` | 50-track storm probabilities per city, or flood across sea levels | ensemble engine |
| `live_hazards` | active storms with cones, fires, quakes right now | NHC, NASA FIRMS, USGS (local server) |
| `show_data_layer` | draws lowland risk, flood depth, elevation, population density, exposure, cities or borders | computed from data |
| `show_layer` | draws the model's own GeoJSON with a style | — |
| `set_view` | flies the globe | — |
| `propose_simulation` | offers a What-If handoff button | — |

Each tool is wrapped with narration: a human-readable step ("Running the flood model at +2 m around 25.8, −80.2") appears when it starts and a one-line result when it finishes.

### Example: "Compare the economic impact of a 2-metre sea level rise in Durban versus Miami"

1. `geocode` Durban, `geocode` Miami
2. `flood_impact` meters 2 around each (80–120 km circles)
3. `country_indicators` South Africa, United States → GDP per capita
4. `flood_impact` again with `gdpPerCapitaUSD` → exposed-economy proxy
5. `show_data_layer` flood around each, `show_layer` markers and an arc, `set_view`
6. `propose_simulation` sea +2 m
7. Answer with the comparison, the method's limits and sources

## Provenance and the fact-checker (`ai/verify.js`)

Every tool call is recorded with its input and result. When the answer arrives, each number in it is parsed (with `k`, `M`, `million`, `%` and thousands separators) and traced:

- **from a tool** — matches a value in a tool result or input (within rounding / 3.5%; fractions shown as percentages count),
- **derived** — matches a sum, difference, ratio or percentage of two tool values,
- **untraced** — matches nothing.

Numbers are rendered as buttons: green underline when traced (tap to see the exact tool, input, field and value), red when untraced. If any are untraced, a **critic pass** sends Claude the draft, the tool results and the list of untraced numbers and asks for a corrected answer that keeps the same structure; the revision is kept only if it traces better. The panel header shows e.g. `5/5 numbers traced · revised by fact-checker`.

Pointing also feeds the agent: when you say "here" while pointing, the console state carries `pointedAt`, and area-based tools default to a 150 km circle around it.

## Layer spec (`ai/layers.js`)

`show_layer` takes GeoJSON (FeatureCollection, Feature or Geometry) and a style:

```json
{
  "fill": "#ff6a3d", "stroke": "#ffffff", "opacity": 0.45,
  "radiusKm": 60, "labelProperty": "name",
  "colorBy": { "property": "risk", "stops": [[0, "#2ad3a0"], [0.5, "#ffb547"], [0.8, "#ff2e63"]] }
}
```

or `"colorBy": {"property": "risk", "domain": [0, 1], "palette": "risk"}` with palettes `risk`, `heat`, `cool`, `depth`.

- **Points** → glowing marker, optional disc (`properties.radiusKm`, `intensity` 0–1), label (`label` / `name`, `note`).
- **Lines** → a 2-point line becomes a lifted great-circle arc; longer lines become tubes along the surface.
- **Polygons** → rasterised fill and outline on the globe, with a label at the centroid.

This is the engine-agnostic equivalent of Cesium CZML: the model writes a style schema, the renderer applies it.

## Prompt

The instructions (in `agent.js`) tell the model to ground every number in a tool result, plan multi-part questions step by step, draw at least one layer, offer a simulation when it helps, keep the final answer under ~170 words with bold key numbers and a `Sources:` line, and state the model's limits when they matter. Console state (selected region, current simulation, wind source, year) is passed with every question.

## Adding a tool

Add an object to the array in `makeTools()`:

```js
{
  name: "air_quality",
  description: "Current PM2.5 at a point.",
  inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  async execute({ lat, lon }) {
    return await (await fetch(`/api/air?lat=${lat}&lon=${lon}`)).json();
  },
}
```

Add a narration line in `narrate()` and, if it needs the network, an endpoint in `server/server.js`. Both transports pick it up automatically.
