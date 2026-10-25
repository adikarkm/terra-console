// Tools the AI calls to ground every claim in data. Each tool runs in the browser against
// the DEM, the Priority-Flood result, GeoNames cities, Natural Earth countries and the wind
// field; live feeds (USGS, NASA EONET, World Bank) go through the local server when present.
import { S, emit } from "../state.js";
import { CITIES, findCity, findCountry, countryAt, citiesInPoly, citiesNear, nearestCity, countriesInPoly } from "../data/places.js";
import { sampleDEM, COUNTRY_STATS, popAt } from "../data/dem.js";
import { regionStats } from "../sim/flood.js";
import { Wind } from "../sim/wind.js";
import { showGeoJSON, showDataLayer, areaFromSpec } from "./layers.js";
import { flyTo, viewCenter, G } from "../globe/scene.js";
import { circlePoly, haversine, polyCentroid, pointInPoly, unwrapPoly } from "../util/geo.js";
import { activeDeixis } from "../input/deixis.js";
import { gmsl, seaRelativeToToday, SCENARIOS } from "../time/scenarios.js";
import { runReplay, modelSkill } from "../modes/history.js";
import { loadStorms, STORMDATA } from "../sim/stormdata.js";
import { runSurgeScenario } from "../regional/regional.js";
import { LIVE, setLive } from "../live/live.js";
import { runEnsembleView } from "../modes/ensembleview.js";
import { seaEnsemble } from "../sim/ensemble.js";
import { runStorm } from "../modes/whatif.js";

