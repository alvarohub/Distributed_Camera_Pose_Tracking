// ── Collector UI ─────────────────────────────────────────────────────────────
// Connects to the hub as a "collector", builds one tile per tracker, renders
// raw video + skeleton overlay, and sends commands back to individual trackers.

const PERSON_COLORS = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A29BFE', '#FD79A8', '#00B894'];

// Hub WS URL: same host as this page, port 9000 (override with ?hub=ws://host:port)
const params = new URLSearchParams(location.search);
const HUB_URL = params.get('hub') || `ws://${location.hostname}:9000`;

const grid = document.getElementById('grid');
const emptyHint = document.getElementById('empty-hint');
const hubStatus = document.getElementById('hub-status');
const tileTemplate = document.getElementById('tile-template');
const globalRaw = document.getElementById('global-raw');
const globalSkeleton = document.getElementById('global-skeleton');

let ws = null;

// tracker_id -> tile state
const tiles = new Map();

// ── Tile management ────────────────────────────────────────────────────────
function ensureTile(trackerId) {
  if (tiles.has(trackerId)) return tiles.get(trackerId);

  const node = tileTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector('.tile-id').textContent = trackerId;

  const canvas = node.querySelector('.tile-canvas');
  const state = {
    node,
    canvas,
    ctx: canvas.getContext('2d'),
    rawImg: new Image(),
    rawReady: false,
    connections: [],
    resolution: { width: 640, height: 480 },
    lastFrame: null,
    lastSeen: performance.now(),
    logging: false,
  };

  // raw image loads asynchronously from incoming JPEG data URLs
  state.rawImg.onload = () => {
    state.rawReady = true;
  };

  // ── Per-tile controls ──
  const modelSel = node.querySelector('.ctl-model');
  modelSel.addEventListener('change', () => {
    sendCommand(trackerId, 'set_model', { model: modelSel.value });
  });

  const confSlider = node.querySelector('.ctl-conf');
  const confVal = node.querySelector('.ctl-conf-val');
  confSlider.addEventListener('input', () => {
    confVal.textContent = parseFloat(confSlider.value).toFixed(2);
    sendCommand(trackerId, 'set_confidence', { confidence: parseFloat(confSlider.value) });
  });

  const skelCb = node.querySelector('.ctl-skel');
  skelCb.addEventListener('change', () => {
    sendCommand(trackerId, skelCb.checked ? 'start_skeleton' : 'stop_skeleton', {});
  });

  const rawCb = node.querySelector('.ctl-raw');
  rawCb.addEventListener('change', () => {
    sendCommand(trackerId, rawCb.checked ? 'start_video' : 'stop_video', {});
  });

  const logBtn = node.querySelector('.ctl-log');
  logBtn.addEventListener('click', () => {
    const next = !state.logging;
    sendCommand(trackerId, next ? 'start_logging' : 'stop_logging', {
      session_label: `session-${Date.now()}`,
    });
  });

  // ── Persist / revert config ──
  const configInfo = node.querySelector('.ctl-config-info');
  state.configInfo = configInfo;
  const saveBtn = node.querySelector('.ctl-save');
  saveBtn.addEventListener('click', () => {
    configInfo.textContent = 'saving…';
    sendCommand(trackerId, 'save_defaults', {});
  });
  const resetBtn = node.querySelector('.ctl-reset');
  resetBtn.addEventListener('click', () => {
    configInfo.textContent = 'resetting…';
    sendCommand(trackerId, 'reset_to_defaults', {});
  });

  tiles.set(trackerId, state);
  grid.appendChild(node);
  emptyHint.hidden = true;
  return state;
}

