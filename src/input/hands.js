// Webcam hand tracking with MediaPipe Hands. Built-in gestures drive the globe; a trained
// custom classifier (classifier.js) adds user-defined gestures bound to actions.
import { S, emit } from "../state.js";
import { $, toast, loadScript } from "../util/dom.js";
import { rotateBy, zoomBy } from "../globe/scene.js";
import { begin, move, end, active, hover } from "./pointer.js";
import { setSea } from "../modes/whatif.js";
import { features, Lib } from "./classifier.js";

const MP_VER = "0.4.1675469240";
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MP_VER}/`;

const H = { hands: null, stream: null, running: false, pinch: false, uiPinch: false, palmPrev: null, zoomPrev: null, fistPrev: null, victoryT: 0, lastToggle: 0, cur: null, recorder: null, customHeld: null, customT: 0, lastCustom: 0, lastLm: null };
export const HandState = H;

export async function startHands() {
  if (H.running) return true;
  try {
    H.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
  } catch (e) {
    toast("Camera unavailable here. Hand tracking runs in the local version (see README), or allow camera access.", 5000);
    return false;
  }
  const video = $("#camVideo");
  video.srcObject = H.stream;
  await video.play();
  $("#cam").hidden = false;
  try {
    if (!window.Hands) await loadScript(MP_BASE + "hands.js");
    H.hands = new window.Hands({ locateFile: (f) => MP_BASE + f });
    H.hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
    H.hands.onResults(onResults);
  } catch (e) {
    toast("Couldn't load the hand-tracking model (needs internet access to cdn.jsdelivr.net).", 5000);
    stopHands();
    return false;
  }
  H.running = true;
  S.hands = true;
  emit("hands:state", true);
  const loop = async () => {
    if (!H.running) return;
    if (video.readyState >= 2) { try { await H.hands.send({ image: video }); } catch {} }
    requestAnimationFrame(loop);
  };
  loop();
  return true;
}

export function stopHands() {
  H.running = false;
  S.hands = false;
  H.stream?.getTracks().forEach((t) => t.stop());
  H.stream = null;
  $("#cam").hidden = true;
  $("#handCursor").hidden = true;
  if (H.pinch) { end(); H.pinch = false; }
  emit("hands:state", false);
}

// map the central 76% of the camera frame to the whole screen (easier to reach edges), mirrored
function toScreen(p) {
  const nx = Math.min(1, Math.max(0, (1 - p.x - 0.12) / 0.76));
  const ny = Math.min(1, Math.max(0, (p.y - 0.12) / 0.76));
  return { x: nx * innerWidth, y: ny * innerHeight };
}

function analyze(lm, label) {
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  const size = d(0, 9) || 1e-3;
  const pinchR = d(4, 8) / size;
  const ext = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([t, p]) => d(t, 0) > d(p, 0) * 1.12);
  const n = ext.filter(Boolean).length;
  const pinch = pinchR < (H.pinch ? 0.45 : 0.3);
  let pose = "other";
  if (pinch) pose = "pinch";
  else if (n >= 4) pose = "open";
  else if (n === 0) pose = "fist";
  else if (ext[0] && ext[1] && !ext[2] && !ext[3]) pose = "victory";
  else if (ext[0] && !ext[1] && !ext[2] && !ext[3]) pose = "point";
  return { lm, label, pinch, pose, tip: toScreen(lm[8]), palm: toScreen(lm[9]), pinchPt: toScreen({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }) };
}

function drawPreview(res) {
  const c = $("#camCanvas"), g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  const LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  g.strokeStyle = "#62d6ff";
  g.fillStyle = "#ffb547";
  g.lineWidth = 2;
  for (const lm of res.multiHandLandmarks || []) {
    g.beginPath();
    for (const [a, b] of LINKS) { g.moveTo(lm[a].x * c.width, lm[a].y * c.height); g.lineTo(lm[b].x * c.width, lm[b].y * c.height); }
    g.stroke();
    for (const p of lm) { g.beginPath(); g.arc(p.x * c.width, p.y * c.height, 2.5, 0, 7); g.fill(); }
  }
}

const smooth = (prev, p, a = 0.4) => (prev ? { x: prev.x + (p.x - prev.x) * a, y: prev.y + (p.y - prev.y) * a } : p);

function onResults(res) {
  drawPreview(res);
  const lms = res.multiHandLandmarks || [];
  const labels = (res.multiHandedness || []).map((h) => h.label);
  const cursor = $("#handCursor");
  if (!lms.length) {
    $("#camPose").textContent = "No hand";
    cursor.hidden = true;
    if (H.pinch) { end(); H.pinch = false; }
    H.palmPrev = H.zoomPrev = H.fistPrev = null;
    H.cur = null;
    return;
  }
  const hs = lms.map((lm, i) => analyze(lm, labels[i]));
  H.lastLm = { lm: lms[0], label: labels[0] };

  // recording for the gesture trainer
  if (H.recorder) H.recorder(features(lms[0], labels[0]));

  // two hands: zoom by the distance between palms
  if (hs.length === 2 && hs.every((h) => h.pose === "open" || h.pose === "pinch")) {
    const d = Math.hypot(hs[0].palm.x - hs[1].palm.x, hs[0].palm.y - hs[1].palm.y);
    if (H.zoomPrev) zoomBy(H.zoomPrev / d);
    H.zoomPrev = d;
    $("#camPose").textContent = "Zoom";
    if (H.pinch) { end(); H.pinch = false; }
    H.palmPrev = null;
    return;
  }
  H.zoomPrev = null;
  const h = hs.find((x) => x.pinch) || hs[0];
  H.cur = smooth(H.cur, h.pinch ? h.pinchPt : h.tip, 0.45);
  cursor.hidden = false;
  cursor.style.left = H.cur.x + "px";
  cursor.style.top = H.cur.y + "px";
  cursor.className = h.pose === "pinch" ? "pinch" : h.pose === "fist" ? "fist" : "";

  // custom classifier
  let customName = null;
  if (Lib.model && !H.recorder) {
    const pr = Lib.predict(features(h.lm, h.label));
    if (pr && pr.conf > 0.85 && pr.cls.action !== "none") {
      customName = pr.cls.name;
      if (H.customHeld !== pr.index) { H.customHeld = pr.index; H.customT = performance.now(); }
      else if (performance.now() - H.customT > 350 && performance.now() - H.lastCustom > 1500) {
        H.lastCustom = performance.now();
        emit("gesture:custom", { action: pr.cls.action, name: pr.cls.name, at: H.cur });
      }
    } else H.customHeld = null;
  }
  const poseLabel = customName || { pinch: "Pinch", open: "Open palm", fist: "Fist", victory: "Peace", point: "Point", other: "Hand" }[h.pose];
  $("#camPose").textContent = poseLabel;
  cursor.dataset.pose = poseLabel;
  hover(H.cur.x, H.cur.y);
  if (customName) return;

  // peace sign held: switch mode
  if (h.pose === "victory") {
    if (!H.victoryT) H.victoryT = performance.now();
    if (performance.now() - H.victoryT > 800 && performance.now() - H.lastToggle > 2000) {
      H.lastToggle = performance.now();
      H.victoryT = 0;
      emit("mode:set", S.mode === "ask" ? "whatif" : "ask");
    }
  } else H.victoryT = 0;

  // pinch: press buttons, draw, place, grab
  if (h.pinch && !H.pinch) {
    H.pinch = true;
    const el = document.elementFromPoint(H.cur.x, H.cur.y);
    const ui = el && !el.closest("#stage") ? el.closest("button, .chip, input, [data-hand]") : null;
    if (ui) {
      H.uiPinch = ui;
      if (ui.type === "range") setRangeFromX(ui, H.cur.x);
      else ui.click();
    } else {
      H.uiPinch = null;
      begin(H.cur.x, H.cur.y, "hand", S.mode === "whatif" && S.wiTool === "rotate" ? { kind: "rotate" } : {});
    }
  } else if (h.pinch && H.pinch) {
    if (H.uiPinch?.type === "range") setRangeFromX(H.uiPinch, H.cur.x);
    else if (!H.uiPinch) move(H.cur.x, H.cur.y, { gain: 1.4 });
  } else if (!h.pinch && H.pinch) {
    H.pinch = false;
    if (!H.uiPinch) end();
    H.uiPinch = null;
  }

  // open palm: spin
  if (h.pose === "open") {
    const p = h.palm;
    if (H.palmPrev) rotateBy(p.x - H.palmPrev.x, p.y - H.palmPrev.y, 1.5);
    H.palmPrev = p;
  } else H.palmPrev = null;

  // fist: sea level up/down (What-If)
  if (h.pose === "fist" && S.mode === "whatif") {
    if (H.fistPrev != null) {
      const dy = H.fistPrev - h.palm.y;
      if (Math.abs(dy) > 0.5) setSea(Math.max(0, S.sea + dy * (0.02 + S.sea * 0.004)));
    }
    H.fistPrev = h.palm.y;
  } else H.fistPrev = null;
}

function setRangeFromX(input, x) {
  const r = input.getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (x - r.left) / r.width));
  input.value = String(+input.min + t * (+input.max - +input.min));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
