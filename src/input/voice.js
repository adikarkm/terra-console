// Voice: continuous speech recognition (Web Speech API) and spoken replies.
import { S, emit } from "../state.js";
import { toast } from "../util/dom.js";

let rec = null;
let wantOn = false;

export function voiceSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function startVoice(onCommand, onInterim) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast("Voice commands need Chrome or Edge. You can type commands instead."); return false; }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (r.isFinal) { onInterim?.(""); if (text) onCommand(text); }
      else onInterim?.(text);
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("Microphone access was refused here. Voice works in the local version, or allow the microphone in your browser.");
      wantOn = false;
      setState(false);
    }
  };
  rec.onend = () => { if (wantOn) { try { rec.start(); } catch {} } else setState(false); };
  try { rec.start(); } catch { return false; }
  wantOn = true;
  setState(true);
  return true;
}

export function stopVoice() {
  wantOn = false;
  try { rec?.stop(); } catch {}
  setState(false);
}

function setState(on) {
  S.voice = on;
  emit("voice:state", on);
}

// ---- speech output ------------------------------------------------------------------------
export function speak(text, { queue = false } = {}) {
  if (!("speechSynthesis" in window) || !text) return;
  if (!queue) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 900));
  u.rate = 1.04;
  u.pitch = 0.95;
  const v = speechSynthesis.getVoices().find((v) => /en/i.test(v.lang) && /Google|Natural|Daniel|Samantha/i.test(v.name));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