function removeTile(trackerId) {
  const state = tiles.get(trackerId);
  if (!state) return;
  state.node.remove();
  tiles.delete(trackerId);
  if (tiles.size === 0) emptyHint.hidden = false;
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderTile(state) {
  const { ctx, canvas } = state;
  const showRaw = globalRaw.checked;
  const showSkel = globalSkeleton.checked;

  // Resize canvas to match source resolution if needed
  const { width, height } = state.resolution;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // Background: raw frame or black
  if (showRaw && state.rawReady) {
    ctx.drawImage(state.rawImg, 0, 0, width, height);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }

  const frame = state.lastFrame;
  if (showSkel && frame && frame.people) {
    const minConf = 0.3;
    for (let p = 0; p < frame.people.length; p++) {
      const kps = frame.people[p].keypoints;
      const color = PERSON_COLORS[p % PERSON_COLORS.length];

      // skeleton
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      for (const [i, j] of state.connections) {
        const a = kps[i];
        const b = kps[j];
        if (!a || !b || a.score < minConf || b.score < minConf) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // keypoints
      for (const kp of kps) {
        if (kp.score < minConf) continue;
        const r = kp.z ? Math.max(2, Math.min(8, 5 - kp.z * 10)) : 5;
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

function renderLoop() {
  const now = performance.now();
  for (const [trackerId, state] of tiles) {
    renderTile(state);
    // mark stale if no data for >2s
    const conn = state.node.querySelector('.tile-conn');
    conn.classList.toggle('stale', now - state.lastSeen > 2000);
  }
  requestAnimationFrame(renderLoop);
}

// ── Incoming messages ──────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'roster':
      for (const tid of msg.trackers) ensureTile(tid);
      break;

    case 'server_shutdown':
      shuttingDown = true;
      showShutdownOverlay();
      break;

    case 'hello':
      if (msg.role === 'tracker') ensureTile(msg.tracker_id);
      break;

    case 'bye':
      removeTile(msg.tracker_id);
      break;

    case 'skeleton_frame': {
      const state = ensureTile(msg.tracker_id);
      state.lastFrame = msg;
      state.connections = msg.connections || state.connections;
      if (msg.resolution) state.resolution = msg.resolution;
      state.lastSeen = performance.now();
      break;
    }

    case 'video_frame': {
      const state = ensureTile(msg.tracker_id);
      state.rawImg.src = msg.jpeg;
      state.lastSeen = performance.now();
      break;
    }

    case 'status': {
      const state = ensureTile(msg.tracker_id);
      const stats = state.node.querySelector('.tile-stats');
      stats.textContent = `${msg.fps ?? '—'} fps · ${msg.people_count ?? 0} people · ${msg.model ?? ''}`;
      // sync logging button
      if (typeof msg.logging === 'boolean' && msg.logging !== state.logging) {
        state.logging = msg.logging;
        const logBtn = state.node.querySelector('.ctl-log');
        const rec = state.node.querySelector('.tile-rec');
        logBtn.classList.toggle('active', state.logging);
        logBtn.textContent = state.logging ? '■ Stop' : '● Log';
        rec.hidden = !state.logging;
      }
      break;
    }

    case 'config': {
      // Tracker reported its current effective config — reflect it in the tile.
      const state = ensureTile(msg.tracker_id);
      const cfg = msg.config || {};
      if (cfg.model) {
        const modelSel = state.node.querySelector('.ctl-model');
        if (modelSel) modelSel.value = cfg.model;
      }
      if (cfg.confidence != null) {
        const confSlider = state.node.querySelector('.ctl-conf');
        const confVal = state.node.querySelector('.ctl-conf-val');
        if (confSlider) confSlider.value = cfg.confidence;
        if (confVal) confVal.textContent = parseFloat(cfg.confidence).toFixed(2);
      }
      if (cfg.streamSkeleton != null) {
        const skelCb = state.node.querySelector('.ctl-skel');
        if (skelCb) skelCb.checked = !!cfg.streamSkeleton;
      }
      if (cfg.streamRaw != null) {
        const rawCb = state.node.querySelector('.ctl-raw');
        if (rawCb) rawCb.checked = !!cfg.streamRaw;
      }
      if (state.configInfo) {
        state.configInfo.textContent = `cam: ${cfg.camera ?? '—'}`;
      }
      break;
    }

    case 'ack': {
      // Surface save/reset acknowledgements in the tile's config info line
      const state = tiles.get(msg.tracker_id);
      if (state && state.configInfo && msg.details) {
        state.configInfo.textContent = msg.ok ? msg.details : `error: ${msg.details}`;
      }
      break;
    }
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────
function sendCommand(trackerId, command, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'command',
      request_id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      target: { tracker_id: trackerId },
      command,
      args: args || {},
    }),
  );
}

function broadcastCommand(command, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'command',
      request_id: `req-${Date.now()}`,
      target: { tracker_id: null }, // null = all trackers
      command,
      args: args || {},
    }),
  );
}

document.getElementById('broadcast-log-start').addEventListener('click', () => {
  broadcastCommand('start_logging', { session_label: `session-${Date.now()}` });
});
document.getElementById('broadcast-log-stop').addEventListener('click', () => {
  broadcastCommand('stop_logging', {});
});

// ── Shutdown ─────────────────────────────────────────────────────────────────
// Stops the hub + tracker servers from the UI so you never have to hunt down
// stray Python processes in a terminal. The hub only honors this over loopback.
let shuttingDown = false;

function showShutdownOverlay() {
  const overlay = document.getElementById('shutdown-overlay');
  if (overlay) overlay.hidden = false;
}

document.getElementById('shutdown-servers').addEventListener('click', () => {
  if (!confirm('Stop the hub and tracker servers? This ends the demo for everyone.')) return;
  shuttingDown = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'shutdown' }));
  }
  // The hub closes right after; show the overlay immediately for feedback.
  showShutdownOverlay();
});

// ── Connection ───────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(HUB_URL);

  ws.onopen = () => {
    hubStatus.textContent = 'Connected to hub ✓';
    hubStatus.className = 'status ready';
    ws.send(JSON.stringify({ type: 'hello', role: 'collector' }));
  };

  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    if (shuttingDown) {
      hubStatus.textContent = 'Servers stopped';
      hubStatus.className = 'status';
      showShutdownOverlay();
      return; // intentional — do not reconnect
    }
    hubStatus.textContent = 'Hub disconnected — reconnecting…';
    hubStatus.className = 'status error';
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
requestAnimationFrame(renderLoop);
