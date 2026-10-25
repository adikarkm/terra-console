// 2D shallow-water flood dynamics with the local inertial approximation
// (Bates, Horritt & Fewtrell 2010; de Almeida & Bates 2013), the scheme used by LISFLOOD-FP.
// For each cell face:  q ← (q − g·h_f·Δt·∂η/∂x) / (1 + g·Δt·n²·|q| / h_f^(7/3))
// then continuity:     h ← h + Δt·(−∂q_x/∂x − ∂q_y/∂y)
// η = z + h is the water surface, h_f the flow depth across the face, n Manning's roughness.
// Open-sea cells follow a boundary water level η_b(t) = sea rise + surge pulse + tide, so storm
// surge pushes inland, spreads through low ground and drains back as the surge falls.
// Two engines with identical maths: WebGPU compute shaders, and a Web Worker on the CPU.

const G = 9.81;
export const FORCING_DEFAULT = { sea: 0, surge: 3, tPeakH: 18, sigmaH: 6, tide: 0.5 };

export function boundaryLevel(tSec, f) {
  const tH = tSec / 3600;
  return f.sea + f.surge * Math.exp(-(((tH - f.tPeakH) / f.sigmaH) ** 2)) + f.tide * Math.sin((2 * Math.PI * tSec) / 44712);
}

export function stableDt(grid, hmax) {
  let dxmin = grid.dy;
  for (let j = 0; j < grid.H; j++) dxmin = Math.min(dxmin, grid.dxRow[j]);
  return Math.min(60, (0.7 * dxmin) / Math.sqrt(G * Math.max(0.5, hmax)));
}

// ---------------------------------------------------------------------------------------------
// CPU engine (Web Worker)
// ---------------------------------------------------------------------------------------------
export const WORKER_SRC = `
const G = 9.81;
let W, H, z, h, qx, qy, ocean, dxRow, dy, nMan, t = 0;
function eta(f, ts) { const tH = ts / 3600; return f.sea + f.surge * Math.exp(-(((tH - f.tPeakH) / f.sigmaH) ** 2)) + f.tide * Math.sin(2 * Math.PI * ts / 44712); }
function step(dt, etaB) {
  // x faces
  for (let j = 0; j < H; j++) {
    const dx = dxRow[j];
    for (let i = 1; i < W; i++) {
      const L = j * W + i - 1, R = L + 1, f = j * (W + 1) + i;
      const eL = z[L] + h[L], eR = z[R] + h[R];
      const hf = Math.max(eL, eR) - Math.max(z[L], z[R]);
      if (hf <= 1e-3) { qx[f] = 0; continue; }
      const q0 = qx[f];
      qx[f] = (q0 - G * hf * dt * (eR - eL) / dx) / (1 + G * dt * nMan * nMan * Math.abs(q0) / Math.pow(hf, 7 / 3));
    }
  }
  // y faces (j increases southward)
  for (let j = 1; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const T = (j - 1) * W + i, B = T + W, f = j * W + i;
      const eT = z[T] + h[T], eB = z[B] + h[B];
      const hf = Math.max(eT, eB) - Math.max(z[T], z[B]);
      if (hf <= 1e-3) { qy[f] = 0; continue; }
      const q0 = qy[f];
      qy[f] = (q0 - G * hf * dt * (eB - eT) / dy) / (1 + G * dt * nMan * nMan * Math.abs(q0) / Math.pow(hf, 7 / 3));
    }
  }
  // continuity + sea boundary
  let hmax = 0;
  for (let j = 0; j < H; j++) {
    const dx = dxRow[j];
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (ocean[k]) { h[k] = Math.max(0, etaB - z[k]); continue; }
      const fx = j * (W + 1) + i, fy = j * W + i;
      const dh = dt * ((qx[fx] - qx[fx + 1]) / dx + (qy[fy] - qy[fy + W]) / dy);
      const v = h[k] + dh;
      h[k] = v > 0 ? v : 0;
      if (h[k] > hmax) hmax = h[k];
    }
  }
  return hmax;
}
onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    ({ W, H, z, ocean, dxRow, dy } = m); nMan = m.n || 0.03; t = 0;
    h = new Float32Array(W * H); qx = new Float32Array((W + 1) * H); qy = new Float32Array(W * (H + 1));
    postMessage({ type: "ready" });
  } else if (m.type === "advance") {
    let left = m.seconds, steps = 0, hmax = m.hmax || 1;
    let dxmin = dy; for (let j = 0; j < H; j++) dxmin = Math.min(dxmin, dxRow[j]);
    const t0 = performance.now();
    while (left > 0 && performance.now() - t0 < 120) {
      const etaB = eta(m.forcing, t);
      const dt = Math.min(left, 60, 0.7 * dxmin / Math.sqrt(G * Math.max(0.5, hmax, etaB + 5)));
      hmax = step(dt, etaB); t += dt; left -= dt; steps++;
    }
    const out = h.slice();
    postMessage({ type: "state", t, h: out, steps, hmax }, [out.buffer]);
  } else if (m.type === "reset") { h.fill(0); qx.fill(0); qy.fill(0); t = 0; postMessage({ type: "ready" }); }
};`;

