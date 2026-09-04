// Stretch goal: persist fleet history and expose GET /robots/history/:robot_id.
// Chosen store: SQLite via better-sqlite3. One sentence why: it's a single file,
// needs no separate service to provision or pay for, and better-sqlite3's
// synchronous API is fast enough for batched, throttled writes off the hot path --
// for a real multi-instance deployment you'd swap this for Postgres/Timescale
// without touching the ingest or websocket code, since this module is the only
// thing that talks to it.

const path = require('path');

function createHistoryStore(cfg) {
  if (!cfg.historyEnabled) {
    return {
      enabled: false,
      insertBatch() {},
      queryHistory() { return []; },
      close() {},
    };
  }

  const Database = require('better-sqlite3');
  const db = new Database(path.resolve(cfg.dbPath));
  db.pragma('journal_mode = WAL'); // don't let writers block readers
  db.exec(`
    CREATE TABLE IF NOT EXISTS robot_history (
      robot_id TEXT NOT NULL,
      t INTEGER,
      received_at INTEGER NOT NULL,
      x REAL, y REAL,
      status TEXT,
      battery REAL
    );
    CREATE INDEX IF NOT EXISTS idx_history_robot_time
      ON robot_history (robot_id, received_at);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO robot_history (robot_id, t, received_at, x, y, status, battery)
    VALUES (@robot_id, @t, @received_at, @x, @y, @status, @battery)
  `);
  const insertMany = db.transaction((records) => {
    for (const r of records) insertStmt.run(r);
  });

  const queryStmt = db.prepare(`
    SELECT robot_id, t, received_at, x, y, status, battery
    FROM robot_history
    WHERE robot_id = ? AND received_at BETWEEN ? AND ?
    ORDER BY received_at ASC
    LIMIT ?
  `);

  return {
    enabled: true,
    insertBatch(records) {
      if (!records.length) return;
      insertMany(records);
    },
    queryHistory(robotId, fromMs, toMs, limit = 5000) {
      return queryStmt.all(robotId, fromMs, toMs, limit);
    },
    close() { db.close(); },
  };
}

module.exports = { createHistoryStore };
