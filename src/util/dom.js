export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let toastTimer = 0;
export function toast(msg, ms = 3200) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function fmtKm2(a) {
  if (a >= 1e6) return `${(a / 1e6).toFixed(2)} M km²`;
  if (a >= 1e4) return `${Math.round(a / 1e3).toLocaleString()}k km²`;
  return `${Math.round(a).toLocaleString()} km²`;
}
export function fmtPop(p) {
  if (p >= 1e9) return `${(p / 1e9).toFixed(2)} B`;
  if (p >= 1e6) return `${(p / 1e6).toFixed(1)} M`;
  if (p >= 1e3) return `${Math.round(p / 1e3)}k`;
  return String(Math.round(p));
}
export function fmtM(m) {
  return `${m >= 0 ? "+" : ""}${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
}

export function setPressed(group, el) {
  for (const b of group) b.setAttribute("aria-pressed", String(b === el));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = res;
    s.onerror = () => rej(new Error("Could not load " + src));
    document.head.append(s);
  });
}