export class CpuSWE {
  constructor() { this.kind = "CPU worker"; this.t = 0; }
  async init(grid, n = 0.03) {
    this.grid = grid;
    this.w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
    await this.call({ type: "init", W: grid.W, H: grid.H, z: grid.z, ocean: grid.ocean, dxRow: grid.dxRow, dy: grid.dy, n }, "ready");
    this.hmax = 1;
    return this;
  }
  call(msg, expect) {
    return new Promise((res) => {
      const fn = (e) => { if (e.data.type === expect) { this.w.removeEventListener("message", fn); res(e.data); } };
      this.w.addEventListener("message", fn);
      this.w.postMessage(msg);
    });
  }
  async advance(seconds, forcing) {
    const r = await this.call({ type: "advance", seconds, forcing, hmax: this.hmax }, "state");
    this.t = r.t; this.hmax = r.hmax;
    return { t: r.t, h: r.h, steps: r.steps };
  }
  async reset() { await this.call({ type: "reset" }, "ready"); this.t = 0; this.hmax = 1; }
  dispose() { this.w?.terminate(); }
}

// ---------------------------------------------------------------------------------------------
// WebGPU engine
// ---------------------------------------------------------------------------------------------
const WGSL = /* wgsl */ `
struct P { W: u32, H: u32, dt: f32, dy: f32, etaB: f32, n: f32, pad0: f32, pad1: f32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> z: array<f32>;
@group(0) @binding(2) var<storage, read_write> h: array<f32>;
@group(0) @binding(3) var<storage, read_write> qx: array<f32>;
@group(0) @binding(4) var<storage, read_write> qy: array<f32>;
@group(0) @binding(5) var<storage, read> ocean: array<u32>;
@group(0) @binding(6) var<storage, read> dxRow: array<f32>;
const G: f32 = 9.81;

fn flux(q0: f32, hf: f32, deta: f32, d: f32) -> f32 {
  if (hf <= 1e-3) { return 0.0; }
  return (q0 - G * hf * p.dt * deta / d) / (1.0 + G * p.dt * p.n * p.n * abs(q0) / pow(hf, 7.0 / 3.0));
}

@compute @workgroup_size(16, 16)
fn fluxX(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; let j = id.y;
  if (j >= p.H || i > p.W) { return; }
  let f = j * (p.W + 1u) + i;
  if (i == 0u || i == p.W) { qx[f] = 0.0; return; }
  let L = j * p.W + i - 1u; let R = L + 1u;
  let eL = z[L] + h[L]; let eR = z[R] + h[R];
  qx[f] = flux(qx[f], max(eL, eR) - max(z[L], z[R]), eR - eL, dxRow[j]);
}

@compute @workgroup_size(16, 16)
fn fluxY(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; let j = id.y;
  if (i >= p.W || j > p.H) { return; }
  let f = j * p.W + i;
  if (j == 0u || j == p.H) { qy[f] = 0.0; return; }
  let T = (j - 1u) * p.W + i; let B = T + p.W;
  let eT = z[T] + h[T]; let eB = z[B] + h[B];
  qy[f] = flux(qy[f], max(eT, eB) - max(z[T], z[B]), eB - eT, p.dy);
}

@compute @workgroup_size(16, 16)
fn depth(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; let j = id.y;
  if (i >= p.W || j >= p.H) { return; }
  let k = j * p.W + i;
  if (ocean[k] == 1u) { h[k] = max(0.0, p.etaB - z[k]); return; }
  let fx = j * (p.W + 1u) + i;
  let dh = p.dt * ((qx[fx] - qx[fx + 1u]) / dxRow[j] + (qy[k] - qy[k + p.W]) / p.dy);
  h[k] = max(0.0, h[k] + dh);
}`;

