// Simulates a fleet of warehouse robots and publishes their telemetry to the
// backend's /ingest websocket, in the exact record shape events.jsonl uses.
// This is a standalone process on purpose (producer/consumer split): kill it,
// restart it, or run several of them, and the backend doesn't care.

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const roster = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/robots.json'), 'utf8'));

// Shelf obstacles read off layout.png (900x560 site, six solid rectangles), used
// so robots route around shelves instead of driving through them.
const SHELVES = [
  { x0: 150, y0: 80, x1: 350, y1: 140 },
  { x0: 150, y0: 220, x1: 350, y1: 280 },
  { x0: 150, y0: 360, x1: 350, y1: 420 },
  { x0: 500, y0: 60, x1: 560, y1: 460 },
  { x0: 650, y0: 150, x1: 850, y1: 200 },
  { x0: 650, y0: 340, x1: 850, y1: 390 },
];
const { width: SITE_W, height: SITE_H } = cfg.site;
const MARGIN = 10;

function insideShelf(x, y) {
  return SHELVES.some((s) => x >= s.x0 - MARGIN && x <= s.x1 + MARGIN && y >= s.y0 - MARGIN && y <= s.y1 + MARGIN);
}

function randomOpenPoint() {
  for (let i = 0; i < 200; i++) {
    const x = MARGIN + Math.random() * (SITE_W - 2 * MARGIN);
    const y = MARGIN + Math.random() * (SITE_H - 2 * MARGIN);
    if (!insideShelf(x, y)) return { x, y };
  }
  return { x: SITE_W / 2, y: SITE_H / 2 };
}

const STATUS = {
  IDLE: 'idle', ACTIVE: 'active', ON_MISSION: 'on_mission', CHARGING: 'charging',
  BLOCKED: 'blocked', ERROR: 'error', MAINTENANCE: 'maintenance', OFFLINE: 'offline',
};

const SPEED_UNITS_PER_S = { picker: 22, hauler: 16 }; // haulers are bigger, slower
const LOW_BATTERY = 20;
const FULL_BATTERY = 95;

class SimRobot {
  constructor(id, type, start) {
    this.id = id;
    this.type = type;
    this.x = start.x;
    this.y = start.y;
    this.status = STATUS.IDLE;
    this.battery = 40 + Math.random() * 55;
    this.target = null;
    this.statusTimer = 2 + Math.random() * 8; // seconds until next status re-roll
    this.offlineFor = 0;
  }

  // Advance the robot's internal simulation by dtSeconds of wall-clock time.
  // Movement is continuous (interpolated toward a target), never a teleport.
  tick(dtSeconds) {
    if (this.status === STATUS.OFFLINE) {
      this.offlineFor -= dtSeconds;
      if (this.offlineFor <= 0) this._setStatus(STATUS.IDLE);
      return;
    }

    this.statusTimer -= dtSeconds;
    if (this.statusTimer <= 0) this._maybeChangeStatus();

    if (this.status === STATUS.CHARGING) {
      this.battery = Math.min(100, this.battery + dtSeconds * 4); // ~25s to top up 100%
      if (this.battery >= FULL_BATTERY) this._setStatus(STATUS.IDLE);
      return;
    }

    if (this.status === STATUS.MAINTENANCE || this.status === STATUS.BLOCKED || this.status === STATUS.ERROR) {
      // Stationary while flagged; battery ticks down slowly (systems still on).
      this.battery = Math.max(0, this.battery - dtSeconds * 0.05);
      return;
    }

    // active / on_mission / idle: idle robots occasionally drift to a new spot
    // too (a real picker doesn't sit dead still), just slower and less often.
    const moving = this.status === STATUS.ACTIVE || this.status === STATUS.ON_MISSION;
    if (!this.target || this._closeToTarget()) {
      this.target = randomOpenPoint();
    }
    const speed = (SPEED_UNITS_PER_S[this.type] || 18) * (moving ? 1 : 0.15);
    this._stepToward(this.target, speed * dtSeconds);

    if (moving) {
      this.battery = Math.max(0, this.battery - dtSeconds * 0.35);
      if (this.battery <= LOW_BATTERY && Math.random() < 0.3) this._setStatus(STATUS.CHARGING);
    } else {
      this.battery = Math.max(0, this.battery - dtSeconds * 0.05);
    }
  }

  _closeToTarget() {
    if (!this.target) return true;
    return Math.hypot(this.x - this.target.x, this.y - this.target.y) < 3;
  }

  _stepToward(target, maxDist) {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(maxDist, dist);
    let nx = this.x + (dx / dist) * step;
    let ny = this.y + (dy / dist) * step;
    nx = Math.max(MARGIN, Math.min(SITE_W - MARGIN, nx));
    ny = Math.max(MARGIN, Math.min(SITE_H - MARGIN, ny));
    // Simple obstacle avoidance: if the step would land inside a shelf, pick a
    // fresh open target instead of clipping through it.
    if (insideShelf(nx, ny)) {
      this.target = randomOpenPoint();
      return;
    }
    this.x = nx;
    this.y = ny;
  }

