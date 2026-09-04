const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const cfg = require('./config');
const { FleetState } = require('./state');
const { createHistoryStore } = require('./db');
const { shouldSendFrame } = require('./backpressure');

const app = express();
app.use(express.json({ limit: '5mb' })); // generous: payload size is a stress knob
const server = http.createServer(app);

const state = new FleetState(cfg);
const history = createHistoryStore(cfg);

// Live-adjustable knobs. Mutated only through the admin-protected endpoint below;
// the simulator polls GET /api/config every few seconds and adapts without a
// redeploy or restart.
const liveConfig = {
  fleetSize: cfg.fleetSize,
  updateIntervalMs: cfg.updateIntervalMs,
  payloadPaddingBytes: cfg.payloadPaddingBytes,
};

// ---------------------------------------------------------------------------
// Static dashboard + JSON API
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, robots: state.robots.size, uptime_s: Math.round(process.uptime()) });
});

app.get('/api/config', (_req, res) => {
  res.json({
    ...liveConfig,
    broadcastIntervalMs: cfg.broadcastIntervalMs,
    staleAfterMs: cfg.staleAfterMs,
    site: cfg.site,
    historyEnabled: history.enabled,
  });
});

// Admin-protected: changes fleet size / update interval / payload padding live.
// "Protected sensibly" per the challenge -- a bearer token, not open to the
// internet. Good enough for a take-home; a real deploy would put this behind
// real auth (see FINDINGS.md for what we'd do next).
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  if (!token || token !== cfg.adminToken) {
    return res.status(401).json({ error: 'missing or invalid x-admin-token' });
  }
  next();
}

app.post('/api/config', requireAdmin, (req, res) => {
  const { fleetSize, updateIntervalMs, payloadPaddingBytes } = req.body || {};
  if (fleetSize !== undefined) {
    const n = Number(fleetSize);
    if (!Number.isFinite(n) || n < 1 || n > 20000) {
      return res.status(400).json({ error: 'fleetSize must be between 1 and 20000' });
    }
    liveConfig.fleetSize = Math.round(n);
  }
  if (updateIntervalMs !== undefined) {
    const n = Number(updateIntervalMs);
    if (!Number.isFinite(n) || n < 100 || n > 60000) {
      return res.status(400).json({ error: 'updateIntervalMs must be between 100 and 60000' });
    }
    liveConfig.updateIntervalMs = Math.round(n);
  }
  if (payloadPaddingBytes !== undefined) {
    const n = Number(payloadPaddingBytes);
    if (!Number.isFinite(n) || n < 0 || n > 200000) {
      return res.status(400).json({ error: 'payloadPaddingBytes must be between 0 and 200000' });
    }
    liveConfig.payloadPaddingBytes = Math.round(n);
  }
  res.json({ ok: true, liveConfig });
});

// Snapshot fallback for consumers that don't want a websocket (also what the
// dashboard uses on first paint before its socket connects).
app.get('/api/robots', (_req, res) => {
  res.json({ t: Date.now(), robots: state.snapshot() });
});

app.get('/api/trend', (req, res) => {
  const sinceMs = req.query.since_ms ? Number(req.query.since_ms) : undefined;
  res.json({ buckets: state.trend(sinceMs), bucket_ms: cfg.aggregateBucketMs });
});

// Stretch goal endpoint.
app.get('/robots/history/:robot_id', (req, res) => {
  if (!history.enabled) return res.status(404).json({ error: 'history persistence disabled' });
  const { robot_id } = req.params;
  const from = req.query.from ? Number(req.query.from) : Date.now() - 15 * 60 * 1000;
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 20000) : 5000;
  res.json({ robot_id, from, to, points: history.queryHistory(robot_id, from, to, limit) });
});

// ---------------------------------------------------------------------------
// Ingest surface: robots/simulators push updates here. Kept deliberately dumb
// and non-blocking -- see state.applyUpdate for why.
// ---------------------------------------------------------------------------
const ingestWss = new WebSocketServer({ noServer: true });
let ingestConnections = 0;

ingestWss.on('connection', (ws) => {
  ingestConnections += 1;
  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return; // malformed frame, drop it -- never let a bad producer crash ingestion
    }
    const updates = Array.isArray(payload) ? payload : [payload];
    for (const u of updates) state.applyUpdate(u);
  });
  ws.on('close', () => { ingestConnections -= 1; });
  ws.on('error', () => {}); // network is flaky by design; don't let it throw
});

// ---------------------------------------------------------------------------
// Stream surface: dashboards subscribe here for live state.
// ---------------------------------------------------------------------------
const streamWss = new WebSocketServer({ noServer: true });
const streamClients = new Set();

streamWss.on('connection', (ws) => {
  streamClients.add(ws);
  // Full snapshot immediately on connect/reconnect so a client that dropped and
  // came back is never stuck showing stale data waiting for the next tick.
  safeSend(ws, JSON.stringify({
    type: 'snapshot',
    t: Date.now(),
    robots: state.snapshot(),
    trend: state.trend(30 * 60 * 1000),
    bucket_ms: cfg.aggregateBucketMs,
  }));
  ws.on('close', () => streamClients.delete(ws));
  ws.on('error', () => streamClients.delete(ws));
});

function safeSend(ws, str) {
  if (ws.readyState !== ws.OPEN) return;
  // Backpressure: if this client's socket is already backed up (slow consumer,
  // bad network), skip this frame for them instead of buffering unboundedly or
  // blocking the broadcast loop for everyone else. They'll catch up on the next
  // tick, and a reconnect always gets a fresh full snapshot regardless.
  if (!shouldSendFrame(ws.bufferedAmount, cfg.maxClientBufferedBytes)) return;
  ws.send(str);
}

// Broadcast loop runs on its own clock, independent of ingestion rate. This is
// what keeps a burst of robot updates from ever translating into a burst of
// browser-side work.
setInterval(() => {
  if (streamClients.size === 0) return;
  const message = JSON.stringify({
    type: 'update',
    t: Date.now(),
    robots: state.snapshot(),
    trend_tail: state.trend(cfg.aggregateBucketMs * 2), // just the freshest bucket(s)
  });
  for (const ws of streamClients) safeSend(ws, message);
}, cfg.broadcastIntervalMs);

// Throttled history writer: batches whatever arrived since the last flush into
// one transaction, off the ingest hot path.
if (history.enabled) {
  setInterval(() => {
    const batch = state.drainHistoryQueue();
    if (batch.length) history.insertBatch(batch);
  }, cfg.historyFlushIntervalMs);
}

// ---------------------------------------------------------------------------
// Route websocket upgrades to the right server by path.
// ---------------------------------------------------------------------------
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/ingest') {
    ingestWss.handleUpgrade(req, socket, head, (ws) => ingestWss.emit('connection', ws, req));
  } else if (pathname === '/stream') {
    streamWss.handleUpgrade(req, socket, head, (ws) => streamWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(cfg.port, () => {
  console.log(`[server] listening on :${cfg.port}`);
  console.log(`[server] dashboard   http://localhost:${cfg.port}/`);
  console.log(`[server] ingest ws   ws://localhost:${cfg.port}/ingest`);
  console.log(`[server] stream ws   ws://localhost:${cfg.port}/stream`);
});

module.exports = { app, server, state, liveConfig, ingestWss, streamWss, shouldSendFrame };
