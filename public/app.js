(() => {
  const STATUS_COLORS = {
    idle: '#64748b', active: '#34d399', on_mission: '#38bdf8', charging: '#facc15',
    blocked: '#fb923c', error: '#f87171', maintenance: '#a78bfa', offline: '#475569',
  };
  const STATUSES = Object.keys(STATUS_COLORS);
  const SITE = { width: 900, height: 560 };
  const SHELVES = [
    { x0: 150, y0: 80, x1: 350, y1: 140 },
    { x0: 150, y0: 220, x1: 350, y1: 280 },
    { x0: 150, y0: 360, x1: 350, y1: 420 },
    { x0: 500, y0: 60, x1: 560, y1: 460 },
    { x0: 650, y0: 150, x1: 850, y1: 200 },
    { x0: 650, y0: 340, x1: 850, y1: 390 },
  ];

  // ---- state -----------------------------------------------------------
  let robots = new Map();      // robot_id -> latest record
  let trendBuckets = [];       // {t, counts, total}
  let bucketMs = 5000;
  let selectedId = null;
  let searchTerm = '';
  let attentionOnly = false;
  let windowMs = 300000; // trend chart window, 0 = all

  // ---- websocket with reconnect ----------------------------------------
  const connStatusEl = document.getElementById('connStatus');
  let socket = null;
  let reconnectDelay = 1000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/stream`);
    socket.onopen = () => {
      connStatusEl.textContent = 'live';
      connStatusEl.className = 'conn-status live';
      reconnectDelay = 1000;
    };
    socket.onclose = () => {
      connStatusEl.textContent = 'reconnecting…';
      connStatusEl.className = 'conn-status down';
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        robots = new Map(msg.robots.map((r) => [r.robot_id, r]));
        trendBuckets = msg.trend || [];
        bucketMs = msg.bucket_ms || bucketMs;
      } else if (msg.type === 'update') {
        robots = new Map(msg.robots.map((r) => [r.robot_id, r]));
        if (msg.trend_tail && msg.trend_tail.length) {
          const lastT = trendBuckets.length ? trendBuckets[trendBuckets.length - 1].t : -1;
          for (const b of msg.trend_tail) {
            if (b.t === lastT) trendBuckets[trendBuckets.length - 1] = b;
            else if (b.t > lastT) trendBuckets.push(b);
          }
        }
      }
      render();
    };
  }
  connect();

  // Fallback snapshot on first paint in case the socket is slow to open.
  fetch('/api/robots').then((r) => r.json()).then((d) => {
    if (robots.size === 0) { robots = new Map(d.robots.map((r) => [r.robot_id, r])); render(); }
  }).catch(() => {});
  fetch('/api/trend').then((r) => r.json()).then((d) => {
    if (trendBuckets.length === 0) { trendBuckets = d.buckets; bucketMs = d.bucket_ms; render(); }
  }).catch(() => {});

  // ---- legend ------------------------------------------------------------
  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = STATUSES.map((s) => `<span><i style="background:${STATUS_COLORS[s]}"></i>${s}</span>`).join('');

  // ---- site canvas ---------------------------------------------------------
  const siteCanvas = document.getElementById('siteCanvas');
  const sctx = siteCanvas.getContext('2d');

  function drawSite() {
    sctx.clearRect(0, 0, SITE.width, SITE.height);
    sctx.fillStyle = '#0b0d13';
    sctx.fillRect(0, 0, SITE.width, SITE.height);
    sctx.strokeStyle = '#1b2030';
    for (let gx = 0; gx <= SITE.width; gx += 60) { sctx.beginPath(); sctx.moveTo(gx, 0); sctx.lineTo(gx, SITE.height); sctx.stroke(); }
    for (let gy = 0; gy <= SITE.height; gy += 60) { sctx.beginPath(); sctx.moveTo(0, gy); sctx.lineTo(SITE.width, gy); sctx.stroke(); }
    sctx.fillStyle = '#262b38';
    for (const s of SHELVES) sctx.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);

    const list = Array.from(robots.values());
    for (const r of list) {
      const color = STATUS_COLORS[r.status] || '#94a3b8';
      sctx.globalAlpha = r.stale ? 0.35 : 1;
      sctx.beginPath();
      sctx.arc(r.x, r.y, r.robot_id === selectedId ? 6 : 3.2, 0, Math.PI * 2);
      sctx.fillStyle = color;
      sctx.fill();
      if (r.needs_attention) {
        sctx.strokeStyle = '#f87171';
        sctx.lineWidth = 1.4;
        sctx.beginPath();
        sctx.arc(r.x, r.y, 6.5, 0, Math.PI * 2);
        sctx.stroke();
      }
      if (r.robot_id === selectedId) {
        sctx.strokeStyle = '#e7e9ee';
        sctx.lineWidth = 1.5;
        sctx.beginPath();
        sctx.arc(r.x, r.y, 9, 0, Math.PI * 2);
        sctx.stroke();
      }
    }
    sctx.globalAlpha = 1;
  }

  siteCanvas.addEventListener('click', (ev) => {
    const rect = siteCanvas.getBoundingClientRect();
    const scaleX = SITE.width / rect.width;
    const scaleY = SITE.height / rect.height;
    const cx = (ev.clientX - rect.left) * scaleX;
    const cy = (ev.clientY - rect.top) * scaleY;
    let closest = null, bestDist = 14; // click tolerance in site units
    for (const r of robots.values()) {
      const d = Math.hypot(r.x - cx, r.y - cy);
      if (d < bestDist) { bestDist = d; closest = r.robot_id; }
    }
    if (closest) { selectedId = closest; render(); }
  });

  // ---- trend chart ---------------------------------------------------------
  const trendCanvas = document.getElementById('trendCanvas');
  const tctx = trendCanvas.getContext('2d');
  const STACK_STATUSES = ['active', 'on_mission', 'idle', 'charging', 'blocked', 'error', 'maintenance', 'offline'];

  document.getElementById('windowControls').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-window]');
    if (!btn) return;
    windowMs = Number(btn.dataset.window);
    document.querySelectorAll('#windowControls button').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });

  function drawTrend() {
    const W = trendCanvas.width, H = trendCanvas.height;
    tctx.clearRect(0, 0, W, H);
    tctx.fillStyle = '#0b0d13';
    tctx.fillRect(0, 0, W, H);

    let buckets = trendBuckets;
    if (windowMs > 0) {
      const cutoff = Date.now() - windowMs;
      buckets = buckets.filter((b) => b.t >= cutoff);
    }
    if (buckets.length < 2) {
      tctx.fillStyle = '#8b93a7';
      tctx.font = '12px sans-serif';
      tctx.fillText('Collecting data…', 12, H / 2);
      return;
    }

    const padL = 34, padR = 8, padT = 8, padB = 18;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = buckets.length;

    // y axis (0-1 fraction)
    tctx.strokeStyle = '#1b2030';
    tctx.fillStyle = '#8b93a7';
    tctx.font = '10px sans-serif';
    for (let f = 0; f <= 1; f += 0.25) {
      const y = padT + plotH * (1 - f);
      tctx.beginPath(); tctx.moveTo(padL, y); tctx.lineTo(W - padR, y); tctx.stroke();
      tctx.fillText(`${Math.round(f * 100)}%`, 4, y + 3);
    }

    // stacked area of status fractions, per bucket
    const xFor = (i) => padL + (i / (n - 1)) * plotW;
    let cumulative = new Array(n).fill(0);
    for (const status of STACK_STATUSES) {
      tctx.beginPath();
      for (let i = 0; i < n; i++) {
        const b = buckets[i];
        const frac = b.total ? (b.counts[status] || 0) / b.total : 0;
        const yTop = padT + plotH * (1 - (cumulative[i] + frac));
        if (i === 0) tctx.moveTo(xFor(i), yTop); else tctx.lineTo(xFor(i), yTop);
      }
      for (let i = n - 1; i >= 0; i--) {
        const yBase = padT + plotH * (1 - cumulative[i]);
        tctx.lineTo(xFor(i), yBase);
      }
      tctx.closePath();
      tctx.fillStyle = STATUS_COLORS[status];
      tctx.globalAlpha = 0.85;
      tctx.fill();
      tctx.globalAlpha = 1;
      for (let i = 0; i < n; i++) {
        const b = buckets[i];
        const frac = b.total ? (b.counts[status] || 0) / b.total : 0;
        cumulative[i] += frac;
      }
    }

    // x axis time labels (first / mid / last)
    tctx.fillStyle = '#8b93a7';
    const fmt = (t) => new Date(t).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
    tctx.fillText(fmt(buckets[0].t), padL, H - 4);
    tctx.fillText(fmt(buckets[n - 1].t), W - padR - 46, H - 4);
  }

  // ---- table (virtualized) --------------------------------------------------
  const tableWrap = document.getElementById('tableWrap');
  const tableBody = document.getElementById('tableBody');
  const ROW_H = 26;
  let spacer = null;

  document.getElementById('searchBox').addEventListener('input', (ev) => { searchTerm = ev.target.value.toLowerCase(); render(); });
  document.getElementById('attentionOnly').addEventListener('change', (ev) => { attentionOnly = ev.target.checked; render(); });
  tableWrap.addEventListener('scroll', () => renderTableWindow());

  let filteredList = [];

  function computeFilteredList() {
    let list = Array.from(robots.values());
    if (attentionOnly) list = list.filter((r) => r.needs_attention);
    if (searchTerm) {
      list = list.filter((r) => r.robot_id.toLowerCase().includes(searchTerm)
        || (r.robot_type || '').toLowerCase().includes(searchTerm)
        || (r.status || '').toLowerCase().includes(searchTerm));
    }
    list.sort((a, b) => (b.needs_attention - a.needs_attention) || a.robot_id.localeCompare(b.robot_id, undefined, { numeric: true }));
    filteredList = list;
  }

  function ageLabel(receivedAt) {
    const s = Math.max(0, Math.round((Date.now() - receivedAt) / 1000));
    return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  }

  function renderTableWindow() {
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.style.position = 'relative';
      tableBody.style.position = 'relative';
    }
    const total = filteredList.length;
    tableBody.style.height = `${total * ROW_H}px`;
    const scrollTop = tableWrap.scrollTop;
    const viewH = tableWrap.clientHeight || 360;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 5);

    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
      const r = filteredList[i];
      const color = STATUS_COLORS[r.status] || '#94a3b8';
      html += `<div class="row${r.robot_id === selectedId ? ' selected' : ''}${r.needs_attention ? ' attention' : ''}${r.stale ? ' stale' : ''}"
        style="position:absolute;top:${i * ROW_H}px;left:0;right:0;height:${ROW_H}px"
        data-id="${r.robot_id}">
        <span>${r.robot_id}</span>
        <span>${r.robot_type || '–'}</span>
        <span><span class="status-dot" style="background:${color}"></span>${r.status}</span>
        <span>${r.battery != null ? r.battery.toFixed(0) + '%' : '–'}</span>
        <span>${r.x?.toFixed?.(0)}, ${r.y?.toFixed?.(0)}</span>
        <span>${ageLabel(r.received_at)}</span>
      </div>`;
    }
    tableBody.innerHTML = html;
  }

  tableBody.addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    selectedId = row.dataset.id;
    render();
  });

  // ---- detail panel -----------------------------------------------------
  const detailPanel = document.getElementById('detailPanel');

  function renderDetail() {
    const r = selectedId ? robots.get(selectedId) : null;
    if (!r) {
      detailPanel.innerHTML = '<h2>Select a robot</h2><p class="hint">Click any row, or a dot on the map, to inspect a robot here.</p>';
      return;
    }
    const color = STATUS_COLORS[r.status] || '#94a3b8';
    detailPanel.innerHTML = `
      <h2>${r.robot_id}</h2>
      ${r.needs_attention ? '<div class="attention-banner">Needs attention</div>' : ''}
      <div class="detail-grid">
        <div class="k">Type</div><div>${r.robot_type || '–'}</div>
        <div class="k">Status</div><div><span class="status-dot" style="background:${color}"></span>${r.status}</div>
        <div class="k">Position</div><div>${r.x?.toFixed?.(1)}, ${r.y?.toFixed?.(1)}</div>
        <div class="k">Sim time t</div><div>${r.t ?? '–'}s</div>
        <div class="k">Last update</div><div>${ageLabel(r.received_at)}${r.stale ? ' (stale)' : ''}</div>
      </div>
      <div class="k" style="margin-top:10px">Battery ${r.battery != null ? r.battery.toFixed(1) + '%' : '–'}</div>
      <div class="battery-bar"><div style="width:${r.battery || 0}%;background:${r.battery <= 15 ? 'var(--danger)' : r.battery <= 40 ? 'var(--warn)' : 'var(--active)'}"></div></div>
    `;
  }

  // ---- admin panel -----------------------------------------------------
  const adminToggle = document.getElementById('adminToggle');
  const adminPanel = document.getElementById('adminPanel');
  adminToggle.addEventListener('click', () => { adminPanel.hidden = !adminPanel.hidden; });

  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    document.getElementById('cfgFleetSize').value = cfg.fleetSize;
    document.getElementById('cfgInterval').value = cfg.updateIntervalMs;
    document.getElementById('cfgPadding').value = cfg.payloadPaddingBytes;
  }).catch(() => {});

  document.getElementById('cfgApply').addEventListener('click', async () => {
    const token = document.getElementById('adminToken').value;
    const msgEl = document.getElementById('adminMsg');
    const body = {
      fleetSize: Number(document.getElementById('cfgFleetSize').value),
      updateIntervalMs: Number(document.getElementById('cfgInterval').value),
      payloadPaddingBytes: Number(document.getElementById('cfgPadding').value),
    };
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      msgEl.textContent = res.ok ? 'Applied. The simulator picks this up within ~4s.' : (data.error || 'Failed');
      msgEl.style.color = res.ok ? 'var(--active)' : 'var(--danger)';
    } catch {
      msgEl.textContent = 'Request failed';
      msgEl.style.color = 'var(--danger)';
    }
  });

  // ---- render loop -----------------------------------------------------
  const fleetCountEl = document.getElementById('fleetCount');
  function render() {
    fleetCountEl.textContent = `${robots.size} robots`;
    drawSite();
    drawTrend();
    computeFilteredList();
    renderTableWindow();
    renderDetail();
  }
  render();
})();