  _maybeChangeStatus() {
    this.statusTimer = 3 + Math.random() * 10;
    const r = Math.random();
    if (this.battery <= LOW_BATTERY) {
      this._setStatus(r < 0.85 ? STATUS.CHARGING : STATUS.ERROR);
      return;
    }
    switch (this.status) {
      case STATUS.IDLE:
        if (r < 0.55) this._setStatus(STATUS.ACTIVE);
        else if (r < 0.75) this._setStatus(STATUS.ON_MISSION);
        else if (r < 0.8) this._setStatus(STATUS.MAINTENANCE);
        break;
      case STATUS.ACTIVE:
        if (r < 0.35) this._setStatus(STATUS.ON_MISSION);
        else if (r < 0.55) this._setStatus(STATUS.IDLE);
        else if (r < 0.6) this._setStatus(STATUS.BLOCKED);
        else if (r < 0.62) this._setStatus(STATUS.OFFLINE);
        break;
      case STATUS.ON_MISSION:
        if (r < 0.45) this._setStatus(STATUS.ACTIVE);
        else if (r < 0.6) this._setStatus(STATUS.IDLE);
        else if (r < 0.65) this._setStatus(STATUS.ERROR);
        break;
      case STATUS.BLOCKED:
        if (r < 0.7) this._setStatus(STATUS.ACTIVE);
        break;
      case STATUS.ERROR:
        if (r < 0.5) this._setStatus(STATUS.MAINTENANCE);
        break;
      case STATUS.MAINTENANCE:
        if (r < 0.6) this._setStatus(STATUS.IDLE);
        break;
      default:
        this._setStatus(STATUS.IDLE);
    }
  }

  _setStatus(next) {
    this.status = next;
    if (next === STATUS.OFFLINE) this.offlineFor = 5 + Math.random() * 20;
  }

  toRecord(tSeconds, paddingBytes) {
    const rec = {
      t: tSeconds,
      robot_id: this.id,
      robot_type: this.type,
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      status: this.status,
      battery: Math.round(this.battery * 10) / 10,
    };
    if (paddingBytes > 0) rec._pad = 'x'.repeat(paddingBytes);
    return rec;
  }
}

function buildFleet(size) {
  const fleet = [];
  for (let i = 0; i < size; i++) {
    if (i < roster.length) {
      const r = roster[i];
      fleet.push(new SimRobot(r.robot_id, r.robot_type, r.start));
    } else {
      const type = i % 2 === 0 ? 'picker' : 'hauler';
      fleet.push(new SimRobot(`r${i + 1}`, type, randomOpenPoint()));
    }
  }
  return fleet;
}

module.exports = { SimRobot, buildFleet, insideShelf, randomOpenPoint, STATUS };

// --- runtime: reconnecting ingest producer + config polling -----------------
// Guarded so `require('./simulator')` from tests can reuse SimRobot/buildFleet
// without opening a websocket or starting timers as a side effect of loading.
if (require.main === module) {

let fleet = buildFleet(cfg.fleetSize);
let live = { fleetSize: cfg.fleetSize, updateIntervalMs: cfg.updateIntervalMs, payloadPaddingBytes: cfg.payloadPaddingBytes };
let ws = null;
let simClockS = 0;
let tickHandle = null;

function resizeFleetIfNeeded(newSize) {
  if (newSize === fleet.length) return;
  if (newSize > fleet.length) {
    for (let i = fleet.length; i < newSize; i++) {
      const type = i % 2 === 0 ? 'picker' : 'hauler';
      fleet.push(new SimRobot(`r${i + 1}`, type, randomOpenPoint()));
    }
  } else {
    fleet.length = newSize; // "decommission" the extra robots
  }
  console.log(`[simulator] fleet resized to ${fleet.length}`);
}

async function pollConfig() {
  try {
    const res = await fetch(`${cfg.backendHttpUrl}/api/config`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.fleetSize && data.fleetSize !== live.fleetSize) {
      live.fleetSize = data.fleetSize;
      resizeFleetIfNeeded(data.fleetSize);
    }
    if (data.updateIntervalMs && data.updateIntervalMs !== live.updateIntervalMs) {
      live.updateIntervalMs = data.updateIntervalMs;
      restartTickLoop();
      console.log(`[simulator] update interval -> ${live.updateIntervalMs}ms`);
    }
    if (data.payloadPaddingBytes !== undefined) live.payloadPaddingBytes = data.payloadPaddingBytes;
  } catch {
    // backend unreachable right now -- keep running with last known config,
    // this is exactly the "flaky network" case the challenge calls out.
  }
}
setInterval(pollConfig, 4000);

function connect() {
  ws = new WebSocket(cfg.backendIngestUrl);
  ws.on('open', () => console.log(`[simulator] connected to ${cfg.backendIngestUrl}`));
  ws.on('close', () => {
    console.log('[simulator] ingest connection lost, retrying in 2s');
    setTimeout(connect, 2000); // reconnect with backoff
  });
  ws.on('error', () => {}); // 'close' fires right after; avoid noisy duplicate logs
}
connect();

function publishTick() {
  const dt = live.updateIntervalMs / 1000;
  simClockS += dt;
  for (const r of fleet) r.tick(dt);

  if (!ws || ws.readyState !== WebSocket.OPEN) return; // drop this tick, don't queue unboundedly
  const batch = fleet.map((r) => r.toRecord(Math.round(simClockS), live.payloadPaddingBytes));
  ws.send(JSON.stringify(batch));
}

function restartTickLoop() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(publishTick, live.updateIntervalMs);
}
restartTickLoop();

console.log(`[simulator] fleet size ${fleet.length}, update interval ${live.updateIntervalMs}ms`);

} // end require.main guard
