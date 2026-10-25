// Gesture trainer UI: record samples per gesture, train the in-browser network, bind actions.
import { $, h, toast } from "../util/dom.js";
import { Lib, ACTIONS, features } from "../input/classifier.js";
import { HandState, startHands } from "../input/hands.js";
import { S } from "../state.js";

let live = 0;

export function initTrainer() {
  Lib.load();
  $("#trainerClose").addEventListener("click", () => { $("#trainer").hidden = true; cancelAnimationFrame(live); });
  $("#gAdd").addEventListener("click", () => {
    const name = $("#gName").value.trim();
    if (!name) return toast("Name the gesture first, e.g. Scoop.");
    if (Lib.classes.find((c) => c.name.toLowerCase() === name.toLowerCase())) return toast("That gesture already exists.");
    Lib.classes.push({ name, action: "scoop_data", samples: [] });
    Lib.model = null;
    $("#gName").value = "";
    render();
  });
  $("#gTrain").addEventListener("click", train);
  $("#gExport").addEventListener("click", async () => {
    const txt = JSON.stringify(Lib.export());
    try { await navigator.clipboard.writeText(txt); toast("Gesture model copied to the clipboard as JSON."); }
    catch { $("#gJson").value = txt; $("#gJson").hidden = false; $("#gJson").select(); toast("Copy the JSON from the box."); }
  });
  $("#gImport").addEventListener("click", () => {
    const box = $("#gJson");
    if (box.hidden) { box.hidden = false; box.value = ""; box.placeholder = "Paste a gesture model JSON, then press Import again."; return; }
    try { Lib.import(JSON.parse(box.value)); Lib.save(); box.hidden = true; render(); toast("Gestures imported."); }
    catch { toast("That isn't a valid gesture model."); }
  });
}

export async function openTrainer() {
  $("#trainer").hidden = false;
  render();
  if (!S.hands) await startHands();
  const tick = () => {
    const el = $("#gLive");
    if (HandState.lastLm && Lib.model) {
      const pr = Lib.predict(features(HandState.lastLm.lm, HandState.lastLm.label));
      el.textContent = pr ? `Seeing: ${pr.cls.name} (${Math.round(pr.conf * 100)}%)` : "";
    } else el.textContent = S.hands ? (Lib.model ? "Show your hand to the camera." : "Record samples, then train.") : "Hand tracking is off.";
    live = requestAnimationFrame(tick);
  };
  tick();
}

function render() {
  const list = $("#gList");
  list.innerHTML = "";
  Lib.classes.forEach((c, k) => {
    const sel = h("select", { "aria-label": `Action for ${c.name}` }, ...Object.entries(ACTIONS).map(([v, t]) => h("option", { value: v, text: t, selected: v === c.action })));
    sel.addEventListener("change", () => { c.action = sel.value; Lib.save(); });
    const rec = h("button", { class: "chip", text: "Record 3 s" });
    rec.addEventListener("click", () => record(c, rec));
    const del = h("button", { class: "chip", text: "Remove", disabled: k === 0 });
    del.addEventListener("click", () => { Lib.classes.splice(k, 1); Lib.model = null; Lib.save(); render(); });
    list.append(h("div", { class: "grow" },
      h("div", { class: "gname" }, h("b", { text: c.name }), h("span", { text: `${c.samples.length} samples` })),
      k === 0 ? h("p", { class: "note", text: "Neutral: relaxed hand, pointing, anything that should trigger nothing." }) : sel,
      h("div", { class: "row" }, rec, del)));
  });
  $("#gStatus2").textContent = Lib.model ? "Model trained. Custom gestures are live." : "Not trained yet.";
}

function record(cls, btn) {
  if (!S.hands) { toast("Turn on hand tracking first."); return; }
  let n = 3;
  btn.disabled = true;
  const count = setInterval(() => {
    btn.textContent = n > 0 ? `Get ready… ${n}` : "Recording";
    if (n-- <= 0) {
      clearInterval(count);
      const start = performance.now();
      let last = 0;
      HandState.recorder = (f) => {
        if (performance.now() - last < 60) return;
        last = performance.now();
        cls.samples.push(f);
        if (performance.now() - start > 3000) {
          HandState.recorder = null;
          btn.disabled = false;
          btn.textContent = "Record 3 s";
          Lib.model = null;
          Lib.save();
          render();
          toast(`${cls.name}: ${cls.samples.length} samples`);
        }
      };
    }
  }, 700);
}

async function train() {
  const st = $("#gStatus2");
  st.textContent = "Training…";
  await new Promise((r) => setTimeout(r, 30));
  try {
    const acc = await Lib.train((ep, a) => (st.textContent = `Epoch ${ep}: ${Math.round(a * 100)}% on training samples`));
    st.textContent = `Trained: ${Math.round(acc * 100)}% on training samples. Custom gestures are live.`;
  } catch (e) {
    st.textContent = e.message;
  }
}