export async function webgpuAvailable() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

// one device for the whole session: creating and destroying devices per run is slow and some
// drivers stall when a new device is requested while the old one still has work in flight
let sharedDevice = null;
async function getDevice() {
  if (sharedDevice) return sharedDevice;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  sharedDevice = await adapter.requestDevice();
  sharedDevice.lost.then(() => (sharedDevice = null));
  return sharedDevice;
}

export class GpuSWE {
  constructor() { this.kind = "WebGPU"; this.t = 0; this.busy = false; this.maxSteps = 128; this.disposed = false; }
  async init(grid, n = 0.03) {
    const dev = await getDevice();
    this.dev = dev; this.grid = grid; this.n = n;
    const { W, H } = grid;
    const sto = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const mk = (arr, usage = sto) => { const b = dev.createBuffer({ size: Math.max(16, arr.byteLength), usage }); dev.queue.writeBuffer(b, 0, arr); return b; };
    this.bz = mk(grid.z);
    this.bh = mk(new Float32Array(W * H));
    this.bqx = mk(new Float32Array((W + 1) * H));
    this.bqy = mk(new Float32Array(W * (H + 1)));
    this.bocean = mk(Uint32Array.from(grid.ocean));
    this.bdx = mk(grid.dxRow);
    this.STEPS = 64; // max steps encoded per submit
    this.bp = dev.createBuffer({ size: 256 * this.STEPS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.read = dev.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const mod = dev.createShaderModule({ code: WGSL });
    const info = await mod.getCompilationInfo?.();
    const err = info?.messages?.find((m) => m.type === "error");
    if (err) throw new Error("WGSL: " + err.message);
    const layout = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    ] });
    const pl = dev.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipe = (entryPoint) => dev.createComputePipeline({ layout: pl, compute: { module: mod, entryPoint } });
    this.pX = pipe("fluxX"); this.pY = pipe("fluxY"); this.pD = pipe("depth");
    this.bg = dev.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.bp, size: 32 } },
      { binding: 1, resource: { buffer: this.bz } }, { binding: 2, resource: { buffer: this.bh } },
      { binding: 3, resource: { buffer: this.bqx } }, { binding: 4, resource: { buffer: this.bqy } },
      { binding: 5, resource: { buffer: this.bocean } }, { binding: 6, resource: { buffer: this.bdx } },
    ] });
    this.hmax = 1;
    return this;
  }
  // Advance up to `seconds` of simulated time, with at most `maxSteps` solver steps so one call
  // never queues more GPU work than the device finishes in ~0.1 s. The budget adapts to the GPU.
  async advance(seconds, forcing) {
    if (this.disposed) throw new Error("engine disposed");
    const { W, H } = this.grid;
    const dev = this.dev;
    let left = seconds, steps = 0;
    while (left > 0 && steps < this.maxSteps) {
      const n = Math.min(this.STEPS, this.maxSteps - steps);
      const params = new ArrayBuffer(256 * n);
      const enc = dev.createCommandEncoder();
      let k = 0;
      for (; k < n && left > 0; k++) {
        const etaB = boundaryLevel(this.t, forcing);
        const dt = Math.min(left, stableDt(this.grid, Math.max(this.hmax, etaB + 5)));
        const u = new Uint32Array(params, k * 256, 2); u[0] = W; u[1] = H;
        const f = new Float32Array(params, k * 256 + 8, 6); f[0] = dt; f[1] = this.grid.dy; f[2] = etaB; f[3] = this.n;
        const pass = enc.beginComputePass();
        pass.setBindGroup(0, this.bg, [k * 256]);
        pass.setPipeline(this.pX); pass.dispatchWorkgroups(Math.ceil((W + 1) / 16), Math.ceil(H / 16));
        pass.setPipeline(this.pY); pass.dispatchWorkgroups(Math.ceil(W / 16), Math.ceil((H + 1) / 16));
        pass.setPipeline(this.pD); pass.dispatchWorkgroups(Math.ceil(W / 16), Math.ceil(H / 16));
        pass.end();
        this.t += dt; left -= dt; steps++;
      }
      dev.queue.writeBuffer(this.bp, 0, params, 0, 256 * k);
      dev.queue.submit([enc.finish()]);
    }
    // read back depth (this also waits for the queued steps, which times the GPU)
    const t0 = performance.now();
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.bh, 0, this.read, 0, W * H * 4);
    dev.queue.submit([enc.finish()]);
    this.reading = this.read.mapAsync(GPUMapMode.READ);
    await this.reading;
    this.reading = null;
    const h = new Float32Array(this.read.getMappedRange().slice(0));
    this.read.unmap();
    const ms = performance.now() - t0;
    if (ms > 120 && this.maxSteps > 8) this.maxSteps = Math.max(8, this.maxSteps >> 1);
    else if (ms < 40 && this.maxSteps < 2048) this.maxSteps *= 2;
    let hmax = 0;
    for (let i = 0; i < h.length; i++) if (!this.grid.ocean[i] && h[i] > hmax) hmax = h[i];
    this.hmax = Math.max(1, hmax);
    return { t: this.t, h, steps };
  }
  async reset() {
    const { W, H } = this.grid;
    this.dev.queue.writeBuffer(this.bh, 0, new Float32Array(W * H));
    this.dev.queue.writeBuffer(this.bqx, 0, new Float32Array((W + 1) * H));
    this.dev.queue.writeBuffer(this.bqy, 0, new Float32Array(W * (H + 1)));
    this.t = 0; this.hmax = 1;
  }
  // free this run's buffers once any in-flight read has settled; the device is shared
  dispose() {
    this.disposed = true;
    const free = () => { for (const b of [this.bz, this.bh, this.bqx, this.bqy, this.bocean, this.bdx, this.bp, this.read]) try { b?.destroy(); } catch {} };
    if (this.reading) this.reading.then(free, free); else free();
  }
}

