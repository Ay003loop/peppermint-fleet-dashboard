// FleetState is the single source of truth the backend keeps in memory.
// It is intentionally dumb and O(1) per update: ingestion must never do
// anything that scales with fleet size or with the number of connected
// dashboards, or a burst of robot updates would stall the whole pipeline.

const STATUSES = [
  'idle', 'active', 'on_mission', 'charging', 'blocked', 'error', 'maintenance', 'offline',
];

// Statuses we surface as "needs attention" in the UI. This is a judgment call the
// challenge deliberately leaves open -- see FINDINGS.md / ARCHITECTURE.md for the
// reasoning. blocked/error/offline are unambiguous; a robot below LOW_BATTERY_PCT
// while not already charging also counts, handled separately in needsAttention().
const ATTENTION_STATUSES = new Set(['blocked', 'error', 'offline']);
const LOW_BATTERY_PCT = 15;

class FleetState {
  constructor(cfg) {
    this.cfg = cfg;
    this.robots = new Map(); // robot_id -> latest known record
    this.aggregateBuckets = []; // ring buffer of {t, counts:{status:count}, total}
    this._bucketStart = null;
    this._bucketCounts = null;
    this._dirtyForHistory = []; // records queued for the (throttled) sqlite writer
  }

  // Called from the ingest path. Must stay cheap: one Map.set, nothing else
  // synchronous. Aggregate bucketing below is O(1) amortized too.
  applyUpdate(update) {
    const { robot_id } = update;
    if (!robot_id) return;

    const prev = this.robots.get(robot_id);
    // Out-of-order guard: a producer's connection can drop and reconnect, and
    // retries can arrive out of order. Keep the record with the newest `t`
    // (falling back to arrival order if `t` ties or is missing).
    if (prev && typeof prev.t === 'number' && typeof update.t === 'number' && update.t < prev.t) {
      return; // stale message, drop it
    }

    const record = {
      robot_id,
      robot_type: update.robot_type || prev?.robot_type || 'unknown',
      x: update.x,
      y: update.y,
      status: update.status,
      battery: update.battery,
      t: update.t,
      received_at: Date.now(),
    };
    this.robots.set(robot_id, record);
    this._bucketize(record);
    if (this.cfg.historyEnabled) this._dirtyForHistory.push(record);
  }

  _bucketize(record) {
    const bucketMs = this.cfg.aggregateBucketMs;
    const bucketT = Math.floor(Date.now() / bucketMs) * bucketMs;
    if (this._bucketStart !== bucketT) {
      if (this._bucketCounts) {
        this.aggregateBuckets.push({ t: this._bucketStart, counts: this._bucketCounts, total: this._bucketTotal });
        const maxLen = this.cfg.aggregateHistoryLength;
        if (this.aggregateBuckets.length > maxLen) this.aggregateBuckets.shift();
      }
      this._bucketStart = bucketT;
      this._bucketCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      this._bucketTotal = 0;
    }
    // Overwrite-per-robot-per-bucket semantics would need a per-bucket set; for a
    // trend line, counting each *update* as a sample of "what fraction of updates
    // this window were status X" is an acceptable, cheap approximation and reads
    // fine at any update interval. We recompute a robot-accurate live snapshot
    // separately for the "right now" numbers (see snapshotCounts()).
    if (this._bucketCounts[record.status] !== undefined) {
      this._bucketCounts[record.status] += 1;
      this._bucketTotal += 1;
    }
  }

  // Current, exact counts by status across the whole known fleet -- used for the
  // "right now" readout and for closing out the in-progress bucket on read.
  snapshotCounts() {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of this.robots.values()) {
      if (counts[r.status] !== undefined) counts[r.status] += 1;
    }
    return { counts, total: this.robots.size };
  }

  needsAttention(r) {
    if (ATTENTION_STATUSES.has(r.status)) return true;
    if (typeof r.battery === 'number' && r.battery <= LOW_BATTERY_PCT && r.status !== 'charging') return true;
    return false;
  }

  isStale(r, now = Date.now()) {
    return now - r.received_at > this.cfg.staleAfterMs;
  }

  snapshot() {
    const now = Date.now();
    return Array.from(this.robots.values()).map((r) => ({
      ...r,
      needs_attention: this.needsAttention(r),
      stale: this.isStale(r, now),
    }));
  }

  // Trend series for the dashboard chart: closed buckets + the in-progress one.
  trend(sinceMs) {
    const now = Date.now();
    const cutoff = sinceMs ? now - sinceMs : 0;
    const closed = this.aggregateBuckets.filter((b) => b.t >= cutoff);
    const inProgress = this._bucketCounts
      ? [{ t: this._bucketStart, counts: this._bucketCounts, total: this._bucketTotal }]
      : [];
    return [...closed, ...inProgress];
  }

  drainHistoryQueue() {
    const batch = this._dirtyForHistory;
    this._dirtyForHistory = [];
    return batch;
  }
}

module.exports = { FleetState, STATUSES, ATTENTION_STATUSES, LOW_BATTERY_PCT };