const AREA_SCHEMA = {
  description: 'Where to look: "selected" for the user\'s drawn region, or a circle {lat, lon, radiusKm}. Omit to use the selected region, or the view centre if none.',
  oneOf: [{ type: "string", enum: ["selected"] }, { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" }, radiusKm: { type: "number" } }, required: ["lat", "lon"] }],
};

function resolveArea(spec) {
  if (spec && typeof spec === "object" && spec.lat != null) {
    const r = spec.radiusKm || 150;
    return { poly: circlePoly({ lat: spec.lat, lon: spec.lon }, r), label: `${r} km around ${spec.lat.toFixed(2)}, ${spec.lon.toFixed(2)}`, center: { lat: spec.lat, lon: spec.lon } };
  }
  const dx = activeDeixis();
  if (dx && (spec !== "selected" || !S.region)) return { poly: circlePoly(dx, 150), label: `150 km around the point you indicated ${dx.place}`, center: dx };
  if (S.region) return { poly: S.region.poly, label: "the selected region", center: S.region.centroid };
  const c = viewCenter();
  const r = Math.round(400 * (G.dist - 1));
  return { poly: circlePoly(c, r), label: `${r} km around the view centre`, center: c };
}

async function api(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const LIVE_HINT = "Live feeds need the Terra Console local server (npm start). Say the data is unavailable rather than guessing.";

const round = (x, d = 1) => (x == null || isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function makeTools(hooks) {
  const T = [
    {
      name: "geocode",
      description: "Find a city or country by name. Returns coordinates, population (GeoNames, city proper) and country.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute({ query }) {
        const c = findCity(query);
        if (c) return { kind: "city", name: c.name, country: c.cc, lat: c.lat, lon: c.lon, population: c.pop, elevationM: c.elev, source: "GeoNames" };
        const k = findCountry(query);
        if (k) {
          let la = 0, lo = 0, n = 0;
          for (const r of k.rings) for (const p of r) { la += p.lat; lo += p.lon; n++; }
          return { kind: "country", name: k.name, lat: round(la / n, 2), lon: round(lo / n, 2), source: "Natural Earth" };
        }
        return { error: `No city with population >= 100k or country matched "${query}".` };
      },
    },
    {
      name: "region_summary",
      description: "Measured facts about an area: size, land share, elevation stats, low-lying land, countries, largest cities. Use this first for any question about a place.",
      inputSchema: { type: "object", properties: { area: AREA_SCHEMA } },
      async execute({ area }) {
        const A = resolveArea(area);
        const st = await regionStats(A.poly, S.sea);
        const cities = citiesInPoly(A.poly, 400);
        const co = countriesInPoly(A.poly);
        return {
          area: A.label,
          center: { lat: round(A.center.lat, 2), lon: round(A.center.lon, 2) },
          areaKm2: round(st?.areaKm2, 0), landPct: round(st?.landPct), meanElevationM: round(st?.meanElev, 0), maxElevationM: round(st?.maxElev, 0),
          landBelow2mKm2: round(st?.below2Km2, 0), landBelow5mKm2: round(st?.below5Km2, 0), landBelow10mKm2: round(st?.below10Km2, 0),
          populationEstimate: Math.round(st?.people || 0), peopleOnLandBelow5m: Math.round(st?.peopleBelow5m || 0),
          countries: co.names.slice(0, 12), countryCodesByCityPopulation: co.byCityCode.slice(0, 8),
          citiesOver100k: cities.length, cityPopulationTotal: cities.reduce((a, c) => a + c.pop, 0),
          largestCities: cities.slice(0, 10).map((c) => ({ name: c.name, cc: c.cc, pop: c.pop, elevM: c.elev, elevEstimated: c.est, lat: c.lat, lon: c.lon })),
          sources: "Terra DEM (~20 km grid, SRTM/GTOPO-derived); population surface (GeoNames towns + World Bank national totals, dasymetric, 20 km); GeoNames cities >= 100k; Natural Earth",
        };
      },
    },
    {
      name: "list_cities",
      description: "Cities (population >= 100k) in an area, largest first, with population and approximate elevation.",
      inputSchema: { type: "object", properties: { area: AREA_SCHEMA, maxElevationM: { type: "number" }, limit: { type: "integer" } } },
      async execute({ area, maxElevationM, limit = 25 }) {
        const A = resolveArea(area);
        let cs = citiesInPoly(A.poly, 2000);
        if (maxElevationM != null) cs = cs.filter((c) => c.elev <= maxElevationM);
        return { area: A.label, count: cs.length, totalPopulation: cs.reduce((a, c) => a + c.pop, 0), cities: cs.slice(0, Math.min(60, limit)).map((c) => ({ name: c.name, cc: c.cc, pop: c.pop, elevM: c.elev, elevEstimated: c.est, lat: c.lat, lon: c.lon })), source: "GeoNames" };
      },
    },
    {
      name: "flood_impact",
      description: "Run the Priority-Flood sea-level model for a rise in metres over an area. Returns flooded land km², share of land, and cities whose centres sit below the new sea level, with populations. Optionally pass gdpPerCapitaUSD to get a rough exposed-economy proxy (affected city population x GDP per capita).",
      inputSchema: { type: "object", properties: { meters: { type: "number" }, area: AREA_SCHEMA, gdpPerCapitaUSD: { type: "number" } }, required: ["meters"] },
      async execute({ meters, area, gdpPerCapitaUSD }) {
        const A = resolveArea(area);
        const st = await regionStats(A.poly, meters);
        const cs = citiesInPoly(A.poly, 3000);
        const under = cs.filter((c) => c.elev < meters);
        const pop = under.reduce((a, c) => a + c.pop, 0);
        const out = {
          area: A.label, seaRiseM: meters,
          floodedLandKm2: round(st?.floodedKm2, 0), landKm2: round(st?.landKm2, 0), floodedSharePct: st?.landKm2 ? round((st.floodedKm2 / st.landKm2) * 100, 2) : 0,
          peopleInFloodedCells: Math.round(st?.peopleFlooded || 0), peopleInFloodedCellsNote: "upper bound: everyone living in a 20 km cell the sea reaches", floodedByCountry: st?.floodedByCountry || [],
          citiesBelowNewSeaLevel: under.slice(0, 20).map((c) => ({ name: c.name, cc: c.cc, pop: c.pop, elevM: c.elev, elevEstimated: c.est })), affectedCityPopulation: pop,
          method: "Priority-Flood spill levels on a ~20 km DEM (water only enters areas connected to the ocean once it tops their rim). City exposure uses city-centre mean elevation, so partial flooding of large cities is not captured.",
        };
        if (gdpPerCapitaUSD) out.exposedEconomyProxyUSD = Math.round(pop * gdpPerCapitaUSD);
        return out;
      },
    },
    {
      name: "elevation_at",
      description: "Elevation and surface type at a point, plus nearest city and country.",
      inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
      async execute({ lat, lon }) {
        const d = sampleDEM(lat, lon), nc = nearestCity({ lat, lon }), co = countryAt(lat, lon);
        return { elevationM: round(d.elev, 0), surface: d.kind, country: co?.name || null, nearestCity: nc ? { name: nc.name, cc: nc.cc, distKm: round(nc.distKm, 0) } : null };
      },
    },
    {
      name: "wind_at",
      description: "Steering-level wind at a point (m/s, direction the wind blows toward).",
      inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
      async execute({ lat, lon }) {
        const { u, v } = Wind.sample(lat, lon);
        return { speedMs: round(Math.hypot(u, v)), towardDeg: round((Math.atan2(u, v) * 180 / Math.PI + 360) % 360, 0), u: round(u), v: round(v), source: Wind.source };
      },
    },
    {
      name: "sea_level_projection",
      description: "Global mean sea level for a year under an IPCC AR6 scenario (ssp126, ssp245, ssp585, highend), in metres relative to today and to 1995-2014.",
      inputSchema: { type: "object", properties: { year: { type: "integer" }, scenario: { type: "string", enum: Object.keys(SCENARIOS) } }, required: ["year"] },
      async execute({ year, scenario = "ssp245" }) {
        return { year, scenario, label: SCENARIOS[scenario]?.label, vsTodayM: round(seaRelativeToToday(year, scenario), 2), vs1995to2014M: round(gmsl(year, scenario), 2), source: "IPCC AR6 WG1 Table 9.9 (approximate medians)" };
      },
    },
    {
      name: "earthquakes",
      description: "Recent earthquakes from the USGS feed in an area.",
      inputSchema: { type: "object", properties: { area: AREA_SCHEMA, days: { type: "integer" }, minMagnitude: { type: "number" } } },
      async execute({ area, days = 30, minMagnitude = 4.5 }) {
        const A = resolveArea(area);
        try {
          const j = await api(`/api/quakes?days=${days}&minmag=${minMagnitude}`);
          const up = unwrapPoly(A.poly);
          const qs = (j.features || []).filter((f) => pointInPoly({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }, up));
          return { area: A.label, days, count: qs.length, quakes: qs.slice(0, 25).map((f) => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString().slice(0, 16), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], depthKm: f.geometry.coordinates[2] })), source: "USGS" };
        } catch { return { error: "unavailable", hint: LIVE_HINT }; }
      },
    },
    {
      name: "natural_events",
      description: "Open natural events (wildfires, storms, volcanoes, floods, sea ice) from NASA EONET.",
      inputSchema: { type: "object", properties: { category: { type: "string", description: "wildfires | severeStorms | volcanoes | floods | seaLakeIce | all" }, days: { type: "integer" }, area: AREA_SCHEMA } },
      async execute({ category = "all", days = 30, area }) {
        try {
          const j = await api(`/api/events?category=${encodeURIComponent(category)}&days=${days}`);
          let ev = (j.events || []).map((e) => { const g = e.geometry?.[e.geometry.length - 1]; const c = g?.type === "Point" ? g.coordinates : null; return c ? { title: e.title, category: e.categories?.[0]?.title, date: g.date?.slice(0, 10), lat: c[1], lon: c[0] } : null; }).filter(Boolean);
          if (area) { const up = unwrapPoly(resolveArea(area).poly); ev = ev.filter((e) => pointInPoly(e, up)); }
          return { count: ev.length, events: ev.slice(0, 30), source: "NASA EONET" };
        } catch { return { error: "unavailable", hint: LIVE_HINT }; }
      },
    },
    {
      name: "country_indicators",
      description: "World Bank indicators for a country: population, GDP (current US$), GDP per capita, urban population share.",
      inputSchema: { type: "object", properties: { country: { type: "string", description: "Country name or ISO2/ISO3 code" } }, required: ["country"] },
      async execute({ country }) {
        try { if (!S.local) throw 0; return { ...(await api(`/api/indicators?country=${encodeURIComponent(country)}`)), source: "World Bank (live)" }; }
        catch {
          const q = country.toLowerCase();
          const c = COUNTRY_STATS.find((x) => x.iso3.toLowerCase() === q || x.iso2.toLowerCase() === q || x.name.toLowerCase() === q) || COUNTRY_STATS.find((x) => x.name.toLowerCase().startsWith(q));
          if (!c) return { error: `No country matched "${country}"` };
          return { country: c.name, iso3: c.iso3, population: c.pop, populationYear: c.popYear, gdpUSD: c.gdp, gdpYear: c.gdpYear, gdpPerCapitaUSD: c.gdp && c.pop ? Math.round(c.gdp / c.pop) : null, source: "World Bank (bundled snapshot)" };
        }
      },
    },
    {
      name: "historical_storm",
      description: "Replay a real tropical cyclone from any ocean basin (NOAA IBTrACS best tracks since 1980: hurricanes, typhoons, cyclones): draws the observed track and the model's forecast from the same start, returns peak intensity, model track and wind errors at 24-120 h, and cities over 100k hit by storm-force winds.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, year: { type: "integer" } }, required: ["name"] },
      async execute({ name, year }) {
        const r = await runReplay(year ? `${name} ${year}` : name);
        return r || { error: `No storm named ${name}${year ? " " + year : ""} in the best-track archive (all basins since 1980)` };
      },
    },
    {
      name: "simulate_surge",
      description: "Run the high-resolution shallow-water flood model (local inertial equations on detailed terrain) for a ~250 km window: a storm-surge pulse of surgeM metres on top of any sea-level rise floods inland and drains. Returns peak flooded area, peak people in flooded cells, max depth and timing. Takes several seconds.",
      inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" }, surgeM: { type: "number" }, hours: { type: "integer" }, seaRiseM: { type: "number" } }, required: ["lat", "lon"] },
      async execute({ lat, lon, surgeM = 3, hours = 36, seaRiseM }) {
        emit("mode:set", "whatif");
        return { ...(await runSurgeScenario({ lat, lon, surgeM, hours: Math.min(48, hours), sea: seaRiseM ?? S.sea })), method: "local inertial shallow-water (Bates et al. 2010), Manning n=0.03, closed side boundaries, sea cells follow a Gaussian surge hydrograph plus tide" };
      },
    },
    {
      name: "run_ensemble",
      description: "Run many perturbed simulations to get ranges and probabilities instead of one answer. type 'storm': 50 hurricane tracks from a genesis point (perturbed position, intensity and steering winds) -> per-city probability of hurricane- and storm-force winds, landfall share; draws spaghetti tracks and a probability map. type 'sea': flooded area and people in an area across sea levels (default 0.3-5 m).",
      inputSchema: { type: "object", properties: { type: { type: "string", enum: ["storm", "sea"] }, lat: { type: "number" }, lon: { type: "number" }, category: { type: "integer" }, members: { type: "integer" }, area: AREA_SCHEMA, levels: { type: "array", items: { type: "number" } } }, required: ["type"] },
      async execute({ type, lat, lon, category = 3, members = 50, area, levels }) {
        if (type === "storm") {
          const g = lat != null ? { lat, lon } : S.storm?.genesis;
          if (!g) return { error: "Give a genesis lat/lon over warm ocean" };
          emit("mode:set", "whatif");
          runStorm(g, { u: 0, v: 0 }, Math.max(1, Math.min(5, category)));
          const r = runEnsembleView(g, category, { u: 0, v: 0 }, Math.min(100, members));
          return { members: r.members, landfallShare: +r.landfallShare.toFixed(2), medianLandfallHour: r.medianLandfallHour, cities: r.cities.slice(0, 15).map((c) => ({ name: c.name, cc: c.cc, pop: c.pop, pHurricaneForce: +c.pHurricaneForce.toFixed(2), pStormForce: +c.pStormForce.toFixed(2) })), method: "perturbed genesis (σ 0.8°), intensity (±1 cat), steering wind (σ 2 m/s) and initial motion" };
        }
        const A = resolveArea(area);
        return { area: A.label, rows: await seaEnsemble(A.poly, levels || undefined), note: "people = everyone in 20 km cells the sea reaches (upper bound)" };
      },
    },
    {
      name: "live_hazards",
      description: "Live hazards right now: active hurricanes with NHC forecast cones, NASA FIRMS fire detections (24 h), USGS earthquakes (24 h). Turns the layer on and returns a summary.",
      inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["storms", "fires", "quakes"] } }, required: ["kind"] },
      async execute({ kind }) {
        if (!S.local) return { error: "unavailable", hint: LIVE_HINT };
        await setLive(kind, true);
        const d = LIVE.data[kind];
        if (!d) return { error: "unavailable" };
        if (kind === "storms") return { storms: d.storms.map((s) => ({ name: s.name, classification: s.classification, windKt: s.windKt, pressureHpa: s.pressureHpa, lat: s.lat, lon: s.lon, movement: s.movement, coneFeatures: s.cone.length })), source: d.source };
        if (kind === "fires") return { detections: d.count, strongest: d.fires.slice(0, 10).map(([lat, lon, frp]) => ({ lat, lon, frpMW: frp })), source: d.source };
        return { count: (d.features || []).length, largest: (d.features || []).slice(0, 10).map((f) => ({ mag: f.properties.mag, place: f.properties.place })), source: "USGS" };
      },
    },
    {
      name: "storm_model_skill",
      description: "How accurate the console's tropical cyclone model is: mean track error (km) and intensity error (kt) at 24/48/72 h on held-out storms since 2015 vs persistence baselines, for one ocean basin (NA, EP, WP, NI, SI, SP) or all.",
      inputSchema: { type: "object", properties: { basin: { type: "string", enum: ["NA", "EP", "WP", "NI", "SI", "SP"] } } },
      async execute({ basin } = {}) {
        await loadStorms();
        const r = modelSkill(basin || null);
        return { basin: basin || "all", heldOut: r.test, training1980to2014: r.train, note: "Parameters fitted per basin on 1980-2014 (track by 48 h position error, intensity by 48 h wind error). Positive skill = better than persistence.", source: STORMDATA.source };
      },
    },
    {
      name: "show_data_layer",
      description: "Draw a layer computed from real data. kind: lowland (land below maxElevM, risk gradient), flood (cells the Priority-Flood model floods at sea metres, depth gradient), elevation, density (population surface), population (cities sized by population), countries (borders), exposure (people in cells flooded at sea metres).",
      inputSchema: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: ["lowland", "flood", "elevation", "density", "population", "countries", "exposure"] }, area: AREA_SCHEMA, maxElevM: { type: "number" }, sea: { type: "number" }, palette: { type: "string", enum: ["risk", "heat", "cool", "depth"] } }, required: ["kind"] },
      async execute({ id, kind, area, maxElevM, sea, palette }) {
        const A = area ? resolveArea(area) : S.region ? resolveArea("selected") : null;
        const r = showDataLayer("ai:" + (id || kind), { kind, area: A?.poly, maxElev: maxElevM ?? 10, sea: sea ?? Math.max(S.sea, 2), palette });
        hooks.step?.(`Drew ${kind} layer`, r);
        return { drawn: true, ...r };
      },
    },
    {
      name: "show_layer",
      description: "Draw your own GeoJSON on the globe. Points: properties {label, note, radiusKm, intensity 0-1}. Lines: 2-point lines draw as arcs. Polygons fill. style: {fill, stroke, opacity, radiusKm, labelProperty, colorBy:{property, stops:[[value,'#hex'],...]} or {property, domain:[lo,hi], palette:'risk'|'heat'|'cool'|'depth'}}.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, geojson: { type: "object" }, style: { type: "object" } }, required: ["geojson"] },
      async execute({ id, title, geojson, style }) {
        const n = showGeoJSON("ai:" + (id || "l" + Date.now()), geojson, style || {}, title || "");
        return { drawn: n };
      },
    },
    {
      name: "set_view",
      description: "Fly the globe to a point. zoom: 1 (whole globe) to 5 (city region).",
      inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" }, zoom: { type: "number" } }, required: ["lat", "lon"] },
      async execute({ lat, lon, zoom = 2.5 }) {
        flyTo(lat, lon, 4.2 - Math.max(1, Math.min(5, zoom)) * 0.55);
        return { ok: true };
      },
    },
    {
      name: "propose_simulation",
      description: "Offer the user a What-If simulation that makes the answer tangible. type sea {meters}; hurricane {category 1-5, lat, lon genesis over warm ocean}; event {event: volcano|wildfire|meteor, lat, lon, size 0-2 for meteor}. The user decides whether to run it.",
      inputSchema: { type: "object", properties: { type: { type: "string", enum: ["sea", "hurricane", "event"] }, meters: { type: "number" }, category: { type: "integer" }, event: { type: "string" }, lat: { type: "number" }, lon: { type: "number" }, size: { type: "integer" }, why: { type: "string" } }, required: ["type", "why"] },
      async execute(sim) {
        hooks.proposeSimulation?.(sim);
        return { offered: true };
      },
    },
  ];
  // wrap with narration
  for (const t of T) {
    const run = t.execute;
    t.execute = async (input) => {
      const id = hooks.step?.(narrate(t.name, input), null, true);
      try {
        const r = await run(input || {});
        hooks.stepDone?.(id, r);
        hooks.record?.({ name: t.name, input: input || {}, result: r });
        return r;
      } catch (e) {
        hooks.stepDone?.(id, { error: String(e) });
        return { error: String(e.message || e) };
      }
    };
  }
  return T;
}

