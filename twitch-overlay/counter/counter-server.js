#!/usr/bin/env node
/**
 * Odinheim counter — a tiny local server for a keyboard-driven stream counter
 * (deaths, KC, dry streaks, whatever you want to tally live).
 *
 *   node twitch-overlay/counter/counter-server.js
 *
 * Then point an OBS Browser Source at  http://127.0.0.1:7391/
 *
 * Why a server at all: an OBS browser source can only see keystrokes while its
 * "Interact" window is focused, so pressing a key mid-game does nothing. This
 * server holds the count instead, and anything that CAN see your keys pushes to
 * it — the bundled hotkeys.ps1, Streamer.bot, a Stream Deck, a phone on the
 * /app page, or plain old curl.
 *
 *   GET /api/bump?d=1     add 1 (d=-1 subtracts, d=5 adds five)
 *   GET /api/reset        back to zero
 *   GET /api/set?n=42     jump to a number
 *   GET /api/state        {"count":42}
 *   GET /events           Server-Sent Events stream (what the overlay listens to)
 *   GET /                 the overlay (OBS)
 *   GET /demo             overlay + buttons on one page (handy for trying it out)
 *   GET /app              clickable buttons page (mouse / phone / Stream Deck)
 *
 * The count is written to counter-state.json, so restarting OBS or this server
 * doesn't lose it. No dependencies — plain node:http.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.COUNTER_PORT || 7391);
const HOST = process.env.COUNTER_HOST || "0.0.0.0";
// Overridable so tests (and throwaway demo instances) never clobber your real count.
const STATE_FILE = process.env.COUNTER_STATE_FILE || path.join(__dirname, "counter-state.json");

/* ---------- state ---------- */
let state = { count: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (Number.isFinite(saved.count)) state.count = saved.count;
} catch {
  /* first run, or a half-written file — start at zero */
}

function persist() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn("[counter] could not save state:", e.message);
  }
}

/* ---------- Server-Sent Events fan-out ---------- */
const clients = new Set();

function broadcast() {
  const frame = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function setCount(next) {
  const before = state.count;
  state.count = Math.trunc(next);
  persist();
  broadcast();
  const delta = state.count - before;
  const arrow = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "=";
  console.log(`[counter] ${arrow} -> ${state.count}`);
  return state;
}

/* ---------- helpers ---------- */
const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    // lets Streamer.bot, a phone on your LAN, or any local page call the API
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
};

const serveFile = (res, name, type) => {
  fs.readFile(path.join(__dirname, name), (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(buf);
  });
};

/* ---------- routes ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;

  if (route === "/" || route === "/counter.html") {
    return serveFile(res, "counter.html", "text/html; charset=utf-8");
  }
  if (route === "/demo" || route === "/demo.html") {
    return serveFile(res, "demo.html", "text/html; charset=utf-8");
  }
  if (route === "/app" || route === "/control.html") {
    return serveFile(res, "control.html", "text/html; charset=utf-8");
  }

  if (route === "/api/state") return json(res, 200, state);

  if (route === "/api/bump") {
    const raw = q.get("d");
    const d = raw === null ? 1 : Number.parseInt(raw, 10);
    if (!Number.isFinite(d)) return json(res, 400, { error: "d must be a number" });
    return json(res, 200, setCount(state.count + d));
  }

  if (route === "/api/reset") return json(res, 200, setCount(0));

  if (route === "/api/set") {
    const n = Number.parseInt(q.get("n"), 10);
    if (!Number.isFinite(n)) return json(res, 400, { error: "n must be a number" });
    return json(res, 200, setCount(n));
  }

  if (route === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`retry: 1000\ndata: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    // keep-alive comment so proxies and OBS don't drop an idle stream
    const beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(beat);
      }
    }, 25_000);
    req.on("close", () => {
      clearInterval(beat);
      clients.delete(res);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[counter] overlay   http://127.0.0.1:${PORT}/`);
  console.log(`[counter] buttons   http://127.0.0.1:${PORT}/app`);
  console.log(`[counter] bump api  http://127.0.0.1:${PORT}/api/bump?d=1`);
  console.log(`[counter] count is  ${state.count}`);
});

/* let Ctrl+C exit cleanly even with SSE clients attached */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
