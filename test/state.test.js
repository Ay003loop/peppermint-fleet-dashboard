const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetState } = require('../state');

function cfg(overrides = {}) {
  return {
    aggregateBucketMs: 5000,
    aggregateHistoryLength: 100,
    staleAfterMs: 20000,
    historyEnabled: false,
    ...overrides,
  };
}

test('applyUpdate stores the latest record for a new robot', () => {
  const s = new FleetState(cfg());
  s.applyUpdate({ robot_id: 'r1', t: 0, x: 1, y: 2, status: 'idle', battery: 90 });
  const snap = s.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].robot_id, 'r1');
  assert.equal(snap[0].status, 'idle');
});

test('applyUpdate overwrites with newer t', () => {
  const s = new FleetState(cfg());
  s.applyUpdate({ robot_id: 'r1', t: 5, x: 1, y: 1, status: 'idle', battery: 90 });
  s.applyUpdate({ robot_id: 'r1', t: 10, x: 2, y: 2, status: 'active', battery: 89 });
  const r = s.snapshot()[0];
  assert.equal(r.status, 'active');
  assert.equal(r.x, 2);
});

test('applyUpdate drops a stale out-of-order message (lower t after a higher t)', () => {
  // Real deployments have flaky networks: a producer can reconnect and resend an
  // older buffered message after a newer one already landed. The store must not
  // let that older message clobber the current state.
  const s = new FleetState(cfg());
  s.applyUpdate({ robot_id: 'r1', t: 10, x: 2, y: 2, status: 'active', battery: 89 });
  s.applyUpdate({ robot_id: 'r1', t: 5, x: 1, y: 1, status: 'idle', battery: 90 });
  const r = s.snapshot()[0];
  assert.equal(r.status, 'active', 'newer state must win over a late-arriving older message');
  assert.equal(r.t, 10);
});

test('applyUpdate ignores records with no robot_id', () => {
  const s = new FleetState(cfg());
  s.applyUpdate({ t: 0, x: 1, y: 1, status: 'idle', battery: 90 });
  assert.equal(s.robots.size, 0);
});

test('needsAttention flags blocked/error/offline regardless of battery', () => {
  const s = new FleetState(cfg());
  for (const status of ['blocked', 'error', 'offline']) {
    assert.equal(s.needsAttention({ status, battery: 80 }), true, status);
  }
  assert.equal(s.needsAttention({ status: 'idle', battery: 80 }), false);
});

test('needsAttention flags low battery unless already charging', () => {
  const s = new FleetState(cfg());
  assert.equal(s.needsAttention({ status: 'active', battery: 10 }), true);
  assert.equal(s.needsAttention({ status: 'charging', battery: 10 }), false);
  assert.equal(s.needsAttention({ status: 'active', battery: 50 }), false);
});

test('isStale compares received_at against staleAfterMs', () => {
  const s = new FleetState(cfg({ staleAfterMs: 1000 }));
  const now = 100000;
  assert.equal(s.isStale({ received_at: now - 500 }, now), false);
  assert.equal(s.isStale({ received_at: now - 5000 }, now), true);
});

test('aggregate bucket counts reflect updates applied within the current bucket', () => {
  const s = new FleetState(cfg());
  s.applyUpdate({ robot_id: 'r1', t: 0, x: 0, y: 0, status: 'active', battery: 50 });
  s.applyUpdate({ robot_id: 'r2', t: 0, x: 0, y: 0, status: 'idle', battery: 50 });
  s.applyUpdate({ robot_id: 'r3', t: 0, x: 0, y: 0, status: 'active', battery: 50 });
  const trend = s.trend();
  assert.equal(trend.length, 1);
  assert.equal(trend[0].counts.active, 2);
  assert.equal(trend[0].counts.idle, 1);
  assert.equal(trend[0].total, 3);
});

test('snapshotCounts reflects only the current, deduplicated state per robot', () => {
  const s = new FleetState(cfg());
  s.applyUpdate({ robot_id: 'r1', t: 0, x: 0, y: 0, status: 'active', battery: 50 });
  s.applyUpdate({ robot_id: 'r1', t: 5, x: 0, y: 0, status: 'idle', battery: 50 });
  const { counts, total } = s.snapshotCounts();
  assert.equal(total, 1);
  assert.equal(counts.idle, 1);
  assert.equal(counts.active, 0);
});

test('drainHistoryQueue empties the queue and only queues when historyEnabled', () => {
  const s = new FleetState(cfg({ historyEnabled: true }));
  s.applyUpdate({ robot_id: 'r1', t: 0, x: 0, y: 0, status: 'active', battery: 50 });
  const batch = s.drainHistoryQueue();
  assert.equal(batch.length, 1);
  assert.equal(s.drainHistoryQueue().length, 0);

  const disabled = new FleetState(cfg({ historyEnabled: false }));
  disabled.applyUpdate({ robot_id: 'r1', t: 0, x: 0, y: 0, status: 'active', battery: 50 });
  assert.equal(disabled.drainHistoryQueue().length, 0);
});
