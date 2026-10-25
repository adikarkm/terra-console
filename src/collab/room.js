// Multi-user rooms. Same protocol over two transports:
//  - the artifact viewer's `room` capability (published page, shared with teammates)
//  - WebSockets to the local server (/ws?room=NAME)
// Shared: live cursors (hand or mouse) drawn as beams on the globe, drawn regions,
// AI answers and the What-If simulation state.
import * as THREE from "three";
import { S, emit, on } from "../state.js";
import { $, h, toast } from "../util/dom.js";
import { group, clearGroup, sprite, tube, label, removeLabels, moveLabel } from "../globe/overlays.js";
import { ll2v } from "../util/geo.js";
import { onFrame } from "../globe/scene.js";

const COLORS = ["#ff7ad9", "#7dff9b", "#ffd166", "#a78bfa", "#5eead4", "#fb923c"];
const C = { t: null, me: { nick: "", color: COLORS[(Math.random() * COLORS.length) | 0] }, peers: new Map(), g: null, cursorT: 0, lastCursor: null };

// ---- transports ------------------------------------------------------------------------------
async function claudeRoom() {
  const room = await window.claude?.use?.("room");
  if (!room) return null;
  const user = await window.claude.use("user");
  try { const me = await user?.me?.(); if (me?.name) C.me.nick = me.name.split(" ")[0]; } catch {}
  return {
    kind: "Shared page",
    emit: (topic, data) => room.emit(topic, data).catch(() => {}),
    on: (topic, fn) => room.on(topic, (m) => { if (!m.sameTab) fn(m.data, m.peer); }),
    presence: (p) => room.presence(p).catch(() => {}),
    onPeers: (fn) => room.onPeers((c) => fn(c.peers.filter((p) => !p.sameTab).map((p) => ({ id: p.peer, presence: p.presence, guest: p.guest })))),
  };
}

function wsRoom(name) {
  return new Promise((resolve) => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?room=${encodeURIComponent(name)}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return resolve(null); }
    const handlers = new Map();
    let peersFn = null;
    const peers = new Map();
    let myId = null;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "hello") { myId = m.id; for (const p of m.peers || []) peers.set(p.id, p); peersFn?.([...peers.values()]); }
      else if (m.type === "presence") { if (m.id !== myId) { peers.set(m.id, { id: m.id, presence: m.presence }); peersFn?.([...peers.values()]); } }
      else if (m.type === "leave") { peers.delete(m.id); peersFn?.([...peers.values()]); }
      else if (m.type === "event" && m.id !== myId) handlers.get(m.topic)?.forEach((fn) => fn(m.data, m.id));
    };
    ws.onopen = () => resolve({
      kind: `Room “${name}”`,
      emit: (topic, data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "event", topic, data })),
      on: (topic, fn) => { if (!handlers.has(topic)) handlers.set(topic, new Set()); handlers.get(topic).add(fn); },
      presence: (p) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "presence", presence: p })),
      onPeers: (fn) => { peersFn = fn; },
      close: () => ws.close(),
    });
    ws.onerror = () => resolve(null);
    ws.onclose = () => { if (C.t?.kind?.startsWith("Room")) { C.t = null; S.collab.connected = false; emit("collab:state", false); toast("Left the room (connection closed)."); } };
  });
}

// ---- lifecycle ------------------------------------------------------------------------------------
export function initCollab(hooks) {
  C.g = group("peers");
  C.hooks = hooks;
  onFrame(animatePeers);
  // auto-join the shared page room when the viewer offers one
  claudeRoom().then((t) => { if (t) connect(t); }).catch(() => {});
  on("hover", (p) => sendCursor(p));
}

export async function joinLocalRoom(name) {
  if (!S.local) { toast("Named rooms need the local server. The published page shares one room with everyone who opens it."); return false; }
  const t = await wsRoom(name || "terra");
  if (!t) { toast("Couldn't reach the room server."); return false; }
  C.t?.close?.();
  connect(t);
  return true;
}

function connect(t) {
  C.t = t;
  if (!C.me.nick) C.me.nick = "Guest-" + Math.random().toString(36).slice(2, 6);
  S.collab = { connected: true, name: t.kind, peers: [] };
  t.presence({ nick: C.me.nick, color: C.me.color, mode: S.mode });
  t.onPeers(renderPeers);
  t.on("region", (d) => { if (Array.isArray(d?.poly)) { showPeerRegion(d); C.hooks.onRegion?.(d); } });
  t.on("answer", (d) => { if (d?.q && d?.text) C.hooks.onAnswer?.({ ...d, from: d.nick }); });
  t.on("sim", (d) => { if (d?.state) { C.hooks.onSim?.(d.state); if (d.nick) toast(`${d.nick} changed the simulation`); } });
  emit("collab:state", true);
  toast(`Connected: ${t.kind}`);
}

