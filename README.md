# Peppermint Fleet Dashboard

Live URLs — **fill these in after you deploy** (see "Deploying" below); the
challenge is graded on the live product first:

- Dashboard: `https://<your-deploy>.onrender.com/`
- Backend surface it consumes: same host, `wss://<your-deploy>.onrender.com/stream`
  (websocket), plus REST at `/api/*`

> This copy was assembled by Claude (Anthropic) from the challenge PDF and
> data files, end to end: architecture, backend, simulator, frontend, tests,
> and these docs. See "AI delegation" at the bottom — read it, then treat
> everything above as a first draft you're responsible for, not a finished
> submission. You need to actually run it, deploy it yourself, and be able to
> defend every design choice below in your own words.

## What this is

- `simulator.js` — a standalone process that invents a fleet of robots,
  moves them continuously around the site in `public/layout.png`, and
  publishes their telemetry to the backend over a websocket.
- `server.js` (+ `state.js`, `db.js`, `backpressure.js`) — the backend.
  Ingests robot updates on `/ingest`, keeps current fleet state in memory,
  and serves it to dashboards over `/stream` (websocket) and `/api/*` (REST).
- `public/` — the operator dashboard: static HTML/CSS/vanilla JS, canvas-based
  map and trend chart, no build step.

## Run it locally (Linux)

```bash
npm install
cp .env.example .env        # edit ADMIN_TOKEN at minimum
npm run dev                 # runs backend + simulator together (needs `concurrently`, already a devDependency)
```

Open `http://localhost:8080`. Or run the two processes yourself in separate
terminals if you'd rather watch their logs separately:

```bash
node server.js
node simulator.js
```

Run the tests:

```bash
npm test
```

## Configuration knobs (env vars, no code changes)

All defined in `config.js`, documented in `.env.example`. The two the
challenge calls out specifically:

- `FLEET_SIZE` — number of simulated robots (roster in `data/robots.json` is
  used first, then synthetic robots are generated beyond that).
- `UPDATE_INTERVAL_MS` — how often each robot reports.
- `PAYLOAD_PADDING_BYTES` — pads each robot record with filler so you can
  stress-test larger payload sizes without changing the schema.

Everything else (`BROADCAST_INTERVAL_MS`, `MAX_CLIENT_BUFFERED_BYTES`,
`STALE_AFTER_MS`, history settings, site dimensions) is in `.env.example`
with a one-line comment each.

## Live controls (no redeploy)

The deployed backend exposes `GET/POST /api/config`. The simulator polls
`GET /api/config` every 4 seconds and adapts `fleetSize`, `updateIntervalMs`,
and `payloadPaddingBytes` live. `POST /api/config` is protected by a bearer
token: send header `x-admin-token: <ADMIN_TOKEN>`.

You don't need curl for this — the dashboard has an **Admin** button (top
right) that opens a small panel with the same three fields and a token box.
Paste your `ADMIN_TOKEN`, change a value, hit **Apply live**; the simulator
picks it up within ~4 seconds, no restart.

```bash
curl -X POST https://<your-deploy>/api/config \
  -H "Content-Type: application/json" \
  -H "x-admin-token: <ADMIN_TOKEN>" \
  -d '{"fleetSize": 2000, "updateIntervalMs": 1000}'
```

Set a real `ADMIN_TOKEN` before you deploy — the default in `.env.example`
is only for local dev.

## Deploying

Two small always-on processes (backend, simulator) that need to talk to each
other, plus a static dashboard the backend already serves — this fits a
single free-tier host cleanly. Two options are wired up:

**Render (recommended, free tier):** push this repo, then Render → New →
Blueprint → point it at the repo. `render.yaml` provisions the backend as a
web service (with a small persistent disk for the history DB) and the
simulator as a background worker. After the first deploy, set the
simulator's `BACKEND_INGEST_URL` env var by hand to
`wss://<backend-service>.onrender.com/ingest` and `BACKEND_HTTP_URL` to
`https://<backend-service>.onrender.com` (Render's `fromService` only gives a
bare host, not a scheme — see the comment in `render.yaml`). Free tier sleeps
after 15 minutes idle; the first request after that has a several-second
cold start.

**Docker / any VM (Railway, Fly.io, a droplet, etc.):**

```bash
docker compose up --build
```

Runs backend + simulator as two containers on one network; see
`docker-compose.yml`.

## AI delegation

Built with Claude (Anthropic), conversationally, from the challenge PDF and
data files. Claude wrote essentially all of the first-draft code, tests, and
these three docs, and ran the load tests reported in `FINDINGS.md` inside its
own sandbox. 
