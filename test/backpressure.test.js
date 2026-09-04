const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSendFrame } = require('../backpressure');

test('sends when the client socket has no backlog', () => {
  assert.equal(shouldSendFrame(0, 1_000_000), true);
});

test('sends up to and including the configured limit', () => {
  assert.equal(shouldSendFrame(1_000_000, 1_000_000), true);
});

test('drops the frame once the client is backed up past the limit', () => {
  // This is what protects the broadcast loop (and every other connected
  // dashboard) from one slow/flaky client: we skip *this* client's frame
  // instead of buffering unboundedly or blocking the loop for everyone.
  assert.equal(shouldSendFrame(1_000_001, 1_000_000), false);
});
