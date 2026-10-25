// WebXR: step into the globe room on Quest / Vision Pro. Hands (or controllers) grab to spin,
// two hands scale, pinch-and-point (or trigger) draws regions or places events, and a floating
// panel carries mode buttons, sea level and the latest AI answer.
import * as THREE from "three";
import { S, emit, on } from "../state.js";
import { toast } from "../util/dom.js";
import { G, pickRay, onFrame } from "../globe/scene.js";
import { begin, move, end } from "../input/pointer.js";
import { setSea } from "../modes/whatif.js";

const X = { session: null, mode: null, hands: [], ctrls: [], grab: null, twoHand: null, panel: null, buttons: [], answer: "", rayLine: [] };

export async function xrSupport() {
  if (!navigator.xr) return { vr: false, ar: false };
  const [vr, ar] = await Promise.all([navigator.xr.isSessionSupported("immersive-vr").catch(() => false), navigator.xr.isSessionSupported("immersive-ar").catch(() => false)]);
  return { vr, ar };
}

const LG_URL = "https://cdn.jsdelivr.net/npm/@lookingglass/webxr@0.6.0/+esm";
// Looking Glass holographic displays: the official WebXR polyfill routes an immersive-vr session to
// the Looking Glass window (needs Looking Glass Bridge running on the computer).
export async function enterLookingGlass() {
  try {
    if (!X.lg) {
      const url = LG_URL;
      const mod = await import(/* webpackIgnore: true */ url);
      X.lg = new mod.LookingGlassWebXRPolyfill({ targetX: 0, targetY: 0, targetZ: 0, targetDiam: 2.6, fovy: (14 * Math.PI) / 180 });
    }
    await enterXR("immersive-vr", { lookingGlass: true });
  } catch (e) {
    toast(`Looking Glass couldn't start: ${e.message || e}. Install and run Looking Glass Bridge, connect the display, then try again (see docs/XR.md).`, 7000);
  }
}

export async function enterXR(kind = "immersive-ar", opts = {}) {
  if (!navigator.xr && !opts.lookingGlass) { toast("WebXR isn't available in this browser. Open the local version in the Quest or Vision Pro browser (see docs/XR.md)."); return; }
  try {
    const session = await navigator.xr.requestSession(kind, opts.lookingGlass ? {} : { optionalFeatures: ["local-floor", "hand-tracking", "bounded-floor"] });
    X.session = session;
    X.mode = kind;
    G.renderer.xr.setReferenceSpaceType(opts.lookingGlass ? "local" : "local-floor");
    await G.renderer.xr.setSession(session);
    if (kind === "immersive-ar") G.scene.background = null;
    if (opts.lookingGlass) { G.root.position.set(0, 0, 0); G.root.scale.setScalar(1); }
    else { G.root.position.set(0, 1.25, -0.85); G.root.scale.setScalar(0.3); }
    G.autoSpin = false;
    if (!opts.lookingGlass) { setupInputs(); buildPanel(); }
    session.addEventListener("end", exitCleanup);
    emit("xr:state", true);
  } catch (e) {
    toast(`Couldn't start ${kind === "immersive-ar" ? "AR" : "VR"}: ${e.message || e}. On a headset, the page must be served over HTTPS (see docs/XR.md).`, 6000);
  }
}

function exitCleanup() {
  G.scene.background = new THREE.Color(0x03080f);
  G.root.position.set(0, 0, 0);
  G.root.scale.setScalar(1);
  for (const o of [...X.ctrls, ...X.hands, X.panel]) if (o) o.parent?.remove(o);
  X.ctrls = []; X.hands = []; X.panel = null; X.session = null;
  emit("xr:state", false);
}

function setupInputs() {
  const r = G.renderer;
  for (let i = 0; i < 2; i++) {
    const c = r.xr.getController(i);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x62d6ff, transparent: true, opacity: 0.6 }));
    line.scale.z = 2;
    c.add(line);
    c.userData = { index: i, selecting: false, squeezing: false };
    c.addEventListener("selectstart", () => onSelect(c, true));
    c.addEventListener("selectend", () => onSelect(c, false));
    c.addEventListener("squeezestart", () => { c.userData.squeezing = true; startGrab(c); });
    c.addEventListener("squeezeend", () => { c.userData.squeezing = false; stopGrab(c); });
    G.scene.add(c);
    X.ctrls.push(c);
    const hand = r.xr.getHand(i);
    hand.userData = { index: i, pinching: false };
    G.scene.add(hand);
    X.hands.push(hand);
  }
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), dir = new THREE.Vector3(), center = new THREE.Vector3();

function handJoint(hand, name) {
  const j = hand.joints?.[name];
  return j && j.visible !== false ? j : null;
}

// grabbing: hand/controller near the globe spins it by its motion
function startGrab(src) { X.grab = { src, last: worldPos(src).clone() }; }
function stopGrab(src) { if (X.grab?.src === src) X.grab = null; }
function worldPos(o) {
  if (o.joints) { const t = handJoint(o, "index-finger-tip"), th = handJoint(o, "thumb-tip"); if (t && th) return t.getWorldPosition(tmpA).lerp(th.getWorldPosition(tmpB), 0.5); }
  return o.getWorldPosition(tmpA);
}

function rayFrom(src) {
  if (src.joints) {
    const tip = handJoint(src, "index-finger-tip"), base = handJoint(src, "index-finger-phalanx-proximal");
    if (!tip || !base) return null;
    const o = base.getWorldPosition(new THREE.Vector3());
    return { origin: o, dir: tip.getWorldPosition(new THREE.Vector3()).sub(o).normalize() };
  }
  const o = src.getWorldPosition(new THREE.Vector3());
  return { origin: o, dir: new THREE.Vector3(0, 0, -1).applyQuaternion(src.getWorldQuaternion(new THREE.Quaternion())).normalize() };
}

