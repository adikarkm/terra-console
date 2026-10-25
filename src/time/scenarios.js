// Global mean sea level, metres relative to the 1995–2014 baseline.
// Historical: tide-gauge / altimetry reconstructions (~0.20 m rise 1901–2018).
// Projections: approximate medians from IPCC AR6 WG1 Table 9.9; "High-end" is the
// SSP5-8.5 low-likelihood, high-impact storyline (83rd percentile incl. ice-sheet instability).
const HIST = [[1900, -0.16], [1950, -0.1], [1990, -0.03], [2005, 0], [2020, 0.06], [2026, 0.09]];

export const SCENARIOS = {
  ssp126: { label: "SSP1-2.6 · low emissions", pts: [[2050, 0.19], [2100, 0.44], [2150, 0.68]] },
  ssp245: { label: "SSP2-4.5 · current policies", pts: [[2050, 0.2], [2100, 0.56], [2150, 0.92]] },
  ssp585: { label: "SSP5-8.5 · very high emissions", pts: [[2050, 0.23], [2100, 0.77], [2150, 1.32]] },
  highend: { label: "High-end · ice-sheet collapse", pts: [[2050, 0.3], [2100, 1.6], [2150, 4.8]] },
};

export const PRESENT_YEAR = 2026;

function interp(pts, year) {
  if (year <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (year <= pts[i][0]) {
      const [y0, v0] = pts[i - 1], [y1, v1] = pts[i];
      return v0 + ((v1 - v0) * (year - y0)) / (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

export function gmsl(year, scenario = "ssp245") {
  const s = SCENARIOS[scenario] || SCENARIOS.ssp245;
  return interp([...HIST, ...s.pts], year);
}

// metres relative to today (negative = lower than today)
export function seaRelativeToToday(year, scenario) {
  return gmsl(year, scenario) - gmsl(PRESENT_YEAR, scenario);
}