export function setNick(n) {
  C.me.nick = n.slice(0, 24) || C.me.nick;
  C.t?.presence({ nick: C.me.nick });
}

function sendCursor(p) {
  if (!C.t) return;
  const now = performance.now();
  if (now - C.cursorT < 60) return;
  C.cursorT = now;
  C.t.presence({ lat: p ? +p.lat.toFixed(3) : null, lon: p ? +p.lon.toFixed(3) : null, mode: S.mode, hand: S.hands });
}

export function shareRegion(poly) {
  if (!C.t) return;
  const step = Math.max(1, Math.ceil((poly?.length || 0) / 110));
  const slim = poly ? poly.filter((_, i) => i % step === 0).map((p) => [+p.lat.toFixed(3), +p.lon.toFixed(3)]) : [];
  C.t.emit("region", { nick: C.me.nick, color: C.me.color, poly: slim });
}
export function shareAnswer(a) {
  C.t?.emit("answer", { nick: C.me.nick, q: String(a.q).slice(0, 300), text: String(a.text).slice(0, 3300), source: a.source });
}
export function shareSim(state) {
  C.t?.emit("sim", { nick: C.me.nick, state });
}

// ---- rendering --------------------------------------------------------------------------------------
function renderPeers(list) {
  S.collab.peers = list;
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    let v = C.peers.get(p.id);
    const pr = p.presence || {};
    const color = /^#[0-9a-f]{6}$/i.test(pr.color || "") ? pr.color : "#ff7ad9";
    if (!v) {
      const g = new THREE.Group();
      const dot = sprite(0, 0, { color: new THREE.Color(color).getHex(), size: 0.05 });
      const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
      g.add(dot, beam);
      C.g.add(g);
      v = { g, dot, beam, lbl: label(0, 0, "", "", g), color };
      C.peers.set(p.id, v);
    }
    v.target = pr.lat != null ? { lat: pr.lat, lon: pr.lon } : null;
    v.g.visible = !!v.target;
    v.lbl.el.innerHTML = `${escape(pr.nick || "Guest")}${p.guest ? " (guest)" : ""}<small>${pr.hand ? "hand · " : ""}${pr.mode === "whatif" ? "What-If" : "Ask"}</small>`;
    v.lbl.el.style.color = color;
  }
  for (const [id, v] of C.peers) if (!seen.has(id)) { removeLabels(v.g); clearGroup(v.g); C.g.remove(v.g); C.peers.delete(id); }
  emit("collab:peers", list);
}

function animatePeers() {
  for (const v of C.peers.values()) {
    if (!v.target) continue;
    v.cur = v.cur ? { lat: v.cur.lat + (v.target.lat - v.cur.lat) * 0.25, lon: v.cur.lon + (((v.target.lon - v.cur.lon + 540) % 360) - 180) * 0.25 } : v.target;
    ll2v(v.cur.lat, v.cur.lon, 1.012, v.dot.position);
    const a = ll2v(v.cur.lat, v.cur.lon, 1.004), b = ll2v(v.cur.lat, v.cur.lon, 1.22);
    v.beam.geometry.attributes.position.setXYZ(0, a.x, a.y, a.z);
    v.beam.geometry.attributes.position.setXYZ(1, b.x, b.y, b.z);
    v.beam.geometry.attributes.position.needsUpdate = true;
    moveLabel(v.lbl, v.cur.lat, v.cur.lon);
  }
}

const peerRegions = new Map();
function showPeerRegion(d) {
  const key = d.nick || "peer";
  let g = peerRegions.get(key);
  if (!g) { g = new THREE.Group(); C.g.add(g); peerRegions.set(key, g); }
  clearGroup(g);
  removeLabels(g);
  if (!d.poly.length) return;
  const pts = d.poly.map(([lat, lon]) => ({ lat, lon }));
  const color = /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#ff7ad9";
  const t = tube(pts, { color: new THREE.Color(color).getHex(), closed: true, radius: 0.003 });
  if (t) g.add(t);
  label(pts[0].lat, pts[0].lon, `${escape(d.nick || "Peer")}'s region`, "", g);
  toast(`${d.nick || "A peer"} selected a region`);
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export { C as Collab };
