// Provenance and verification: every number in an answer is traced to the tool result it came
// from (directly, or as a simple sum, difference, ratio or percentage of two tool numbers).
// Numbers that trace to nothing are flagged and sent to a critic pass for correction.

const MULT = { k: 1e3, K: 1e3, thousand: 1e3, M: 1e6, million: 1e6, mn: 1e6, B: 1e9, bn: 1e9, billion: 1e9 };
const NUM_RE = /(?<![\w.])([-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(%|k|K|M|B|bn|mn|thousand|million|billion)?(?![\w])/g;

export function collectNumbers(calls) {
  const out = [];
  const walk = (v, path, call) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push({ value: v, path, tool: call.name, input: call.input });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, call));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, call);
    else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) out.push({ value: +v, path, tool: call.name, input: call.input });
  };
  for (const c of calls) {
    walk(c.result, "", c);
    walk(c.input, "input", c);
  }
  return out;
}

export function parseNumbers(text) {
  const found = [];
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[1].replace(/,/g, "").replace("−", "-");
    const unit = m[2] || "";
    const decimals = (raw.split(".")[1] || "").length;
    const base = parseFloat(raw);
    if (!Number.isFinite(base)) continue;
    found.push({ text: m[0], index: m.index, base, unit, value: base * (MULT[unit] || 1), decimals, percent: unit === "%" });
  }
  return found;
}

function close(a, n) {
  // a: answer number, n: candidate; allow rounding to the shown precision and ~3.5% relative
  const tol = Math.max(Math.abs(a.value) * 0.035, 0.5 * 10 ** -a.decimals * (MULT[a.unit] || 1));
  return Math.abs(a.value - n) <= tol;
}

function trivial(a) {
  // small counts and list markers ("2 cities", "1.", "3 h") are accepted when they appear anywhere
  return Number.isInteger(a.base) && a.base <= 3 && !a.unit;
}

export function verify(text, calls) {
  const pool = collectNumbers(calls);
  const vals = pool.map((p) => p.value);
  const nums = parseNumbers(text);
  const results = nums.map((a) => {
    // direct match (also fractions shown as percentages)
    for (const p of pool) {
      if (close(a, p.value) || (a.percent && close(a, p.value * 100))) return { ...a, status: "tool", source: p };
    }
    if (trivial(a)) return { ...a, status: "trivial" };
    // derived from two tool numbers
    const big = pool.filter((p) => Math.abs(p.value) > 1e-9).slice(0, 400);
    for (let i = 0; i < big.length; i++) for (let j = 0; j < big.length; j++) {
      if (i === j) continue;
      const x = big[i].value, y = big[j].value;
      const cands = [x + y, x - y, x / y, (x / y) * 100, ((x - y) / y) * 100];
      for (const c of cands) if (Number.isFinite(c) && close(a, c)) return { ...a, status: "derived", source: big[i], source2: big[j] };
    }
    return { ...a, status: "unverified" };
  });
  const counted = results.filter((r) => r.status !== "trivial");
  return { numbers: results, verified: counted.filter((r) => r.status !== "unverified").length, total: counted.length, unverified: counted.filter((r) => r.status === "unverified") };
}

export function criticPrompt(answer, calls, unverified) {
  const slim = JSON.stringify(calls.map((c) => ({ tool: c.name, input: c.input, result: c.result }))).slice(0, 14000);
  return `You are the fact-checker for an Earth analysis console. Below is a draft answer and the exact tool results it was based on.
These numbers in the draft could not be traced to any tool result: ${unverified.map((u) => `"${u.text}"`).join(", ")}.

Rewrite the draft so that every number is supported by the tool results (copy the value, or a correct sum, difference, ratio or percentage of tool values). Fix wrong numbers. If a number is genuinely general knowledge and not in the tools, keep it only if you are confident and add "(general knowledge)" after it; otherwise remove it. Keep the same structure, tone, formatting (** bold **, "- " bullets, final "Sources:" line) and roughly the same length. Return only the revised answer text.

TOOL RESULTS: ${slim}

DRAFT ANSWER:
${answer}`;
}
