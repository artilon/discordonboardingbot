// Coverage for the ToA dry counter's local server
// (twitch-overlay/counter/counter-server.js).
//
// The counter means one specific thing: how many chests since the last purple.
// So the arithmetic that has to be exactly right is not just +1 — it's that a
// purple banks the streak, updates the best, and leaves the live count at zero,
// and that none of it is lost when OBS or the PC restarts mid-session.
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
      if (out.includes("listening on port")) {
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
  check("fresh state also carries best/purples for the HUD's stats line",
    r.body.best === 0 && r.body.purples === 0 && Array.isArray(r.body.history));

  // --- bump ---------------------------------------------------------------
  r = await api("/api/bump?d=1");
  check("GET /api/bump?d=1 increments to 1", r.body.count === 1);
  r = await api("/api/bump");
  check("GET /api/bump with no d defaults to +1 (easy for Streamer.bot)", r.body.count === 2);
  r = await api("/api/bump?d=-1");
  check("GET /api/bump?d=-1 decrements to 1", r.body.count === 1);
  r = await api("/api/bump?d=-5");
  check("a dry streak can't go negative (1 - 5 clamps to 0)", r.body.count === 0);

  // --- set / reset --------------------------------------------------------
  r = await api("/api/set?n=42");
  check("GET /api/set?n=42 jumps to 42", r.body.count === 42);
  r = await api("/api/reset");
  check("GET /api/reset returns to 0", r.body.count === 0);
  r = await api("/api/bump?d=7");
  check("bump after reset works (7)", r.body.count === 7);

  // --- the purple: bank the streak, remember the best, start again --------
  await api("/api/reset");
  for (let i = 0; i < 26; i++) await api("/api/bump?d=1");   // a 26-chest dry streak
  r = await api("/api/state");
  check("26 chests in a row leaves the count at 26", r.body.count === 26);

  r = await api("/api/purple");
  check("GET /api/purple returns the streak that just ended", r.body.streak === 26);
  check("the live count drops back to 0 after a purple", r.body.count === 0);
  check("the best streak is updated to 26", r.body.best === 26);
  check("the purple count goes to 1", r.body.purples === 1);
  check("the streak is appended to history with a timestamp",
    r.body.history.length === 1 && r.body.history[0].streak === 26 && !!r.body.history[0].at);

  r = await api("/api/purple");
  check("a purple at 0 dry is recorded but doesn't lower the best (still 26)",
    r.body.best === 26 && r.body.count === 0 && r.body.purples === 2);

  for (let i = 0; i < 31; i++) await api("/api/bump?d=1");   // beat it
  r = await api("/api/purple");
  check("a longer streak replaces the best (31)", r.body.best === 31 && r.body.streak === 31);
  check("history keeps both streaks, oldest first",
    r.body.history.length === 3 && r.body.history[2].streak === 31);

  r = await api("/api/reset");
  check("/api/reset zeroes the count without touching best or purple count",
    r.body.count === 0 && r.body.best === 31 && r.body.purples === 3);
  check("/api/reset does not invent a history entry", r.body.history.length === 3);

  await api("/api/set?n=8");                                  // leave a known value
  r = await api("/api/state");
  check("count can be set directly for fixing a miscount (8)", r.body.count === 8);

  // --- bad input is rejected, not crashed on -----------------------------
  r = await api("/api/bump?d=banana");
  check("non-numeric d is a 400, not a crash", r.status === 400);
  r = await api("/api/set?n=nope");
  check("non-numeric n is a 400", r.status === 400);
  r = await api("/api/state");
  check("the count is untouched by the rejected calls", r.body.count === 8);

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
  check("overlay labels itself as a chests-since-purple counter",
    overlayHtml.includes("chests since purple"));
  check("overlay page has a transparent background for OBS", overlayHtml.includes("background: transparent"));

  const control = await fetch(base + "/app");
  const controlHtml = await control.text();
  check("GET /app serves the buttons page", control.status === 200 && controlHtml.includes("/api/bump"));
  check("buttons page has the purple button", controlHtml.includes("/api/purple"));

  const demo = await fetch(base + "/demo");
  const demoHtml = await demo.text();
  check("GET /demo serves the try-it page", demo.status === 200);
  check("the demo's iframe points at /counter.html, not /, so demo-root mode can't recurse",
    demoHtml.includes('src="/counter.html"') && !demoHtml.includes('src="/"'));

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

  check("SSE sends the current count immediately on connect", await readUntil('"count":8'));

  buffer = "";
  await api("/api/bump?d=1");
  check("SSE pushes the new chest count to connected overlays", await readUntil('"count":9'));

  buffer = "";
  r = await api("/api/purple");
  check("SSE tags a purple with an event so the overlay can flash it",
    await readUntil('"event":"purple"'));
  check("the purple event carries the streak that just ended", r.body.streak === 9);

  sseController.abort();

  // --- the count must survive a restart -----------------------------------
  await stop(child);
  check("state file was written next to the configured path", fs.existsSync(stateFile));

  ({ child, ready } = startServer(port, stateFile));
  await ready;
  r = await api("/api/state");
  check("count is restored after restarting the server (OBS closed overnight)", r.body.count === 0);
  check("best survives the restart", r.body.best === 31);
  check("purple count survives the restart", r.body.purples === 4);
  check("streak history survives the restart", r.body.history.length === 4);

  // --- an old deaths-counter state file must not explode ----------------
  const legacy = path.join(dir, "legacy.json");
  fs.writeFileSync(legacy, JSON.stringify({ count: 5 }));
  const legacyPort = await freePort();
  const legacyServer = startServer(legacyPort, legacy);
  await legacyServer.ready;
  const legacyState = await (await fetch(`http://127.0.0.1:${legacyPort}/api/state`)).json();
  check("a legacy {count:5} state file loads and gains best/purples fields",
    legacyState.count === 5 && legacyState.best === 0 && legacyState.purples === 0);
  await stop(legacyServer.child);

  await stop(child);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`twitch counter: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
