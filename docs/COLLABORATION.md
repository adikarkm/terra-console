# Collaboration

Several people can share one globe. Each person sees the others' cursors (mouse or hand) as coloured beams standing on the globe with their name and mode, the regions they draw, the AI answers they get, and every change to the simulation.

## Transports

| Where | Transport | Who joins |
|---|---|---|
| Published artifact | the page's `room` capability | everyone the page is shared with who has it open; guests are marked |
| Local server | WebSocket `/ws?room=NAME` | anyone who opens the server's address and joins the same room name |

The artifact room is joined automatically. In the local version, open the Collaborate panel, type a room name and press Join.

## Protocol

The same messages travel over both transports.

**Presence** (latest value wins, sent at most ~16 times a second):
```json
{ "nick": "Ada", "color": "#7dff9b", "lat": 25.77, "lon": -80.19, "mode": "ask", "hand": true }
```

**Events** (moments, never stored):

| Topic | Data | Receiver does |
|---|---|---|
| `region` | `{ nick, color, poly: [[lat, lon], …] }` (≤ 110 vertices) | draws the peer's loop in their colour |
| `answer` | `{ nick, q, text, source }` (text ≤ 3,300 chars) | opens the answer panel with "Ada asked …", and shows it on the XR panel |
| `sim` | `{ nick, state: { sea, storm: {genesis, push, cat}, events: [{type, lat, lon, size}] } }` | switches to What-If and applies the state; models are deterministic up to particle noise, so everyone sees the same flood and storm track |

Simulation changes are debounced (250 ms) and sent as absolute state, so a late joiner catches up on the next change. Everything received is treated as untrusted data: names are escaped, colours validated, and nothing is executed.

## Server side (`server/server.js`)

Rooms are in memory: `Map<roomName, Map<peerId, {ws, presence}>>`. On connect a peer gets `hello` with its id and the current peers; presence and events are broadcast to the room; `leave` is sent on disconnect. Messages are capped at 16 KB and presence at 4 KB. Room names are limited to `[a-z0-9_.-]`.

For a public deployment put the server behind HTTPS, add authentication, and run rooms through a shared store (Redis pub/sub) or a hosted service such as Liveblocks if you need more than one server instance.
