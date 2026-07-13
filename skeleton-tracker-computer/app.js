// ── Config ──────────────────────────────────────────────────────────────────
// Resolution defaults; the per-tracker config file may override them.
let VIDEO_WIDTH = 640;
let VIDEO_HEIGHT = 480;

// This tracker = one process owning one camera. Its identity comes from the URL
// (?id=cam-left), and everything else comes from a per-tracker CONFIG FILE
// served alongside this page: trackers/<id>.json. URL params override the file
// for quick experiments; collector commands override at runtime.
//   index.html?id=cam-left   →   fetch ./trackers/cam-left.json
const urlParams = new URLSearchParams(location.search);
const TRACKER_ID = urlParams.get('id') || `tracker-${Math.random().toString(36).slice(2, 7)}`;

// Source of truth for hardware-specific settings. Fields:
//   camera       camera label substring | exact deviceId | numeric index
//   resolution   { width, height }
//   model        'movenet' | 'mediapipe' | 'yolov8' | 'yolo11'
//   confidence   0..1 minimum keypoint score
//   mirror        flip horizontally (selfie view)
//   streamSkeleton send computed keypoints/skeleton frames to the collector
//   streamRaw     send raw JPEG frames to the collector
//   collector     hub WebSocket URL
//   calibration   (reserved, used later) lens undistortion / calibration file
const CONFIG = {
  tracker_id: TRACKER_ID,
  camera: null,
  resolution: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
  model: 'movenet',
  confidence: 0.3,
  mirror: true,
  streamSkeleton: true,
  streamRaw: true,
  collector: `ws://${location.hostname}:9000`,
  calibration: null,
};

// Raw-video stream throttling (skeleton always streams at full rate; JPEG is heavy)
const VIDEO_STREAM_FPS = 12;
const VIDEO_JPEG_QUALITY = 0.5;

async function loadConfig() {
  // 1) Per-tracker config file (served next to this page).
  try {
    const res = await fetch(`./trackers/${TRACKER_ID}.json`, { cache: 'no-store' });
    if (res.ok) {
      const fileCfg = await res.json();
      Object.assign(CONFIG, fileCfg);
      if (fileCfg.resolution) CONFIG.resolution = { ...CONFIG.resolution, ...fileCfg.resolution };
      console.log(`Loaded config trackers/${TRACKER_ID}.json`, CONFIG);
    } else {
      console.warn(`No config file trackers/${TRACKER_ID}.json (HTTP ${res.status}); using defaults + URL params.`);
    }
  } catch (err) {
    console.warn('Config fetch failed; using defaults + URL params.', err);
  }

  // 2) URL params override the file.
  if (urlParams.has('camera')) CONFIG.camera = urlParams.get('camera');
  if (urlParams.has('collector')) CONFIG.collector = urlParams.get('collector');
  if (urlParams.has('model')) CONFIG.model = urlParams.get('model');

  // 3) Apply resolution to module dims + canvases.
  VIDEO_WIDTH = CONFIG.resolution.width;
  VIDEO_HEIGHT = CONFIG.resolution.height;
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  rawCanvas.width = VIDEO_WIDTH;
  rawCanvas.height = VIDEO_HEIGHT;
}

// Colors for up to 6 tracked people
const PERSON_COLORS = [
  '#FF6B6B', // red
  '#4ECDC4', // teal
  '#FFE66D', // yellow
  '#A29BFE', // lavender
  '#FD79A8', // pink
  '#00B894', // green
];

// ── MoveNet (17 keypoints) ──────────────────────────────────────────────────
const MOVENET_KEYPOINT_NAMES = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
];

const MOVENET_CONNECTIONS = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4], // head
  [5, 6], // shoulders
  [5, 7],
  [7, 9], // left arm
  [6, 8],
  [8, 10], // right arm
  [5, 11],
  [6, 12],
  [11, 12], // torso
  [11, 13],
  [13, 15], // left leg
  [12, 14],
  [14, 16], // right leg
];

// ── MediaPipe BlazePose (33 keypoints, 3D) ──────────────────────────────────
const MEDIAPIPE_KEYPOINT_NAMES = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index',
];

const MEDIAPIPE_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7], // left eye → ear
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8], // right eye → ear
  [9, 10], // mouth
  [11, 12], // shoulders
  [11, 13],
  [13, 15], // left arm
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19], // left hand
  [12, 14],
  [14, 16], // right arm
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20], // right hand
  [11, 23],
  [12, 24],
  [23, 24], // torso
  [23, 25],
  [25, 27], // left leg
  [27, 29],
  [27, 31],
  [29, 31], // left foot
  [24, 26],
  [26, 28], // right leg
  [28, 30],
  [28, 32],
  [30, 32], // right foot
];

// ── YOLO pose (17 COCO keypoints, 2D) ───────────────────────────────────────
const YOLO_INPUT_SIZE = 640;
const YOLO_MAX_POSES = 6;
const YOLO_NMS_IOU = 0.45;
const YOLO_MODELS = {
  yolov8: {
    label: 'YOLOv8n Pose 17pt',
    modelPath: './model-yolo/yolov8n-pose.onnx',
  },
  yolo11: {
    label: 'YOLO11n Pose 17pt',
    modelPath: './model-yolo/yolo11n-pose.onnx',
  },
};

