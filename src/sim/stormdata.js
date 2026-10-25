// Best-track archive, loaded on demand (it is the largest dataset after the town names).
// v2 (IBTrACS, all basins): { v: 2, s: [[name, year, basin, sid, startIso, h,lat10,lon10,kt,hPa,r34, ...], ...] }
// v1 (HURDAT2 via dplyr, Atlantic): [{ n, y, id, start, p: [[h, lat, lon, kt, hPa, r34], ...] }, ...]
// Both decode to { n, y, b, id, start, p: [[hours, lat, lon, windKt, pressureHpa|null, r34Km|null], ...] }.

export const STORMDATA = { storms: [], source: "", loaded: false, promise: null };

export function decodeStorms(raw) {
  if (Array.isArray(raw)) return { source: "NOAA HURDAT2 (via dplyr storms)", storms: raw.map((s) => ({ ...s, b: s.b || "NA" })) };
  const storms = raw.s.map((r) => {
    const p = [];
    for (let i = 5; i + 5 < r.length; i += 6) p.push([r[i], r[i + 1] / 10, r[i + 2] / 10, r[i + 3], r[i + 4] || null, r[i + 5] || null]);
    const id = `${r[0]}-${r[1]}-${r[3]}`;
    return { n: r[0], y: r[1], b: r[2], sid: r[3], id, start: r[4], p };
  });
  return { source: raw.source, storms };
}

export function loadStorms() {
  if (!STORMDATA.promise) {
    STORMDATA.promise = import("../data/generated/storms.json").then((m) => {
      const d = decodeStorms(m.default);
      STORMDATA.storms = d.storms;
      STORMDATA.source = d.source;
      STORMDATA.loaded = true;
      return STORMDATA.storms;
    });
  }
  return STORMDATA.promise;
}

export const storms = () => STORMDATA.storms;
