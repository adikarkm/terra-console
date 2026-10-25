// Unified globe actions. Mouse, touch, webcam hands and XR controllers all call
// begin/move/end with screen coordinates (or a lat/lon for XR rays).
import { S, emit } from "../state.js";
import { $ } from "../util/dom.js";
import { G, pick, rotateBy, zoomBy, tiltBy } from "../globe/scene.js";
import { lassoStart, lassoMove, lassoEnd } from "../modes/ask.js";
import { runStorm, addHazard } from "../modes/whatif.js";
import { haversine, bearing, fmtLat, fmtLon, DEG } from "../util/geo.js";
import { sampleDEM } from "../data/dem.js";
import { countryAt } from "../data/places.js";
import { altitudeKm } from "../globe/scene.js";

let act = null;

export function decideAction(src, { shift = false } = {}) {
  if (S.mode === "ask") return src === "hand" || src === "xr" || shift || S.askTool === "lasso" ? "lasso" : "rotate";
  if (shift) return "lasso";
  if (S.wiTool === "storm") return "storm";
  if (S.wiTool === "event") return "event";
  return "rotate";
}

export function begin(x, y, src = "mouse", opts = {}) {
  const kind = opts.kind || decideAction(src, opts);
  const geo = opts.geo || pick(x, y);
  act = { kind, x, y, src, start: geo, last: geo };
  if (kind === "rotate" || kind === "tilt") return act;
  if (!geo) { act.kind = "rotate"; return act; }
  if (kind === "lasso") lassoStart(geo);
  if (kind === "event") { addHazard(S.eventType, geo); emit("sim:changed", "event"); act.kind = "none"; }
  return act;
}

export function move(x, y, opts = {}) {
  if (!act) return;
  if (act.kind === "tilt") {
    tiltBy((act.y - y) * 0.006);
    rotateBy(x - act.x, 0, opts.gain || 1);
  } else if (act.kind === "rotate") {
    rotateBy(x - act.x, y - act.y, opts.gain || 1);
  } else {
    const geo = opts.geo || pick(x, y);
    if (geo) {
      if (act.kind === "lasso") lassoMove(geo);
      act.last = geo;
    }
  }
  act.x = x;
  act.y = y;
}

export function end() {
  if (!act) return;
  const a = act;
  act = null;
  if (a.kind === "lasso") lassoEnd();
  if (a.kind === "storm" && a.start) {
    const km = a.last ? haversine(a.start, a.last) : 0;
    let push = { u: 0, v: 0 };
    if (km > 40) {
      const b = bearing(a.start, a.last) * DEG, s = Math.min(8, km / 120);
      push = { u: Math.sin(b) * s, v: Math.cos(b) * s };
    }
    runStorm(a.start, push);
    emit("sim:changed", "storm");
  }
}

export function active() {
  return act;
}

export function initPointer(canvas) {
  const pointers = new Map();
  let pinch0 = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      end();
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    if (e.button === 2 || e.ctrlKey) begin(e.clientX, e.clientY, "mouse", { kind: "tilt" });
    else begin(e.clientX, e.clientY, e.pointerType === "touch" ? "touch" : "mouse", { shift: e.shiftKey });
  });
  canvas.addEventListener("pointermove", (e) => {
    hover(e.clientX, e.clientY);
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) zoomBy(pinch0 / d);
      pinch0 = d;
      return;
    }
    move(e.clientX, e.clientY);
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
    if (pointers.size === 0) end();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") canvas.classList.add("draw");
    if (e.target.matches?.("input, textarea, select")) return;
    if (e.key === "PageUp") tiltBy(0.1);
    if (e.key === "PageDown") tiltBy(-0.1);
    if (e.key === "+" || e.key === "=") zoomBy(0.7);
    if (e.key === "-") zoomBy(1.4);
  });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") updateCursor(); });
}

export function updateCursor() {
  const c = G.renderer.domElement;
  c.classList.toggle("draw", decideAction("mouse") !== "rotate");
}

let hoverT = 0;
export function hover(x, y) {
  const now = performance.now();
  if (now - hoverT < 50) return;
  hoverT = now;
  const p = pick(x, y);
  emit("hover", p);
  const el = $("#roPos");
  if (!p) { el.textContent = "—"; return; }
  const d = sampleDEM(p.lat, p.lon);
  const co = d.kind === "land" ? countryAt(p.lat, p.lon) : null;
  const a = altitudeKm();
  el.textContent = `${fmtLat(p.lat)}  ${fmtLon(p.lon)}  ·  ${d.kind === "ocean" ? "ocean" : `${Math.round(d.elev).toLocaleString()} m`}${co ? `  ·  ${co.name}` : ""}  ·  eye ${a >= 100 ? Math.round(a).toLocaleString() : a.toFixed(1)} km`;
}