function isYoloModel(model) {
  return Object.prototype.hasOwnProperty.call(YOLO_MODELS, model);
}

function modelLabel(model) {
  if (model === 'movenet') return 'MoveNet 17pt';
  if (model === 'mediapipe') return 'MediaPipe 33pt 3D';
  return YOLO_MODELS[model]?.label || model;
}

// ── Active model state ──────────────────────────────────────────────────────
let activeModel = 'movenet'; // 'movenet' | 'mediapipe' | 'yolov8' | 'yolo11'
let activeConnections = MOVENET_CONNECTIONS;
let running = false;

// ── DOM refs ────────────────────────────────────────────────────────────────
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const hubStatusEl = document.getElementById('hub-status');
const confSlider = document.getElementById('confidence');
const confVal = document.getElementById('conf-val');
const showPointsCb = document.getElementById('show-points');
const showSkeletonCb = document.getElementById('show-skeleton');
const showBboxCb = document.getElementById('show-bbox');
const streamSkeletonCb = document.getElementById('stream-skeleton');
const streamRawCb = document.getElementById('stream-raw');
const modelSelect = document.getElementById('model-select');
const cameraSelect = document.getElementById('camera-select');
const trackerIdLabel = document.getElementById('tracker-id-label');

if (trackerIdLabel) trackerIdLabel.textContent = TRACKER_ID;
document.title = `Tracker — ${TRACKER_ID}`;

canvas.width = VIDEO_WIDTH;
canvas.height = VIDEO_HEIGHT;

// Offscreen canvas for clean (skeleton-free) raw frames sent to the collector
const rawCanvas = document.createElement('canvas');
rawCanvas.width = VIDEO_WIDTH;
rawCanvas.height = VIDEO_HEIGHT;
const rawCtx = rawCanvas.getContext('2d');

confSlider.addEventListener('input', () => {
  confVal.textContent = parseFloat(confSlider.value).toFixed(2);
});

// ── Camera setup ────────────────────────────────────────────────────────────
let currentStream = null;
let selectedDeviceId = null;
let currentCameraLabel = null; // human-readable label of the active camera

// Resolve a camera spec (label substring | exact deviceId | numeric index)
// against the enumerated devices. Label matching is the stable, human-friendly
// option — indexes shift when cameras are plugged/unplugged.
function matchCamera(cams, spec) {
  if (spec == null || spec === '') return null;
  const byId = cams.find((c) => c.deviceId === spec);
  if (byId) return byId.deviceId;
  const idx = Number(spec);
  if (Number.isInteger(idx) && cams[idx]) return cams[idx].deviceId;
  const needle = String(spec).toLowerCase();
  const byLabel = cams.find((c) => c.label && c.label.toLowerCase().includes(needle));
  return byLabel ? byLabel.deviceId : null;
}

async function listCameras() {
  // enumerateDevices only returns labels after permission is granted
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  cameraSelect.innerHTML = '';
  cams.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    cameraSelect.appendChild(opt);
  });

  // Resolve the configured camera (label substring | deviceId | index)
  const matched = matchCamera(cams, CONFIG.camera);
  if (matched) {
    selectedDeviceId = matched;
  } else if (CONFIG.camera) {
    console.warn(`Camera "${CONFIG.camera}" not found; falling back to first camera.`);
  }
  if (!selectedDeviceId && cams.length) selectedDeviceId = cams[0].deviceId;
  if (selectedDeviceId) cameraSelect.value = selectedDeviceId;
  // Remember the human-readable label of the selected camera
  const sel = cams.find((c) => c.deviceId === selectedDeviceId);
  if (sel) currentCameraLabel = sel.label || null;
  return cams;
}

async function setupCamera(deviceId) {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
  }
  const videoConstraints = {
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
  };
  if (deviceId) videoConstraints.deviceId = { exact: deviceId };
  else videoConstraints.facingMode = 'user';

  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });
  currentStream = stream;
  video.srcObject = stream;
  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();
      resolve(video);
    };
  });
}

async function switchCamera(deviceId) {
  selectedDeviceId = deviceId;
  const opt = cameraSelect.selectedOptions[0];
  currentCameraLabel = opt ? opt.textContent : currentCameraLabel;
  statusEl.textContent = 'Switching camera...';
  try {
    await setupCamera(deviceId);
    statusEl.textContent = 'Tracking active ✓';
    statusEl.classList.add('ready');
  } catch (err) {
    statusEl.textContent = `Camera error: ${err.message}`;
    statusEl.classList.add('error');
  }
}

cameraSelect.addEventListener('change', () => switchCamera(cameraSelect.value));

