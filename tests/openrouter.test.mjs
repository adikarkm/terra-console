// OpenRouter adapter: runs a two-round tool loop through the local server against a mock
// OpenAI-compatible upstream and checks the translation both ways.  Run: node tests/openrouter.test.mjs
import http from "node:http";
import assert from "node:assert/strict";

const seen = [];
let rateLimitNext = false;
const upstream = http.createServer(async (req, res) => {
  let b = "";
  for await (const c of req) b += c;
  const body = JSON.parse(b);
  seen.push({ auth: req.headers.authorization, body });
  res.setHeader("content-type", "application/json");
  if (rateLimitNext) { rateLimitNext = false; res.writeHead(429); return res.end(JSON.stringify({ error: { message: "rate limited" } })); }
  const last = body.messages.at(-1);
  if (last.role === "tool") {
    return res.end(JSON.stringify({ model: "mock/free", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<think>hidden</think>Naples has **3.1 M** people." } }] }));
  }
  res.end(JSON.stringify({ model: "mock/free", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "geocode", arguments: '{"query":"Naples"}' } }] } }] }));
});
await new Promise((r) => upstream.listen(0, r));

process.env.AI_PROVIDER = "openrouter";
process.env.OPENROUTER_API_KEY = "sk-or-test";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
delete process.env.ANTHROPIC_API_KEY;
const { handler } = await import("../server/server.js");
const app = http.createServer(handler);
await new Promise((r) => app.listen(0, r));
const base = `http://127.0.0.1:${app.address().port}`;
const post = (body) => fetch(`${base}/api/claude`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const health = await (await fetch(`${base}/api/health`)).json();
assert.equal(health.ai, "OpenRouter");
assert.equal(health.claude, true);

const tools = [{ name: "geocode", description: "find a place", input_schema: { type: "object", properties: { query: { type: "string" } } } }];
const messages = [{ role: "user", content: "How many people live in Naples?" }];
let r = await post({ messages, tools, max_tokens: 2000 });
let msg = await r.json();
assert.equal(r.status, 200);
assert.equal(msg.stop_reason, "tool_use");
assert.deepEqual(msg.content[0], { type: "tool_use", id: "c1", name: "geocode", input: { query: "Naples" } });
assert.equal(seen[0].auth, "Bearer sk-or-test");
assert.equal(seen[0].body.model, "openrouter/free");
assert.equal(seen[0].body.tools[0].function.name, "geocode");
assert.equal(seen[0].body.tools[0].function.parameters.properties.query.type, "string");

messages.push({ role: "assistant", content: msg.content });
messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"lat":40.85,"lon":14.27}' }] });
r = await post({ messages, tools });
msg = await r.json();
assert.equal(msg.stop_reason, "end_turn");
assert.equal(msg.content[0].text, "Naples has **3.1 M** people.");
const sent = seen[1].body.messages;
assert.equal(sent[1].role, "assistant");
assert.equal(sent[1].tool_calls[0].function.arguments, '{"query":"Naples"}');
assert.deepEqual(sent[2], { role: "tool", tool_call_id: "c1", content: '{"lat":40.85,"lon":14.27}' });

rateLimitNext = true;
r = await post({ messages: [{ role: "user", content: "hi" }] });
assert.equal(r.status, 429);
assert.match((await r.json()).error, /free limit/);

console.log("ok   OpenRouter adapter: tool call out, tool result back, final text, rate-limit message");
app.close();
upstream.close();
process.exit(0);
