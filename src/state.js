// Shared application state and a tiny event bus. Modules communicate through events so
// input sources (mouse, hands, voice, XR, remote peers) all drive the same actions.

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function emit(evt, data) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (e) {
      console.error(`[bus] ${evt}`, e);
    }
  }
}

export const S = {
  mode: "ask", // "ask" | "whatif"
  askTool: "lasso", // "rotate" | "lasso"
  wiTool: "rotate", // "rotate" | "storm" | "event"
  region: null, // { poly:[{lat,lon}], stats, centroid }
  sea: 0, // metres above present
  seaShown: 0, // animated value on the GPU
  storm: null, // { genesis, cat, track:[{lat,lon,cat,t}] }
  stormCat: 3,
  eventType: "volcano",
  meteorSize: 1,
  events: [],
  windLayer: false,
  windSource: "climatology",
  holo: 1,
  year: 2026,
  scenario: "ssp245",
  timeOpen: false,
  ai: { kind: "offline", label: "AI · offline" },
  hands: false,
  voice: false,
  collab: { connected: false, name: "", peers: [] },
  local: false, // served by the Terra Console local server
  wake: false, // require the wake word "Terra"
  deixis: null, // last point resolved from "this / here"
};

export const env = {
  // true inside a claude.ai artifact viewer
  artifact: typeof window !== "undefined" && !!window.claude,
};