// ── Drawing helpers ─────────────────────────────────────────────────────────
function drawKeypoints(keypoints, color, minConf) {
  for (const kp of keypoints) {
    if (kp.score < minConf) continue;
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, 5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawSkeleton(keypoints, color, minConf) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [i, j] of activeConnections) {
    const a = keypoints[i];
    const b = keypoints[j];
    if (a.score < minConf || b.score < minConf) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawBoundingBox(keypoints, color, minConf) {
  const valid = keypoints.filter((kp) => kp.score >= minConf);
  if (valid.length < 2) return;

  const xs = valid.map((kp) => kp.x);
  const ys = valid.map((kp) => kp.y);
  const pad = 15;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  const w = Math.max(...xs) - x + pad;
  const h = Math.max(...ys) - y + pad;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

function drawPersonLabel(keypoints, idx, color, minConf) {
  // Place label above the nose or highest visible keypoint
  const valid = keypoints.filter((kp) => kp.score >= minConf);
  if (valid.length === 0) return;
  const topKp = valid.reduce((a, b) => (a.y < b.y ? a : b));

  ctx.fillStyle = color;
  ctx.font = 'bold 14px monospace';
  ctx.fillText(`Person ${idx + 1}`, topKp.x - 30, topKp.y - 20);
}

// ── Temporal smoothing (EMA) ────────────────────────────────────────────────
const SMOOTHING_ALPHA = 0.4; // 0 = frozen, 1 = no smoothing
const smoothedPoses = new Map(); // trackId → keypoints[]

function smoothKeypoints(poses) {
  const seen = new Set();
  for (const pose of poses) {
    // Use tracker id if available, fall back to index
    const id = pose.id != null ? pose.id : poses.indexOf(pose);
    seen.add(id);
    const prev = smoothedPoses.get(id);
    if (!prev) {
      smoothedPoses.set(
        id,
        pose.keypoints.map((kp) => ({ ...kp })),
      );
    } else {
      for (let k = 0; k < pose.keypoints.length; k++) {
        const kp = pose.keypoints[k];
        if (kp.score > 0.2) {
          prev[k].x += SMOOTHING_ALPHA * (kp.x - prev[k].x);
          prev[k].y += SMOOTHING_ALPHA * (kp.y - prev[k].y);
          if (kp.z != null) prev[k].z = (prev[k].z || 0) + SMOOTHING_ALPHA * (kp.z - (prev[k].z || 0));
          prev[k].score = kp.score;
          prev[k].name = kp.name;
        }
      }
    }
    pose.keypoints = smoothedPoses.get(id).map((kp) => ({ ...kp }));
  }
  // Remove stale tracks
  for (const id of smoothedPoses.keys()) {
    if (!seen.has(id)) smoothedPoses.delete(id);
  }
}

// ── Hub connection (WebSocket protocol) ─────────────────────────────────────
// Canonical transport: WebSocket + JSON. This tracker registers with the
// collector hub via a `hello`, then streams skeleton (+ optional raw video)
// frames and responds to commands. The skeleton is computed HERE, not at the
// collector — that is what makes the system distributed/scalable.
let ws = null;
let wsConnected = false;
let frameId = 0;
const startTime = Date.now();

// Runtime flags driven by collector commands (seeded from CONFIG in main())
let streamingSkeleton = true; // send computed skeleton frames?
let streamingVideo = true; // send raw JPEG frames?
let logging = false;
let loggingSessionId = null;
let loggingPath = null;
let loggingEntries = 0;
let pendingLogEntries = [];
let logFlushInFlight = false;
const LOG_BATCH_SIZE = 30;

function setHubStatus(text, cls) {
  if (!hubStatusEl) return;
  hubStatusEl.textContent = `Hub: ${text}`;
  hubStatusEl.className = 'hub-status' + (cls ? ' ' + cls : '');
}

function sendHello() {
  if (!wsConnected) return;
  ws.send(
    JSON.stringify({
      type: 'hello',
      role: 'tracker',
      tracker_id: TRACKER_ID,
      model: activeModel,
      resolution: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    }),
  );
}

function currentCameraToken() {
  const label = (currentCameraLabel || '').trim();
  if (label) return label;
  return selectedDeviceId || TRACKER_ID;
}

async function startLoggingSession(sessionLabel) {
  const res = await fetch('./api/log/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracker_id: TRACKER_ID,
      camera: currentCameraToken(),
      session_label: sessionLabel || `session-${Date.now()}`,
    }),
  });
  if (!res.ok) throw new Error(`log start failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok || !body.session_id) throw new Error(body.error || 'log start failed');
  loggingSessionId = body.session_id;
  loggingPath = body.path || null;
  loggingEntries = 0;
}

async function flushLogEntries(force = false) {
  if (!loggingSessionId || logFlushInFlight || pendingLogEntries.length === 0) return;
  if (!force && pendingLogEntries.length < LOG_BATCH_SIZE) return;
  const chunkSize = force ? pendingLogEntries.length : Math.min(LOG_BATCH_SIZE, pendingLogEntries.length);
  const batch = pendingLogEntries.splice(0, chunkSize);
  logFlushInFlight = true;
  try {
    const res = await fetch('./api/log/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracker_id: TRACKER_ID,
        session_id: loggingSessionId,
        entries: batch,
      }),
    });
    if (!res.ok) throw new Error(`log append failed: HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'log append failed');
    loggingEntries = body.entries != null ? body.entries : loggingEntries + batch.length;
  } catch (err) {
    pendingLogEntries = batch.concat(pendingLogEntries);
    console.error('Log append failed:', err);
  } finally {
    logFlushInFlight = false;
  }
}

async function startLogging(sessionLabel) {
  if (!loggingSessionId) {
    await startLoggingSession(sessionLabel);
  }
  logging = true;
  sendStatus();
}

async function pauseLogging() {
  logging = false;
  while (pendingLogEntries.length > 0) {
    await flushLogEntries(true);
    if (logFlushInFlight) break;
  }
  sendStatus();
}

