// Coverage for the Twitch counter overlay's local server
// (twitch-overlay/counter/counter-server.js).
//
// Why this exists: the overlay is driven entirely through HTTP endpoints that
// other software calls — hotkeys.ps1, Streamer.bot, a Stream Deck, a phone on
// the LAN. If any of those paths silently breaks (a renamed route, a bad
// Content-Type, SSE dying on reconnect, the count not surviving a restart after
// OBS is closed for the night), the streamer sees a HUD that just sits there
// while they mash a key live. So: boot the real server, exercise the real
// endpoints, and insist the count persists across a restart.
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const SERVER = path.join(__dirname, "..", "twitch-overlay", "counter", "counter-server.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  passed++;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

function startServer(port, stateFile) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COUNTER_PORT: String(port), COUNTER_HOST: "127.0.0.1", COUNTER_STATE_FILE: stateFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 5000);
    child.stdout.on("data", (buf) => {
      out += buf.toString();
      if (out.includes("count is")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (buf) => (out += buf.toString()));
    child.on("exit", (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  return { child, ready };
}

const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

async function main() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "counter-test-"));
  const stateFile = path.join(dir, "state.json");
  const base = `http://127.0.0.1:${port}`;
  const api = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, type: res.headers.get("content-type") || "", body: await res.json() };
  };

  let { child, ready } = startServer(port, stateFile);
  await ready;

  // --- fresh start is zero ------------------------------------------------
  let r = await api("/api/state");
  check("GET /api/state returns JSON with count 0 on a fresh state file", r.status === 200 && r.body.count === 0);

  // --- bump ---------------------------------------------------------------
  r = await api("/api/bump?d=1");
  check("GET /api/bump?d=1 increments to 1", r.body.count === 1);
  r = await api("/api/bump");
  check("GET /api/bump with no d defaults to +1 (easy for Streamer.bot)", r.body.count === 2);
  r = await api("/api/bump?d=-1");
  check("GET /api/bump?d=-1 decrements to 1", r.body.count === 1);
  r = await api("/api/bump?d=-5");
  check("negative counts are allowed (count 1 - 5 = -4)", r.body.count === -4);

  // --- set / reset --------------------------------------------------------
  r = await api("/api/set?n=42");
  check("GET /api/set?n=42 jumps to 42", r.body.count === 42);
  r = await api("/api/reset");
  check("GET /api/reset returns to 0", r.body.count === 0);
  r = await api("/api/bump?d=7");
  check("bump after reset works (7)", r.body.count === 7);

  // --- bad input is rejected, not crashed on -----------------------------
  r = await api("/api/bump?d=banana");
  check("non-numeric d is a 400, not a crash", r.status === 400);
  r = await api("/api/set?n=nope");
  check("non-numeric n is a 400", r.status === 400);
  r = await api("/api/state");
  check("the count is untouched by the rejected calls", r.body.count === 7);

  // --- CORS: a phone on the LAN / another local page must be able to call it
  const corsRes = await fetch(base + "/api/state", { headers: { Origin: "http://example.test" } });
  check(
    "API sends Access-Control-Allow-Origin so non-same-origin callers work",
    corsRes.headers.get("access-control-allow-origin") === "*"
  );
  check("API responses are no-store so OBS never shows a stale count", corsRes.headers.get("cache-control") === "no-store");

  // --- pages are served ---------------------------------------------------
  const overlay = await fetch(base + "/");
  const overlayHtml = await overlay.text();
  check("GET / serves the overlay page", overlay.status === 200 && overlayHtml.includes("EventSource"));
  check("overlay page has a transparent background for OBS", overlayHtml.includes("background: transparent"));

  const control = await fetch(base + "/app");
  check("GET /app serves the buttons page", control.status === 200 && (await control.text()).includes("/api/bump"));

  const demo = await fetch(base + "/demo");
  check("GET /demo serves the try-it page", demo.status === 200);

  const missing = await fetch(base + "/nope");
  check("unknown routes 404 instead of hanging OBS", missing.status === 404);

  // --- SSE: the overlay's live channel ------------------------------------
  const sseController = new AbortController();
  const sseRes = await fetch(base + "/events", { signal: sseController.signal });
  check("GET /events is text/event-stream", (sseRes.headers.get("content-type") || "").includes("text/event-stream"));

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readUntil = async (needle, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (buffer.includes(needle)) return true;
      const { value, done } = await reader.read();
      if (done) return buffer.includes(needle);
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer.includes(needle);
  };

  check("SSE sends the current count immediately on connect", await readUntil('"count":7'));

  buffer = "";
  await api("/api/bump?d=1");
  check("SSE pushes the new count to connected overlays", await readUntil('"count":8'));

  sseController.abort();

  // --- the count must survive a restart -----------------------------------
  await stop(child);
  check("state file was written next to the configured path", fs.existsSync(stateFile));

  ({ child, ready } = startServer(port, stateFile));
  await ready;
  r = await api("/api/state");
  check("count is restored after restarting the server (OBS closed overnight)", r.body.count === 8);

  await stop(child);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`twitch counter: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
