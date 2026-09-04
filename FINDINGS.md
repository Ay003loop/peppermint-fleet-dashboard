# Findings

## 1. Tradeoffs

**Transport: websockets both ways, not MQTT/gRPC/a broker.** Robots publish
over a plain `ws` connection to `/ingest`; dashboards subscribe over a
separate `ws` connection to `/stream`. I rejected a real message broker
(MQTT/Kafka/etc.) for this scope: it's the "correct" answer for thousands of
independent physical producers, but it's a service to provision, pay for,
and explain the failure modes of, and the challenge's own ingestion
requirement — don't block, don't lock up — is achievable in-process as long
as the hot path stays O(1) per update and never awaits I/O synchronously.
What it costs me: this backend is a single process and a single point of
failure for ingestion. A real fleet deployment would want the broker (or at
minimum a second ingest instance behind a shared store) so a backend restart
doesn't drop in-flight robot connections. I say more about this in "what I'd
build next."

**Two separate sockets (`/ingest`, `/stream`) instead of one shared
channel.** Producers and consumers have different failure profiles and very
different message shapes (per-tick raw updates in, batched snapshots out).
Splitting them means the dashboard's broadcast cadence
(`BROADCAST_INTERVAL_MS`) is fully decoupled from the robots' report cadence
(`UPDATE_INTERVAL_MS`) — a burst of ingestion never turns into a burst of
browser-side work. Cost: two connections to manage and reconnect instead of
one, and a REST fallback (`/api/robots`) I had to keep in sync with the
socket payload shape by hand.

**REST + websocket, and I made them agree by construction.** `/api/robots`
and the `snapshot`/`update` websocket messages both call
`state.snapshot()` — there's exactly one function that turns internal state
into wire format, so there's no way for the two surfaces to drift apart
silently.

**In-memory state, not a database on the read path.** The backend's source
of truth is a `Map`, not SQLite. History persistence (the stretch goal) is a
side effect, written in throttled batches off the hot path, never read from
to answer `/api/robots` or `/stream`. Cost: state is not durable across a
backend restart — a restarted backend is empty until robots reconnect and
report again (typically one `UPDATE_INTERVAL_MS` later).

## 2. Where it degrades, with numbers I actually measured

All numbers below are from running `server.js` + `simulator.js` together on
the machine I built this on (shared cloud VM, 2 vCPU class, Node 22), using
the `/api/config` live knob to ramp fleet size without restarting anything.
Your numbers will differ by hardware; the *shape* of the degradation curve is
the point.

| Fleet size | Update interval | Backend CPU | Backend RSS | `/api/robots` payload | Per-client broadcast frame |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,000 ms | ~2.3% | ~70 MB | 166 KB | ~166 KB / 500 ms |
| 5,000 | 1,000 ms | ~2.7% | ~100 MB | 844 KB | ~844 KB / 500 ms |
| 20,000 | 1,000 ms | ~11.5% | ~144 MB | 3.39 MB | ~3.31 MB every ~460–540 ms |

**What breaks first: per-client bandwidth, not backend CPU.** At 20,000
robots, every connected dashboard is receiving roughly 3.3 MB twice a
second — about 6–7 MB/s per open browser tab. Backend CPU at that size was
still under 12% on my test machine; the ingest path (an O(1) Map write per
update) never showed up as a bottleneck at any size I tested. The actual
ceiling is: how many browser tabs can your network and their networks
sustain at that per-tick payload size, and how long does `JSON.stringify`
of a 20k-element array take relative to `BROADCAST_INTERVAL_MS` (it was
still comfortably under the 500 ms budget at 20k, but it's the term that
grows fastest as fleet size grows further).

**What I'd tune first as it keeps growing:** send diffs instead of full
snapshots on every broadcast tick (only robots that changed since the last
tick), and/or move from JSON to a compact binary frame (typed arrays for
x/y/battery, a status enum byte). Both directly attack the thing that's
actually growing — payload size — rather than the thing that wasn't the
bottleneck in my tests (CPU).

**The dashboard side degrades differently.** The table is virtualized (only
visible rows are ever in the DOM), so table rendering stayed flat regardless
of fleet size in my testing. The canvas map draws one circle per robot per
redraw; at 20,000 points the map is legible as a density picture but
individual robots become hard to click precisely — this is a real UX
degradation, not just a performance one, and I did not fully solve it (see
"what I cut").

**Live reconfiguration works under load.** I ramped a running system from
1,000 → 5,000 → 20,000 robots via `POST /api/config` with no restart of
either process; the simulator picked up each change within one poll
interval (≤4s) and the backend absorbed the new fleet size without a hiccup
in `/api/health`.

## 3. What I cut, and what I'd build next

**Cut:**
- A real message broker for ingestion (see tradeoffs above) — in-process
  `Map` + websocket instead.
- Delta/diff broadcasting — every tick sends a full snapshot. Simple and
  correct (never drifts), but it's the first thing I'd change for very
  large fleets per the numbers above.
- Map-level clustering/decimation at extreme fleet sizes — past a few
  thousand robots the map would benefit from grouping nearby robots into a
  density marker instead of drawing every dot, the way map UIs cluster
  pins. I only got as far as making sure it doesn't crash or freeze at
  20,000; it's not yet a *good* experience at that size.
- Horizontal scaling of the backend itself (multiple instances sharing
  state via Redis/a broker) — out of scope for a single free-tier deploy,
  but the first real bottleneck past what I measured.
- Authenticated multi-operator access — right now there's one shared admin
  token, not per-user accounts or audit logging of who changed what.

**What I'd build next, in order:** (1) diff-based broadcast frames, since
that's the measured bottleneck; (2) move history persistence off SQLite/WAL
onto something that survives a redeploy without a mounted disk (managed
Postgres is the obvious swap, and `db.js` is already the only file that
would need to change); (3) map clustering for very large fleets; (4) a
second backend instance behind a shared store, so ingestion survives a
single-process restart.
