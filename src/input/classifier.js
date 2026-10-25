// Custom gesture classifier: a small neural network (MLP 63 -> 48 -> classes, ReLU, softmax)
// trained in the browser on MediaPipe hand landmarks the user records. No external ML library.

export function features(lm, handedness = "Right") {
  // translate to wrist, scale by palm size, mirror left hands so one model serves both
  const w = lm[0], m = lm[9];
  const s = Math.hypot(m.x - w.x, m.y - w.y, (m.z - w.z) * 0.5) || 1e-3;
  const flip = handedness === "Left" ? -1 : 1;
  const f = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    f[i * 3] = ((lm[i].x - w.x) / s) * flip;
    f[i * 3 + 1] = (lm[i].y - w.y) / s;
    f[i * 3 + 2] = (lm[i].z - w.z) / s;
  }
  return f;
}

function randn() {
  return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

export class MLP {
  constructor(nIn = 63, nHid = 48, nOut = 2, weights = null) {
    Object.assign(this, { nIn, nHid, nOut });
    if (weights) { Object.assign(this, { W1: Float32Array.from(weights.W1), b1: Float32Array.from(weights.b1), W2: Float32Array.from(weights.W2), b2: Float32Array.from(weights.b2) }); return; }
    this.W1 = Float32Array.from({ length: nIn * nHid }, () => randn() * Math.sqrt(2 / nIn));
    this.b1 = new Float32Array(nHid);
    this.W2 = Float32Array.from({ length: nHid * nOut }, () => randn() * Math.sqrt(2 / nHid));
    this.b2 = new Float32Array(nOut);
  }
  forward(x) {
    const { nIn, nHid, nOut, W1, b1, W2, b2 } = this;
    const h = new Float32Array(nHid);
    for (let j = 0; j < nHid; j++) { let s = b1[j]; for (let i = 0; i < nIn; i++) s += x[i] * W1[i * nHid + j]; h[j] = s > 0 ? s : 0; }
    const o = new Float32Array(nOut);
    let mx = -Infinity;
    for (let k = 0; k < nOut; k++) { let s = b2[k]; for (let j = 0; j < nHid; j++) s += h[j] * W2[j * nOut + k]; o[k] = s; if (s > mx) mx = s; }
    let sum = 0;
    for (let k = 0; k < nOut; k++) { o[k] = Math.exp(o[k] - mx); sum += o[k]; }
    for (let k = 0; k < nOut; k++) o[k] /= sum;
    return { h, p: o };
  }
  // Adam on cross-entropy with light augmentation (scale, rotation, jitter)
  train(X, Y, { epochs = 120, lr = 0.01, batch = 32, l2 = 1e-4, onEpoch } = {}) {
    const params = ["W1", "b1", "W2", "b2"];
    const m = {}, v = {};
    for (const k of params) { m[k] = new Float32Array(this[k].length); v[k] = new Float32Array(this[k].length); }
    const b1c = 0.9, b2c = 0.999;
    let step = 0;
    const idx = X.map((_, i) => i);
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
      for (let s = 0; s < idx.length; s += batch) {
        const g = {};
        for (const k of params) g[k] = new Float32Array(this[k].length);
        const B = idx.slice(s, s + batch);
        for (const n of B) {
          const x = augment(X[n]);
          const { h, p } = this.forward(x);
          const dO = Float32Array.from(p);
          dO[Y[n]] -= 1;
          for (let k = 0; k < this.nOut; k++) { g.b2[k] += dO[k]; for (let j = 0; j < this.nHid; j++) g.W2[j * this.nOut + k] += h[j] * dO[k]; }
          for (let j = 0; j < this.nHid; j++) {
            if (h[j] <= 0) continue;
            let d = 0;
            for (let k = 0; k < this.nOut; k++) d += dO[k] * this.W2[j * this.nOut + k];
            g.b1[j] += d;
            for (let i = 0; i < this.nIn; i++) g.W1[i * this.nHid + j] += x[i] * d;
          }
        }
        step++;
        for (const k of params) {
          const P = this[k], G = g[k], M = m[k], V = v[k];
          for (let i = 0; i < P.length; i++) {
            const gi = G[i] / B.length + l2 * P[i];
            M[i] = b1c * M[i] + (1 - b1c) * gi;
            V[i] = b2c * V[i] + (1 - b2c) * gi * gi;
            P[i] -= (lr * (M[i] / (1 - b1c ** step))) / (Math.sqrt(V[i] / (1 - b2c ** step)) + 1e-8);
          }
        }
      }
      if (onEpoch && ep % 10 === 9) onEpoch(ep + 1, this.accuracy(X, Y));
    }
    return this.accuracy(X, Y);
  }
  accuracy(X, Y) {
    let ok = 0;
    for (let n = 0; n < X.length; n++) { const p = this.forward(X[n]).p; let best = 0; for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k; if (best === Y[n]) ok++; }
    return X.length ? ok / X.length : 0;
  }
  toJSON() {
    return { nIn: this.nIn, nHid: this.nHid, nOut: this.nOut, W1: Array.from(this.W1), b1: Array.from(this.b1), W2: Array.from(this.W2), b2: Array.from(this.b2) };
  }
}

