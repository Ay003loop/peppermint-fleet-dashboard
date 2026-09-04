// Central place every process (server + simulator) reads its tunable knobs from.
// Everything here is overridable via environment variables so fleet size, update
// interval and payload size can change without touching code (challenge requirement).
require('dotenv').config();

const SITE = {
  // layout.png is 900x560, 1px = 1 unit (per the data contract).
  width: Number(process.env.SITE_WIDTH || 900),
  height: Number(process.env.SITE_HEIGHT || 560),
};

const config = {
  port: Number(process.env.PORT || 8080),

  // Bearer-style token that guards the live /api/config control endpoint and the
  // admin panel in the dashboard. Set this in your deploy env; default is only for
  // local dev so the app isn't unusable out of the box.
  adminToken: process.env.ADMIN_TOKEN || 'dev-admin-token',

  // Where the simulator sends robot updates (backend ingest websocket).
  backendIngestUrl: process.env.BACKEND_INGEST_URL || `ws://localhost:${Number(process.env.PORT || 8080)}/ingest`,
  // Where the simulator polls for live config changes (fleet size / interval).
  backendHttpUrl: process.env.BACKEND_HTTP_URL || `http://localhost:${Number(process.env.PORT || 8080)}`,

  // --- Simulator knobs (all live-adjustable post-deploy via /api/config) ---
  fleetSize: Number(process.env.FLEET_SIZE || 8),
  updateIntervalMs: Number(process.env.UPDATE_INTERVAL_MS || 5000),
  payloadPaddingBytes: Number(process.env.PAYLOAD_PADDING_BYTES || 0),

  // --- Backend broadcast knobs ---
  // How often we push snapshots/diffs to dashboard clients. Decoupled from
  // updateIntervalMs on purpose: ingestion rate and broadcast rate are independent,
  // so a burst on one side never determines pacing on the other.
  broadcastIntervalMs: Number(process.env.BROADCAST_INTERVAL_MS || 500),
  // Aggregate trend bucket size (fleet-wide status counts over time).
  aggregateBucketMs: Number(process.env.AGGREGATE_BUCKET_MS || 5000),
  aggregateHistoryLength: Number(process.env.AGGREGATE_HISTORY_LENGTH || 4320), // ~6h at 5s buckets
  // Max bytes we'll let a single client socket buffer before we drop a frame for it.
  maxClientBufferedBytes: Number(process.env.MAX_CLIENT_BUFFERED_BYTES || 1_000_000),
  // A robot we haven't heard from in this long is shown as "stale" in the UI.
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 20_000),

  // History persistence (stretch goal). Set to 'memory' to disable disk writes.
  dbPath: process.env.DB_PATH || './fleet_history.db',
  historyEnabled: (process.env.HISTORY_ENABLED ?? 'true') !== 'false',
  historyFlushIntervalMs: Number(process.env.HISTORY_FLUSH_INTERVAL_MS || 3000),

  site: SITE,
};

module.exports = config;