async function saveLogging() {
  if (!loggingSessionId) {
    throw new Error('no active log session');
  }
  await pauseLogging();
  const sessionId = loggingSessionId;
  const res = await fetch('./api/log/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracker_id: TRACKER_ID,
      session_id: sessionId,
    }),
  });
  if (!res.ok) throw new Error(`log save failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'log save failed');
  loggingPath = body.path || loggingPath;
  loggingEntries = body.entries != null ? body.entries : loggingEntries;
  loggingSessionId = null;
  pendingLogEntries = [];
  sendStatus();
  return body;
}

async function discardLogging() {
  if (logging) {
    await pauseLogging();
  }
  if (!loggingSessionId) {
    loggingPath = null;
    loggingEntries = 0;
    pendingLogEntries = [];
    sendStatus();
    return { ok: true };
  }

  const sessionId = loggingSessionId;
  const res = await fetch('./api/log/discard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracker_id: TRACKER_ID,
      session_id: sessionId,
    }),
  });
  if (!res.ok) throw new Error(`log discard failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'log discard failed');

  logging = false;
  loggingSessionId = null;
  loggingPath = null;
  loggingEntries = 0;
  pendingLogEntries = [];
  sendStatus();
  return body;
}

function queueLogEntry(poses) {
  if (!logging || !loggingSessionId) return;
  pendingLogEntries.push({
    ts_unix_ms: Date.now(),
    tracker_id: TRACKER_ID,
    camera: currentCameraToken(),
    frame_id: frameId,
    model: activeModel,
    resolution: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    people: poses.map((pose, i) => ({
      id: pose.id != null ? pose.id : i,
      keypoints: pose.keypoints.map((kp) => ({
        x: Math.round(kp.x * 10) / 10,
        y: Math.round(kp.y * 10) / 10,
        z: Math.round((kp.z || 0) * 1000) / 1000,
        score: Math.round(kp.score * 1000) / 1000,
      })),
    })),
  });
}

function connectWebSocket() {
  setHubStatus('connecting…');
  const socket = new WebSocket(CONFIG.collector);
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    wsConnected = true;
    setHubStatus('connected ✓', 'ready');
    sendHello();
  };
  socket.onmessage = (evt) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.type === 'command') handleCommand(msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    wsConnected = false;
    setHubStatus('disconnected — retrying', 'error');
    setTimeout(connectWebSocket, 2000);
  };
  socket.onerror = () => {
    if (ws === socket) socket.close();
  };
}

// ── Command handling ─────────────────────────────────────────────────────────
function ack(requestId, ok, details) {
  if (!wsConnected || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'ack',
      tracker_id: TRACKER_ID,
      request_id: requestId,
      ok,
      details: details || '',
    }),
  );
}

// ── Config: runtime tweak vs persisted defaults ─────────────────────────────
// The collector/monitor sends commands. Two distinct kinds:
//   • runtime    (set_model/set_confidence/set_config/start|stop_video) — in memory only
//   • persistent (save_defaults writes the file; reset_to_defaults reloads the file)
// The file (trackers/<id>.json) stays authoritative and is what loads next launch.

// Snapshot of the CURRENT effective settings (what "save defaults" would write).
function currentConfig() {
  return {
    tracker_id: TRACKER_ID,
    camera: currentCameraLabel || CONFIG.camera,
    resolution: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    model: activeModel,
    confidence: parseFloat(confSlider.value),
    mirror: CONFIG.mirror,
    streamSkeleton: streamingSkeleton,
    streamRaw: streamingVideo,
    collector: CONFIG.collector,
    calibration: CONFIG.calibration ?? null,
  };
}

// Apply a (partial) config to the running tracker + UI. Does NOT persist.
async function applyConfig(partial) {
  if (!partial || typeof partial !== 'object') return;
  if (partial.confidence != null) {
    confSlider.value = partial.confidence;
    confVal.textContent = parseFloat(partial.confidence).toFixed(2);
    CONFIG.confidence = parseFloat(partial.confidence);
  }
  if (partial.mirror != null) CONFIG.mirror = !!partial.mirror;
  if (partial.streamSkeleton != null) {
    streamingSkeleton = !!partial.streamSkeleton;
    if (streamSkeletonCb) streamSkeletonCb.checked = streamingSkeleton;
  }
  if (partial.streamRaw != null) {
    streamingVideo = !!partial.streamRaw;
    if (streamRawCb) streamRawCb.checked = streamingVideo;
  }
  if (partial.collector) CONFIG.collector = partial.collector;
  if ('calibration' in partial) CONFIG.calibration = partial.calibration;
  if (partial.model && partial.model !== activeModel) {
    if (modelSelect) modelSelect.value = partial.model;
    await switchModel(partial.model);
  }
  if (partial.camera != null && partial.camera !== '') {
    CONFIG.camera = partial.camera;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const dev = matchCamera(cams, partial.camera);
    if (dev && dev !== selectedDeviceId) {
      cameraSelect.value = dev;
      await switchCamera(dev);
    }
  }
}

// Report the current effective config to the collector (answer to get_config).
function sendConfig(requestId) {
  if (!wsConnected || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'config',
      tracker_id: TRACKER_ID,
      request_id: requestId || null,
      config: currentConfig(),
    }),
  );
}

