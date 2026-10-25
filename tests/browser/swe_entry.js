import { GpuSWE, CpuSWE } from "../../src/regional/swe.js";
function grid(W, H) {
  const z = new Float32Array(W * H), ocean = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    // sloping coast with a channel and a ridge
    z[k] = i < 10 ? -6 : 0.3 + (i - 10) * 0.03 + (Math.abs(j - H / 2) < 3 ? -0.6 : 0) + (i === 70 && j > 10 ? 4 : 0);
    ocean[k] = i < 10 ? 1 : 0;
  }
  return { W, H, z, ocean, dxRow: new Float32Array(H).fill(150), dy: 150 };
}
window.runSweCompare = async () => {
  const g = grid(128, 64);
  const forcing = { sea: 0.5, surge: 2, tPeakH: 4, sigmaH: 2, tide: 0 };
  const cpu = await new CpuSWE().init(g), gpu = await new GpuSWE().init(g);
  const run = async (e, secs) => { let r; const target = e.t + secs; do { r = await e.advance(target - e.t, forcing); } while (e.t < target - 1e-6); return r; };
  const out = {};
  for (const hrs of [2, 4, 8]) {
    const [a, b] = [await run(cpu, hrs * 3600 - cpu.t), await run(gpu, hrs * 3600 - gpu.t)];
    let maxDiff = 0, wetA = 0, wetB = 0, volA = 0, volB = 0;
    for (let k = 0; k < a.h.length; k++) { if (g.ocean[k]) continue; maxDiff = Math.max(maxDiff, Math.abs(a.h[k] - b.h[k])); if (a.h[k] > 0.05) wetA++; if (b.h[k] > 0.05) wetB++; volA += a.h[k]; volB += b.h[k]; }
    out[hrs + "h"] = { cpuT: Math.round(cpu.t), gpuT: Math.round(gpu.t), wetCpu: wetA, wetGpu: wetB, volumeRatio: +(volB / (volA || 1)).toFixed(4), maxDepthDiff: +maxDiff.toFixed(4) };
  }
  cpu.dispose(); gpu.dispose();
  return out;
};
