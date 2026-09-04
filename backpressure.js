// Extracted so it can be unit tested without spinning up a real websocket
// server -- see test/backpressure.test.js.
function shouldSendFrame(bufferedAmount, maxBytes) {
  return bufferedAmount <= maxBytes;
}

module.exports = { shouldSendFrame };
