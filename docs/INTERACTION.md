# Interaction

## Webcam hands (`input/hands.js`)

MediaPipe Hands (loaded from jsDelivr on first use) tracks up to two hands at camera frame rate. The central 76% of the camera frame maps to the whole screen, mirrored, so you can reach the edges without stretching. The cursor follows your index fingertip (or the pinch point while pinching) with light smoothing.

| Pose | Detection | Action |
|---|---|---|
| Pinch | thumb tip to index tip < 0.30 × palm size (released above 0.45, so it doesn't flicker) | Press the button or slider under the cursor; otherwise draw a region (Ask), draw a storm push or place an event (What-If tools), or grab and spin the globe (What-If, Rotate tool) |
| Open palm | four fingers extended | Spin the globe with palm motion |
| Two hands | both open or pinching | Zoom by the distance between palms |
| Fist | no fingers extended | Raise or lower the sea by moving up or down (What-If) |
| Peace sign | index and middle up, held 0.8 s | Switch mode (2 s cooldown) |

The small camera preview shows the detected skeleton and the recognised pose.

## Custom gestures (`input/classifier.js`, `ui/trainer.js`)

Open the trainer (raised-hand icon in the dock):

1. Record **Neutral** for 3 seconds: relaxed hands, pointing, ordinary movement. This is the "do nothing" class.
2. Add a gesture (e.g. *Scoop*), pick an action, press **Record 3 s** and perform it with small variations. Record twice for robustness.
3. Press **Train**. A neural network (63 inputs → 48 ReLU → one output per gesture, softmax) trains in the browser with Adam for 120 epochs, with random rotation, scale and jitter augmentation. Takes about a second.

Features are the 21 landmarks relative to the wrist, scaled by palm size, with left hands mirrored so one model serves both. A gesture fires when the network is ≥ 85% confident for 350 ms (1.5 s cooldown); built-in gestures pause while a custom one is held.

Actions you can bind: push away (clear plumes, wind and AI layers), scoop (read the data under the cursor), toggle wind, open/close the timeline, switch mode, reset view, ask about the point under the cursor. Models persist in the browser and can be copied as JSON or imported.

## Voice (`input/voice.js`, `input/commands.js`)

Press the mic for continuous recognition (Chrome, Edge). Every final phrase goes through the same router as the text bar:

| Say | Does |
|---|---|
| "ask mode" / "what-if mode" | switch mode |
| "go to Lagos", "fly to Peru", "show me Tokyo" | fly to a city (population ≥ 100k) or country |
| "what if the sea rose 3 metres", "raise sea level by 10 feet" | jump into the flood simulation (feet are converted) |
| "hurricane category 4 near Houston" | spin up a storm over the ocean near the city |
| "erupt a volcano", "start a wildfire", "place a meteor" | arm the event tool |
| "show me this region in 2000 vs 2026" | satellite swipe compare |
| "show the winds", "hide the winds", "true colour", "hologram view" | layers |
| "zoom in", "zoom out", "spin", "stop", "reset", "open timeline", "read it aloud" | view controls |
| anything else | a question for the agent |

Answers can be read aloud (Read aloud button), and the agent's steps can be narrated as they happen (Layers → Narrate agent steps).

## Point-and-say (`input/deixis.js`)

The console keeps the last 10 seconds of your pointer path (hand or mouse). When a deictic word appears in the live transcript — "here", "this", "there" (not "is there" / "there are"), "that place / city / coast / area" — it stamps the time, minus ~450 ms recogniser latency, and looks up where you were pointing at that instant. The word is replaced with the place (e.g. "here near Naples (40.85, 14.27)"), a pink marker confirms it, and:

- "put a volcano here", "start a fire there", "drop a meteor here" place the event at the spot,
- "what if the sea rose 2 metres here" runs the flood there,
- "hurricane category 4 here" spins up a storm there,
- questions ("how many people live here?") go to the agent with the point as the default area.

Typed commands use your last mouse position on the globe. "This region" with a drawn region means the region.

## Wake word

Layers → Wake word "Terra": only phrases that start with "Terra" (or "hey Terra") are acted on; the mic button glows when it hears the wake word. Off by default, so every phrase is a command.

## 3D buildings (`globe/buildings.js`)

Below about 9 km eye altitude, with streamed imagery on, OpenStreetMap building footprints load for the ~1 km map tiles around the view (one more ring when you tilt toward the horizon) and are extruded to their tagged height, `building:levels` × 3.2 m, or a typical height for the building type. They stand on the same elevation tiles as the streamed terrain. Layers → 3D buildings turns them off.

## Mouse and touch (`input/pointer.js`)

- Drag: spin (the ground under the cursor follows the cursor at every altitude), or draw with the active tool (Draw region, Hurricane, Event). Shift-drag draws a region from any tool.
- Right-drag or Ctrl-drag: tilt toward the horizon (allowed below ~190 km, up to 77° below 13 km) and turn. PageUp / PageDown also tilt; `+` / `-` zoom.
- Scroll or two-finger pinch: zoom.
- Hovering shows latitude, longitude, elevation and country in the bottom-left readout.
- `/` focuses the command bar, `Esc` closes overlays.

## WebXR (`xr/xr.js`)

The VR / AR button starts an immersive session (AR passthrough when the device supports it). The globe appears about a metre in front of you at chest height.

| Hands | Controllers | Action |
|---|---|---|
| Pinch near the globe and move | Squeeze and move | Spin |
| Pinch with both hands, move apart / together | — | Scale |
| Point with the index finger and pinch away from the globe | Aim and pull the trigger | Draw a region (Ask) or place a storm / event (What-If) |
| Pinch a panel button | Trigger on a button | Ask / What-If / Exit / Sea ±1 m |

The floating panel shows the mode, the sea level and the latest AI answer, so a question asked by a teammate on a laptop pops up in the room. Setup: [XR.md](XR.md).

## Displays

- **Looking Glass** (Layers → Looking Glass): loads the official Looking Glass WebXR polyfill and opens an immersive session on the holographic display. Needs Looking Glass Bridge running and the display connected.
- **Spherical displays** (Layers → Spherical display): renders the globe composite as a north-centred azimuthal fisheye (internally projected spheres such as PufferSphere and OmniGlobe) or a 2:1 equirectangular image (NOAA Science On a Sphere, LED spheres). It goes full screen; move the window to the sphere's input. Esc returns.

## Spatial sound (`audio/soundscape.js`)

All sound is synthesised in Web Audio from noise and oscillators:

| Source | Synthesis | Follows |
|---|---|---|
| Hurricane wind | band-passed noise with a sweeping centre frequency, plus a low rumble | the storm's animated position, louder with category |
| Fire | high-passed noise in random crackle bursts over a low-passed roar | the first wildfire |
| Volcano | sub-bass rumble with slow surges | the first eruption or 1 km impact |
| Surf | low-passed noise swelling at 0.11 Hz | flooded cells around the cursor |
| Console hum | three detuned low sines | always, quietly |

Each voice runs through an HRTF panner. Its horizontal position comes from where the source sits on screen relative to your cursor or hand; its level falls off with distance on the globe and rises as the camera moves closer.