function onSelect(src, down) {
  const ray = rayFrom(src);
  if (!ray) return;
  if (down) {
    const btn = hitPanel(ray);
    if (btn) { btn.userData.onClick(); return; }
    const hit = pickRay(ray.origin, ray.dir);
    if (hit) { X.drawing = src; begin(0, 0, "xr", { geo: hit }); }
  } else if (X.drawing === src) { X.drawing = null; end(); }
}

onFrame(() => {
  if (!X.session) return;
  // hand pinch detection
  for (const hand of X.hands) {
    const t = handJoint(hand, "index-finger-tip"), th = handJoint(hand, "thumb-tip");
    if (!t || !th) continue;
    const d = t.getWorldPosition(tmpA).distanceTo(th.getWorldPosition(tmpB));
    const pinch = d < (hand.userData.pinching ? 0.035 : 0.02);
    if (pinch !== hand.userData.pinching) {
      hand.userData.pinching = pinch;
      G.root.getWorldPosition(center);
      const near = worldPos(hand).distanceTo(center) < 0.45 * (G.root.scale.x / 0.3) + 0.1;
      if (pinch) near ? startGrab(hand) : onSelect(hand, true);
      else { stopGrab(hand); onSelect(hand, false); }
    }
  }
  // two-handed scale
  const grabbing = X.hands.filter((h) => h.userData.pinching);
  if (grabbing.length === 2) {
    const pa = worldPos(grabbing[0]).clone();
    const d = pa.distanceTo(worldPos(grabbing[1]));
    if (X.twoHand) G.root.scale.setScalar(Math.max(0.08, Math.min(1.5, G.root.scale.x * (d / X.twoHand))));
    X.twoHand = d;
    X.grab = null;
  } else X.twoHand = null;
  // one-handed spin
  if (X.grab) {
    const p = worldPos(X.grab.src).clone();
    const dx = p.x - X.grab.last.x, dy = p.y - X.grab.last.y;
    const k = 3.2 / (G.root.scale.x / 0.3);
    G.rotY += dx * k;
    G.rotX = Math.max(-1.35, Math.min(1.35, G.rotX - dy * k));
    X.grab.last.copy(p);
  }
  // drawing with a ray
  if (X.drawing) {
    const ray = rayFrom(X.drawing);
    const hit = ray && pickRay(ray.origin, ray.dir);
    if (hit) move(0, 0, { geo: hit });
  }
});

// ---- floating panel -------------------------------------------------------------------------
function textTexture(lines, w = 1024, h = 512, title = "") {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(7,20,33,0.88)";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(98,214,255,0.6)";
  g.lineWidth = 4;
  g.strokeRect(2, 2, w - 4, h - 4);
  g.fillStyle = "#62d6ff";
  g.font = "600 44px sans-serif";
  if (title) g.fillText(title, 28, 64);
  g.fillStyle = "#d9f2ff";
  g.font = "30px sans-serif";
  let y = title ? 116 : 56;
  for (const raw of lines) {
    const words = raw.split(" ");
    let line = "";
    for (const wd of words) {
      if (g.measureText(line + wd).width > w - 56) { g.fillText(line, 28, y); y += 40; line = ""; }
      line += wd + " ";
      if (y > h - 30) break;
    }
    g.fillText(line, 28, y); y += 48;
    if (y > h - 30) break;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function button(label, x, y, onClick) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.06), new THREE.MeshBasicMaterial({ map: textTexture([label], 320, 120), transparent: true }));
  m.position.set(x, y, 0.001);
  m.userData.onClick = onClick;
  X.buttons.push(m);
  return m;
}

function buildPanel() {
  const panel = new THREE.Group();
  panel.position.set(0.55, 1.25, -0.75);
  panel.rotation.y = -0.5;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshBasicMaterial({ transparent: true }));
  board.name = "answer";
  panel.add(board);
  X.buttons = [];
  const row = -0.17;
  panel.add(button("Ask", -0.17, row, () => emit("mode:set", "ask")));
  panel.add(button("What-If", 0, row, () => emit("mode:set", "whatif")));
  panel.add(button("Exit", 0.17, row, () => X.session?.end()));
  panel.add(button("Sea +1 m", -0.085, row - 0.075, () => setSea(S.sea + 1)));
  panel.add(button("Sea −1 m", 0.085, row - 0.075, () => setSea(Math.max(0, S.sea - 1))));
  G.scene.add(panel);
  X.panel = panel;
  refreshPanel();
}

function refreshPanel() {
  const board = X.panel?.getObjectByName("answer");
  if (!board) return;
  board.material.map?.dispose();
  const lines = X.answer ? [X.answer] : [S.mode === "ask" ? "Pinch away from the globe and point to draw a region. Pinch on the globe to spin it; pinch with both hands to scale." : `Sea level +${S.sea.toFixed(1)} m. Point and pinch to place storms or events.`];
  board.material.map = textTexture(lines, 1024, 512, S.mode === "ask" ? "Ask the Earth" : "What-If Earth");
  board.material.needsUpdate = true;
}

const panelRay = new THREE.Raycaster();
function hitPanel(ray) {
  if (!X.panel) return null;
  panelRay.set(ray.origin, ray.dir);
  return panelRay.intersectObjects(X.buttons, false)[0]?.object || null;
}

on("mode", refreshPanel);
on("sea", refreshPanel);
on("answer:text", (t) => { X.answer = t.slice(0, 600); refreshPanel(); });