function narrate(name, i = {}) {
  const where = i.area && typeof i.area === "object" ? ` around ${i.area.lat?.toFixed?.(1)}, ${i.area.lon?.toFixed?.(1)}` : i.area === "selected" ? " in the selected region" : "";
  switch (name) {
    case "geocode": return `Locating ${i.query}`;
    case "region_summary": return `Measuring terrain and population${where}`;
    case "list_cities": return `Listing cities${where}`;
    case "flood_impact": return `Running the flood model at +${i.meters} m${where}`;
    case "elevation_at": return `Reading elevation at ${i.lat?.toFixed(1)}, ${i.lon?.toFixed(1)}`;
    case "wind_at": return `Reading winds at ${i.lat?.toFixed(1)}, ${i.lon?.toFixed(1)}`;
    case "sea_level_projection": return `Looking up IPCC sea level for ${i.year}`;
    case "earthquakes": return `Fetching USGS earthquakes${where}`;
    case "natural_events": return `Fetching NASA natural events`;
    case "country_indicators": return `Fetching World Bank indicators for ${i.country}`;
    case "show_data_layer": return `Drawing ${i.kind} layer`;
    case "show_layer": return `Drawing ${i.title || "layer"}`;
    case "set_view": return `Moving the view`;
    case "propose_simulation": return `Preparing a simulation`;
    case "simulate_surge": return `Running the shallow-water surge model at ${i.lat?.toFixed(1)}, ${i.lon?.toFixed(1)} (+${i.surgeM ?? 3} m)`;
    case "run_ensemble": return i.type === "storm" ? `Running a ${i.members || 50}-track hurricane ensemble` : `Running the flood model across sea levels`;
    case "live_hazards": return `Fetching live ${i.kind}`;
    case "historical_storm": return `Replaying ${i.name}${i.year ? " " + i.year : ""} against the model`;
    case "storm_model_skill": return `Scoring the storm model against 50 years of tracks`;
    default: return name;
  }
}

export { CITIES, haversine, polyCentroid };