function augment(x) {
  const a = (Math.random() - 0.5) * 0.35, s = 1 + (Math.random() - 0.5) * 0.15;
  const c = Math.cos(a), sn = Math.sin(a);
  const y = new Float32Array(x.length);
  for (let i = 0; i < 21; i++) {
    const px = x[i * 3], py = x[i * 3 + 1];
    y[i * 3] = (px * c - py * sn) * s + (Math.random() - 0.5) * 0.04;
    y[i * 3 + 1] = (px * sn + py * c) * s + (Math.random() - 0.5) * 0.04;
    y[i * 3 + 2] = x[i * 3 + 2] * s;
  }
  return y;
}

// ---- gesture library: classes, samples, bindings, persistence ------------------------------
export const ACTIONS = {
  none: "Do nothing",
  clear_overlays: "Push away: clear plumes, wind and AI layers",
  scoop_data: "Scoop: read the data under the cursor",
  toggle_wind: "Toggle the wind layer",
  toggle_time: "Open / close the timeline",
  switch_mode: "Switch Ask / What-If",
  reset_view: "Reset the view",
  ask_here: "Ask about the point under the cursor",
};

export const Lib = {
  classes: [{ name: "Neutral", action: "none", samples: [] }],
  model: null,
  load() {
    try {
      const j = JSON.parse(localStorage.getItem("terra.gestures") || "null");
      if (j?.classes) this.import(j);
    } catch {}
  },
  save() {
    try { localStorage.setItem("terra.gestures", JSON.stringify(this.export())); } catch {}
  },
  export() {
    return { version: 1, classes: this.classes.map((c) => ({ name: c.name, action: c.action, samples: c.samples.map((s) => Array.from(s, (v) => +v.toFixed(4))) })), model: this.model?.toJSON() || null };
  },
  import(j) {
    this.classes = j.classes.map((c) => ({ name: c.name, action: c.action || "none", samples: (c.samples || []).map((s) => Float32Array.from(s)) }));
    this.model = j.model && j.model.nOut === this.classes.length ? new MLP(j.model.nIn, j.model.nHid, j.model.nOut, j.model) : null;
  },
  async train(onEpoch) {
    const X = [], Y = [];
    this.classes.forEach((c, k) => c.samples.forEach((s) => { X.push(s); Y.push(k); }));
    if (this.classes.length < 2 || X.length < 20) throw new Error("Record at least two gestures (including Neutral) with a few seconds each.");
    const net = new MLP(63, 48, this.classes.length);
    const acc = net.train(X, Y, { onEpoch });
    this.model = net;
    this.save();
    return acc;
  },
  predict(f) {
    if (!this.model) return null;
    const p = this.model.forward(f).p;
    let best = 0;
    for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
    return { index: best, cls: this.classes[best], conf: p[best] };
  },
};
