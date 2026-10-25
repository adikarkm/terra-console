// Procedural spatial soundscape (Web Audio). Every sound is synthesised from noise and
// oscillators: hurricane wind, fire crackle, volcanic rumble, waves over flooded coasts and a
// quiet console hum. Each source is HRTF-panned by where it sits on screen relative to the
// cursor or hand, and scaled by its distance on the globe and how close the camera is.
import { S, on } from "../state.js";
import { G, project, onFrame } from "../globe/scene.js";
import { haversine } from "../util/geo.js";
import { Flood } from "../sim/flood.js";
import { demIndex } from "../data/dem.js";

const A = { ctx: null, on: false, master: null, noise: null, voices: {}, cursor: null, cursorScreen: null };

function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.6 + last * 3; } // white + a touch of brown
  return b;
}

function noiseSrc() {
  const s = A.ctx.createBufferSource();
  s.buffer = A.noise;
  s.loop = true;
  s.loopStart = Math.random();
  s.start(0, Math.random() * 2);
  return s;
}

function panner() {
  const p = A.ctx.createPanner();
  p.panningModel = "HRTF";
  p.distanceModel = "inverse";
  p.refDistance = 1;
  p.rolloffFactor = 0.6;
  p.connect(A.master);
  return p;
}

function makeVoice(chain) {
  const gain = A.ctx.createGain();
  gain.gain.value = 0;
  const pan = panner();
  gain.connect(pan);
  chain(gain);
  return { gain, pan };
}

function build() {
  const ctx = A.ctx;
  A.master = ctx.createGain();
  A.master.gain.value = 0.9;
  A.master.connect(ctx.destination);
  A.noise = noiseBuffer(ctx);

  // console hum
  const hum = ctx.createGain();
  hum.gain.value = 0.025;
  hum.connect(A.master);
  for (const f of [55, 82.4, 110.2]) { const o = ctx.createOscillator(); o.frequency.value = f; o.detune.value = Math.random() * 8 - 4; o.connect(hum); o.start(); }

  // hurricane wind: band-passed noise with a sweeping centre frequency
  A.voices.wind = makeVoice((out) => {
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 600; bp.Q.value = 0.8;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.17;
    const lg = ctx.createGain(); lg.gain.value = 350; lfo.connect(lg).connect(bp.frequency); lfo.start();
    const low = ctx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = 180;
    const n = noiseSrc(); n.connect(bp).connect(out); n.connect(low).connect(out);
  });

  // fire: high crackle bursts over a low roar
  A.voices.fire = makeVoice((out) => {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1800;
    const crackle = ctx.createGain(); crackle.gain.value = 0;
    const n = noiseSrc(); n.connect(hp).connect(crackle).connect(out);
    const roar = ctx.createBiquadFilter(); roar.type = "lowpass"; roar.frequency.value = 260;
    const rg = ctx.createGain(); rg.gain.value = 0.5;
    noiseSrc().connect(roar).connect(rg).connect(out);
    const tick = () => {
      if (!A.ctx) return;
      const t = ctx.currentTime;
      for (let i = 0; i < 6; i++) { const s = t + Math.random() * 0.25; crackle.gain.setValueAtTime(0.9 * Math.random(), s); crackle.gain.exponentialRampToValueAtTime(0.001, s + 0.02 + Math.random() * 0.04); }
      setTimeout(tick, 250);
    };
    tick();
  });

  // volcano: sub rumble with slow surges
  A.voices.volcano = makeVoice((out) => {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 110;
    const g = ctx.createGain(); g.gain.value = 1.6;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
    const lg = ctx.createGain(); lg.gain.value = 0.7; lfo.connect(lg).connect(g.gain); lfo.start();
    noiseSrc().connect(lp).connect(g).connect(out);
  });

  // waves: low-passed noise swelling like surf
  A.voices.waves = makeVoice((out) => {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 650;
    const sw = ctx.createGain(); sw.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
    const lg = ctx.createGain(); lg.gain.value = 0.45; lfo.connect(lg).connect(sw.gain); lfo.start();
    noiseSrc().connect(lp).connect(sw).connect(out);
  });
}

export async function toggleSound(onOff = !A.on) {
  if (onOff && !A.ctx) {
    A.ctx = new (window.AudioContext || window.webkitAudioContext)();
    build();
  }
  if (!A.ctx) return false;
  A.on = onOff;
  if (onOff) await A.ctx.resume(); else await A.ctx.suspend();
  return A.on;
}

on("hover", (p) => { if (p) A.cursor = p; });

// place a voice: screen offset from the cursor -> stereo/HRTF position; globe distance -> level
function placeVoice(v, src, radiusKm, base) {
  const t = A.ctx.currentTime;
  if (!src) { v.gain.gain.setTargetAtTime(0, t, 0.3); return; }
  const ref = A.cursor || src;
  const dKm = haversine(ref, src);
  const zoom = Math.max(0.25, Math.min(1.2, (5 - G.dist) / 3));
  const level = base * zoom * Math.exp(-Math.max(0, dKm - radiusKm * 0.3) / (radiusKm + 400));
  v.gain.gain.setTargetAtTime(level, t, 0.25);
  const ps = project(src.lat, src.lon), pc = A.cursor ? project(A.cursor.lat, A.cursor.lon) : null;
  const dx = ps && pc ? (ps.x - pc.x) / innerWidth : 0;
  const dz = 1 + Math.min(6, dKm / 800);
  const x = dx * 4, z = -dz;
  if (v.pan.positionX) { v.pan.positionX.setTargetAtTime(x, t, 0.15); v.pan.positionZ.setTargetAtTime(z, t, 0.15); }
  else v.pan.setPosition(x, 0, z);
}

let acc = 0;
onFrame((dt) => {
  if (!A.on || !A.ctx) return;
  acc += dt;
  if (acc < 0.1) return;
  acc = 0;
  // storm: its current animated position (closest track point to the replay clock)
  let stormPos = null, stormR = 300;
  if (S.storm?.track?.length > 1) {
    const loop = 14, tr = S.storm.track;
    const p = tr[Math.floor(((G.clock.elapsedTime % loop) / loop) * (tr.length - 1))];
    if (p.v >= 34) { stormPos = p; stormR = 150 + 40 * Math.max(0, p.cat); }
  }
  placeVoice(A.voices.wind, stormPos, stormR, stormPos ? 0.25 + 0.12 * Math.max(0, stormPos.cat) : 0);
  const fire = S.events.find((e) => e.type === "wildfire");
  placeVoice(A.voices.fire, fire, 120, 0.9);
  const volc = S.events.find((e) => e.type === "volcano" || (e.type === "meteor" && e.size === 2));
  placeVoice(A.voices.volcano, volc, 300, 1.0);
  // waves: loud over flooded cells near the cursor
  let wave = null;
  if (S.sea > 0 && Flood.spill && A.cursor) {
    let hits = 0;
    for (const [dy, dx] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const i = demIndex(A.cursor.lat + dy, A.cursor.lon + dx);
      if (Flood.spill[i] <= S.sea && Flood.spill[i] >= 0) hits++;
    }
    if (hits) wave = { ...A.cursor, k: hits / 9 };
  }
  placeVoice(A.voices.waves, wave, 200, wave ? 0.2 + 0.5 * wave.k : 0);
});

export const Sound = A;