// Persist the current effective config to trackers/<id>.json via the local
// tracker server. Returns the server's JSON response.
async function saveDefaults() {
  const res = await fetch('./api/save-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracker_id: TRACKER_ID, config: currentConfig() }),
  });
  if (!res.ok) throw new Error(`save failed: HTTP ${res.status}`);
  return res.json();
}

// Reload the saved file and re-apply it, discarding runtime tweaks.
async function resetToDefaults() {
  const res = await fetch(`./trackers/${TRACKER_ID}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`no saved config (HTTP ${res.status})`);
  const fileCfg = await res.json();
  await applyConfig(fileCfg);
  return fileCfg;
}

function handleCommand(msg) {
  const { command, args = {}, request_id } = msg;
  switch (command) {
    case 'ping':
      ack(request_id, true, 'pong');
      break;
    case 'get_status':
      sendStatus();
      ack(request_id, true);
      break;
    case 'get_config':
      sendConfig(request_id);
      ack(request_id, true);
      break;
    case 'set_config':
      // Generic runtime tweak (multiple fields at once); not persisted.
      applyConfig(args.config || args)
        .then(() => {
          sendConfig(request_id);
          sendStatus();
          ack(request_id, true, 'applied (runtime)');
        })
        .catch((e) => ack(request_id, false, e.message));
      break;
    case 'save_defaults':
      saveDefaults()
        .then((r) => {
          sendConfig(request_id);
          ack(request_id, true, `saved → ${r.path}`);
        })
        .catch((e) => ack(request_id, false, e.message));
      break;
    case 'reset_to_defaults':
      resetToDefaults()
        .then(() => {
          sendConfig(request_id);
          sendStatus();
          ack(request_id, true, 'reset to saved defaults');
        })
        .catch((e) => ack(request_id, false, e.message));
      break;
    case 'set_model':
      if (args.model && args.model !== activeModel) {
        switchModel(args.model);
      }
      if (modelSelect) modelSelect.value = args.model;
      ack(request_id, true, `model=${args.model}`);
      break;
    case 'set_confidence':
      if (args.confidence != null) {
        confSlider.value = args.confidence;
        confVal.textContent = parseFloat(args.confidence).toFixed(2);
        CONFIG.confidence = parseFloat(args.confidence);
      }
      ack(request_id, true);
      break;
    case 'start_skeleton':
      streamingSkeleton = true;
      if (streamSkeletonCb) streamSkeletonCb.checked = true;
      ack(request_id, true);
      break;
    case 'stop_skeleton':
      streamingSkeleton = false;
      if (streamSkeletonCb) streamSkeletonCb.checked = false;
      ack(request_id, true);
      break;
    case 'start_video':
      streamingVideo = true;
      if (streamRawCb) streamRawCb.checked = true;
      ack(request_id, true);
      break;
    case 'stop_video':
      streamingVideo = false;
      if (streamRawCb) streamRawCb.checked = false;
      ack(request_id, true);
      break;
    case 'start_logging':
      startLogging(args.session_label)
        .then(() => ack(request_id, true, `logging started → ${loggingPath}`))
        .catch((e) => ack(request_id, false, e.message));
      break;
    case 'stop_logging':
      pauseLogging()
        .then(() => ack(request_id, true, 'logging paused'))
        .catch((e) => ack(request_id, false, e.message));
      break;
    case 'save_logging':
      saveLogging()
        .then((r) => ack(request_id, true, `logging saved → ${r.path}`))
        .catch((e) => ack(request_id, false, e.message));
      break;
    case 'discard_logging':
      discardLogging()
        .then(() => ack(request_id, true, 'logging discarded'))
        .catch((e) => ack(request_id, false, e.message));
      break;
    default:
      ack(request_id, false, `unknown command: ${command}`);
  }
}

// ── Frame + status emission ──────────────────────────────────────────────────
function sendSkeletonFrame(poses, minConf) {
  if (!streamingSkeleton || !wsConnected || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'skeleton_frame',
      tracker_id: TRACKER_ID,
      frame_id: frameId,
      ts_unix_ms: Date.now(),
      t: (Date.now() - startTime) / 1000,
      model: activeModel,
      min_confidence: minConf,
      connections: activeConnections,
      resolution: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
      people: poses.map((pose, i) => ({
        id: pose.id != null ? pose.id : i,
        keypoints: pose.keypoints.map((kp) => ({
          x: Math.round(kp.x * 10) / 10,
          y: Math.round(kp.y * 10) / 10,
          z: Math.round((kp.z || 0) * 1000) / 1000,
          score: Math.round(kp.score * 1000) / 1000,
        })),
      })),
    }),
  );
}

let lastVideoSent = 0;
function maybeSendVideoFrame() {
  if (!streamingVideo || !wsConnected || ws.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (now - lastVideoSent < 1000 / VIDEO_STREAM_FPS) return;
  lastVideoSent = now;

  // Clean (skeleton-free) frame so the collector can overlay itself.
  // Mirror to match the keypoint coordinates when CONFIG.mirror is on.
  rawCtx.save();
  if (CONFIG.mirror) {
    rawCtx.translate(VIDEO_WIDTH, 0);
    rawCtx.scale(-1, 1);
  }
  rawCtx.drawImage(video, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  rawCtx.restore();
  const jpeg = rawCanvas.toDataURL('image/jpeg', VIDEO_JPEG_QUALITY);

  ws.send(
    JSON.stringify({
      type: 'video_frame',
      tracker_id: TRACKER_ID,
      frame_id: frameId,
      ts_unix_ms: Date.now(),
      jpeg,
    }),
  );
}

let lastPeopleCount = 0;
function sendStatus() {
  if (!wsConnected || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'status',
      tracker_id: TRACKER_ID,
      model: activeModel,
      fps,
      people_count: lastPeopleCount,
      streaming: streamingVideo,
      streaming_skeleton: streamingSkeleton,
      logging,
      log_path: loggingPath,
      log_entries: loggingEntries,
    }),
  );
}
setInterval(sendStatus, 1000);
setInterval(() => {
  flushLogEntries(false);
}, 1000);

// ── FPS counter ─────────────────────────────────────────────────────────────
let frameCount = 0;
let lastFpsTime = performance.now();
let fps = 0;

function updateFps() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFpsTime = now;
  }
}

function drawFps() {
  ctx.fillStyle = '#00FF00';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(`FPS: ${fps}`, 10, 25);
}

// ── Main loop ───────────────────────────────────────────────────────────────
let detector = null; // MoveNet
let mpDetector = null; // MediaPipe PoseLandmarker
let yoloSession = null; // ONNX Runtime Web session
let yoloActiveModel = null;
let PoseLandmarkerClass = null;
let FilesetResolverClass = null;
const yoloCanvas = document.createElement('canvas');
yoloCanvas.width = YOLO_INPUT_SIZE;
yoloCanvas.height = YOLO_INPUT_SIZE;
const yoloCtx = yoloCanvas.getContext('2d', { willReadFrequently: true });

// Schedule the next detect() iteration. Trackers are meant to run "headless"
// (you watch the collector, not this tab), so we must NOT rely on
// requestAnimationFrame alone: browsers pause rAF in hidden/background tabs,
// which would freeze the canvas AND stop streaming. When hidden we fall back to
// setTimeout so detection + streaming keep going (browsers clamp background
// timers to ~1 fps, which is enough to keep the collector fed).
let detectTimer = null;
let detectRaf = null;
function scheduleDetect() {
  // Cancel any previously scheduled iteration so we never run two loops at once
  // (e.g. when visibilitychange fires while a detect() is already in flight).
  if (detectTimer) {
    clearTimeout(detectTimer);
    detectTimer = null;
  }
  if (detectRaf) {
    cancelAnimationFrame(detectRaf);
    detectRaf = null;
  }
  if (!running) return;
  if (document.visibilityState === 'hidden') {
    detectTimer = setTimeout(detect, 1000 / VIDEO_STREAM_FPS);
  } else {
    detectRaf = requestAnimationFrame(detect);
  }
}

// If the tab was hidden (rAF paused) and becomes visible again, make sure the
// loop is running at full speed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) scheduleDetect();
});

async function detect() {
  if (!running) return;

  try {
    // Camera can briefly be not-ready during switches/reconnects.
    if (video.readyState < 2) return;

    let poses;
    if (activeModel === 'movenet' && detector) {
      const raw = await detector.estimatePoses(video, { maxPoses: 6, flipHorizontal: false });
      poses = raw.map((p) => ({
        id: p.id,
        keypoints: p.keypoints.map((kp) => ({ ...kp, z: 0 })),
      }));
    } else if (activeModel === 'mediapipe' && mpDetector) {
      const result = mpDetector.detectForVideo(video, performance.now());
      poses = (result.landmarks || []).map((landmarks, i) => ({
        id: i,
        keypoints: landmarks.map((lm, j) => ({
          x: lm.x * VIDEO_WIDTH,
          y: lm.y * VIDEO_HEIGHT,
          z: result.worldLandmarks[i] ? result.worldLandmarks[i][j].z : 0,
          score: lm.visibility != null ? lm.visibility : 1.0,
          name: MEDIAPIPE_KEYPOINT_NAMES[j],
        })),
      }));
    } else if (isYoloModel(activeModel) && yoloSession) {
      poses = await estimateYoloPoses(video);
    } else {
      return;
    }

    // Smooth keypoints temporally
    smoothKeypoints(poses);

    // Draw video (mirrored if configured)
    ctx.save();
    if (CONFIG.mirror) {
      ctx.translate(VIDEO_WIDTH, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    ctx.restore();

    const minConf = parseFloat(confSlider.value);
    const showPts = showPointsCb.checked;
    const showSkel = showSkeletonCb.checked;
    const showBbox = showBboxCb.checked;

    // Mirror keypoints for drawing/streaming when configured
    const mirroredPoses = [];
    for (let i = 0; i < poses.length; i++) {
      const pose = poses[i];
      const color = PERSON_COLORS[i % PERSON_COLORS.length];

      const mirrored = pose.keypoints.map((kp) => ({
        ...kp,
        x: CONFIG.mirror ? VIDEO_WIDTH - kp.x : kp.x,
      }));

      mirroredPoses.push({ ...pose, keypoints: mirrored });

      if (showSkel) drawSkeleton(mirrored, color, minConf);
      if (showPts) drawKeypoints(mirrored, color, minConf);
      if (showBbox) drawBoundingBox(mirrored, color, minConf);
      drawPersonLabel(mirrored, i, color, minConf);
    }

    // Stream mirrored poses + (throttled) raw video to the collector hub
    lastPeopleCount = poses.length;
    frameId++;
    sendSkeletonFrame(mirroredPoses, minConf);
    maybeSendVideoFrame();
    queueLogEntry(mirroredPoses);

    // Info overlay
    updateFps();
    drawFps();
    ctx.fillStyle = '#00FF00';
    ctx.font = '14px monospace';
    ctx.fillText(`People: ${poses.length}`, 10, 45);
    ctx.fillText(`Model: ${modelLabel(activeModel)}`, 10, 65);
  } catch (err) {
    console.error('Detection loop error:', err);
  } finally {
    if (running) scheduleDetect();
  }
}

function prepareYoloInput(source) {
  const scale = Math.min(YOLO_INPUT_SIZE / VIDEO_WIDTH, YOLO_INPUT_SIZE / VIDEO_HEIGHT);
  const drawW = VIDEO_WIDTH * scale;
  const drawH = VIDEO_HEIGHT * scale;
  const padX = (YOLO_INPUT_SIZE - drawW) / 2;
  const padY = (YOLO_INPUT_SIZE - drawH) / 2;

  yoloCtx.fillStyle = '#000';
  yoloCtx.fillRect(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
  yoloCtx.drawImage(source, padX, padY, drawW, drawH);

  const { data } = yoloCtx.getImageData(0, 0, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE);
  const input = new Float32Array(3 * YOLO_INPUT_SIZE * YOLO_INPUT_SIZE);
  const plane = YOLO_INPUT_SIZE * YOLO_INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    const src = i * 4;
    input[i] = data[src] / 255;
    input[plane + i] = data[src + 1] / 255;
    input[plane * 2 + i] = data[src + 2] / 255;
  }
  return { input, scale, padX, padY };
}

function yoloValue(data, dims, attr, index) {
  if (dims.length === 3) {
    if (dims[1] <= dims[2]) return data[attr * dims[2] + index];
    return data[index * dims[2] + attr];
  }
  return data[index * dims[1] + attr];
}

function boxIou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return inter / Math.max(1e-6, areaA + areaB - inter);
}

function clampPoint(x, y) {
  return {
    x: Math.max(0, Math.min(VIDEO_WIDTH, x)),
    y: Math.max(0, Math.min(VIDEO_HEIGHT, y)),
  };
}

function decodeYoloOutput(tensor, scale, padX, padY) {
  const dims = tensor.dims;
  if (dims.length !== 2 && dims.length !== 3) throw new Error(`Unsupported YOLO output shape: ${dims.join('x')}`);

  const attrs = dims.length === 3 ? Math.min(dims[1], dims[2]) : dims[1];
  const count = dims.length === 3 ? Math.max(dims[1], dims[2]) : dims[0];
  const keypointOffset = attrs - MOVENET_KEYPOINT_NAMES.length * 3;
  const scoreIndex = keypointOffset - 1;
  if (keypointOffset < 5) throw new Error(`Unsupported YOLO pose attribute count: ${attrs}`);

  const minScore = Math.max(0.05, parseFloat(confSlider.value) * 0.5);
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const score = yoloValue(tensor.data, dims, scoreIndex, i);
    if (score < minScore) continue;

    const cx = yoloValue(tensor.data, dims, 0, i);
    const cy = yoloValue(tensor.data, dims, 1, i);
    const w = yoloValue(tensor.data, dims, 2, i);
    const h = yoloValue(tensor.data, dims, 3, i);
    const x1 = (cx - w / 2 - padX) / scale;
    const y1 = (cy - h / 2 - padY) / scale;
    const x2 = (cx + w / 2 - padX) / scale;
    const y2 = (cy + h / 2 - padY) / scale;

    const keypoints = MOVENET_KEYPOINT_NAMES.map((name, k) => {
      const offset = keypointOffset + k * 3;
      const pt = clampPoint(
        (yoloValue(tensor.data, dims, offset, i) - padX) / scale,
        (yoloValue(tensor.data, dims, offset + 1, i) - padY) / scale,
      );
      return {
        ...pt,
        z: 0,
        score: Math.max(0, Math.min(1, yoloValue(tensor.data, dims, offset + 2, i))),
        name,
      };
    });

    candidates.push({ score, x1, y1, x2, y2, keypoints });
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((kept) => boxIou(candidate, kept) < YOLO_NMS_IOU)) {
      selected.push(candidate);
      if (selected.length >= YOLO_MAX_POSES) break;
    }
  }
  return selected.map((pose, id) => ({ id, keypoints: pose.keypoints }));
}

async function estimateYoloPoses(source) {
  const ortRuntime = window.ort;
  if (!ortRuntime) throw new Error('ONNX Runtime Web is not loaded. Run setup.sh and reload the tracker.');
  const { input, scale, padX, padY } = prepareYoloInput(source);
  const tensor = new ortRuntime.Tensor('float32', input, [1, 3, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE]);
  const feeds = { [yoloSession.inputNames[0]]: tensor };
  const results = await yoloSession.run(feeds);
  const output = results[yoloSession.outputNames[0]];
  return decodeYoloOutput(output, scale, padX, padY);
}

// ── Model initialization ────────────────────────────────────────────────────
async function initMoveNet() {
  statusEl.textContent = 'Loading MoveNet MultiPose Lightning...';
  detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
    modelUrl: 'model/model.json',
    enableSmoothing: true,
    enableTracking: true,
    trackerType: poseDetection.TrackerType.BoundingBox,
  });
  activeModel = 'movenet';
  activeConnections = MOVENET_CONNECTIONS;
}

async function initMediaPipe() {
  statusEl.textContent = 'Loading MediaPipe BlazePose (3D)...';
  if (!PoseLandmarkerClass) {
    const vision = await import('./lib/tasks-vision/vision_bundle.js');
    PoseLandmarkerClass = vision.PoseLandmarker;
    FilesetResolverClass = vision.FilesetResolver;
  }

  // Release previous instance before creating a new one (important when
  // switching models repeatedly on browsers with limited WebGL contexts).
  if (mpDetector && typeof mpDetector.close === 'function') {
    try {
      mpDetector.close();
    } catch {
      // Ignore close errors and continue with a fresh instance.
    }
  }

  const wasmFileset = await FilesetResolverClass.forVisionTasks('./lib/tasks-vision/wasm');

  try {
    mpDetector = await PoseLandmarkerClass.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: './model-mediapipe/pose_landmarker_full.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 6,
    });
  } catch (gpuErr) {
    console.warn('MediaPipe GPU delegate failed, retrying with CPU delegate:', gpuErr);
    statusEl.textContent = 'MediaPipe GPU unavailable, falling back to CPU...';
    mpDetector = await PoseLandmarkerClass.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: './model-mediapipe/pose_landmarker_full.task',
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numPoses: 6,
    });
  }

  activeModel = 'mediapipe';
  activeConnections = MEDIAPIPE_CONNECTIONS;
}

async function initYolo(model) {
  const cfg = YOLO_MODELS[model];
  if (!cfg) throw new Error(`Unknown YOLO model: ${model}`);
  const ortRuntime = window.ort;
  if (!ortRuntime) throw new Error('ONNX Runtime Web is not loaded. Run setup.sh and reload the tracker.');

  statusEl.textContent = `Loading ${cfg.label}...`;
  ortRuntime.env.wasm.wasmPaths = './lib/onnxruntime-web/';
  ortRuntime.env.wasm.numThreads = 1;
  if (!yoloSession || yoloActiveModel !== model) {
    yoloSession = await ortRuntime.InferenceSession.create(cfg.modelPath, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    yoloActiveModel = model;
  }
  activeModel = model;
  activeConnections = MOVENET_CONNECTIONS;
}

// ── Init ────────────────────────────────────────────────────────────────────
async function switchModel(model) {
  running = false;
  smoothedPoses.clear();
  statusEl.textContent = 'Switching model...';
  statusEl.classList.remove('ready');
  try {
    if (model === 'mediapipe') {
      await initMediaPipe();
    } else if (isYoloModel(model)) {
      await initYolo(model);
    } else {
      await initMoveNet();
    }
    statusEl.textContent = 'Tracking active ✓';
    statusEl.classList.add('ready');
    running = true;
    sendHello(); // re-register with the new model after a switch
    scheduleDetect();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.classList.add('error');
    console.error(err);
  }
}

async function main() {
  try {
    // Load the per-tracker config FIRST: it sets camera, resolution, model,
    // confidence, mirror, streamRaw and the collector URL.
    statusEl.textContent = 'Loading config...';
    await loadConfig();

    // Seed UI + runtime flags from config
    activeModel = CONFIG.model;
    streamingSkeleton = CONFIG.streamSkeleton;
    streamingVideo = CONFIG.streamRaw;
    if (modelSelect) modelSelect.value = CONFIG.model;
    if (streamSkeletonCb) streamSkeletonCb.checked = CONFIG.streamSkeleton;
    if (streamRawCb) streamRawCb.checked = CONFIG.streamRaw;
    if (confSlider) {
      confSlider.value = CONFIG.confidence;
      confVal.textContent = parseFloat(CONFIG.confidence).toFixed(2);
    }

    // Connect to the hub now that CONFIG.collector is resolved
    connectWebSocket();

    statusEl.textContent = 'Requesting camera access...';
    // First grab any camera so enumerateDevices returns labels…
    await setupCamera();
    // …then list cameras and switch to the configured one if needed.
    await listCameras();
    if (selectedDeviceId && currentStream) {
      const active = currentStream.getVideoTracks()[0];
      const activeId = active && active.getSettings ? active.getSettings().deviceId : null;
      if (activeId !== selectedDeviceId) await setupCamera(selectedDeviceId);
    }

    if (CONFIG.model === 'mediapipe') {
      await initMediaPipe();
    } else if (isYoloModel(CONFIG.model)) {
      await initYolo(CONFIG.model);
    } else {
      await initMoveNet();
    }

    statusEl.textContent = 'Tracking active ✓';
    statusEl.classList.add('ready');
    running = true;
    sendHello();
    sendConfig(); // let the monitor see the current effective config on join
    scheduleDetect();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.classList.add('error');
    console.error(err);
  }
}

if (modelSelect) {
  modelSelect.addEventListener('change', () => switchModel(modelSelect.value));
}

if (streamSkeletonCb) {
  streamSkeletonCb.addEventListener('change', () => {
    streamingSkeleton = streamSkeletonCb.checked;
  });
}

if (streamRawCb) {
  streamRawCb.addEventListener('change', () => {
    streamingVideo = streamRawCb.checked;
  });
}

main();