// Equilibrium flood on the regional grid: Priority-Flood from the open-sea cells (JS; the grid
// is small). Returns spill levels; a cell floods when spill <= sea.
export function regionalPriorityFlood(grid) {
  const { W, H, z, ocean } = grid, N = W * H;
  const spill = new Float32Array(N).fill(1e9), vis = new Uint8Array(N);
  const hi = new Int32Array(N), hk = new Float32Array(N);
  let hs = 0;
  const push = (id, key) => { let c = hs++; while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= key) break; hi[c] = hi[p]; hk[c] = hk[p]; c = p; } hi[c] = id; hk[c] = key; };
  const pop = () => { const top = hi[0]; hs--; if (hs > 0) { const lid = hi[hs], lk = hk[hs]; let c = 0; for (;;) { const l = 2 * c + 1; if (l >= hs) break; let m = l; if (l + 1 < hs && hk[l + 1] < hk[l]) m = l + 1; if (hk[m] >= lk) break; hi[c] = hi[m]; hk[c] = hk[m]; c = m; } hi[c] = lid; hk[c] = lk; } return top; };
  for (let k = 0; k < N; k++) if (ocean[k]) { vis[k] = 1; spill[k] = -1; push(k, 0); }
  while (hs > 0) {
    const level = hk[0], c = pop(), cy = (c / W) | 0, cx = c - cy * W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const n = y * W + x;
      if (vis[n]) continue;
      vis[n] = 1;
      const s = z[n] > level ? z[n] : level;
      spill[n] = s;
      push(n, s);
    }
  }
  return spill;
}
