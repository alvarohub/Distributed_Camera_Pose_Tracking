// ── Config ──────────────────────────────────────────────────────────────────
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;

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

// ── Active model state ──────────────────────────────────────────────────────
let activeModel = 'movenet'; // 'movenet' | 'mediapipe'
let activeConnections = MOVENET_CONNECTIONS;
let running = false;

// ── DOM refs ────────────────────────────────────────────────────────────────
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const confSlider = document.getElementById('confidence');
const confVal = document.getElementById('conf-val');
const showPointsCb = document.getElementById('show-points');
const showSkeletonCb = document.getElementById('show-skeleton');
const showBboxCb = document.getElementById('show-bbox');
const modelSelect = document.getElementById('model-select');

canvas.width = VIDEO_WIDTH;
canvas.height = VIDEO_HEIGHT;

confSlider.addEventListener('input', () => {
  confVal.textContent = parseFloat(confSlider.value).toFixed(2);
});

// ── Camera setup ────────────────────────────────────────────────────────────
async function setupCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();
      resolve(video);
    };
  });
}

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

// ── WebSocket streaming ─────────────────────────────────────────────────────
let ws = null;
let wsConnected = false;
const startTime = Date.now();

function connectWebSocket() {
  const url = `ws://${location.hostname}:8765`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    wsConnected = true;
    console.log('WS connected');
  };
  ws.onclose = () => {
    wsConnected = false;
    setTimeout(connectWebSocket, 2000);
  };
  ws.onerror = () => {
    ws.close();
  };
}
connectWebSocket();

function broadcastPoses(poses, minConf) {
  if (!wsConnected || ws.readyState !== WebSocket.OPEN) return;
  const payload = {
    model: activeModel,
    connections: activeConnections,
    t: (Date.now() - startTime) / 1000, // seconds since start
    ts: Date.now(),
    w: VIDEO_WIDTH,
    h: VIDEO_HEIGHT,
    people: poses.map((pose, i) => ({
      id: pose.id != null ? pose.id : i,
      keypoints: pose.keypoints.map((kp) => ({
        x: Math.round(kp.x * 10) / 10,
        y: Math.round(kp.y * 10) / 10,
        z: Math.round((kp.z || 0) * 1000) / 1000,
        score: Math.round(kp.score * 1000) / 1000,
      })),
    })),
  };
  ws.send(JSON.stringify(payload));
}

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
let PoseLandmarkerClass = null;
let FilesetResolverClass = null;

async function detect() {
  if (!running) return;

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
  } else {
    requestAnimationFrame(detect);
    return;
  }

  // Smooth keypoints temporally
  smoothKeypoints(poses);

  // Draw mirrored video
  ctx.save();
  ctx.translate(VIDEO_WIDTH, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  ctx.restore();

  const minConf = parseFloat(confSlider.value);
  const showPts = showPointsCb.checked;
  const showSkel = showSkeletonCb.checked;
  const showBbox = showBboxCb.checked;

  // Mirror keypoints for drawing
  const mirroredPoses = [];
  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    const color = PERSON_COLORS[i % PERSON_COLORS.length];

    const mirrored = pose.keypoints.map((kp) => ({
      ...kp,
      x: VIDEO_WIDTH - kp.x,
    }));

    mirroredPoses.push({ ...pose, keypoints: mirrored });

    if (showSkel) drawSkeleton(mirrored, color, minConf);
    if (showPts) drawKeypoints(mirrored, color, minConf);
    if (showBbox) drawBoundingBox(mirrored, color, minConf);
    drawPersonLabel(mirrored, i, color, minConf);
  }

  // Stream mirrored poses over WebSocket
  broadcastPoses(mirroredPoses, minConf);

  // Info overlay
  updateFps();
  drawFps();
  ctx.fillStyle = '#00FF00';
  ctx.font = '14px monospace';
  ctx.fillText(`People: ${poses.length}`, 10, 45);
  ctx.fillText(`Model: ${activeModel === 'movenet' ? 'MoveNet 17pt' : 'MediaPipe 33pt 3D'}`, 10, 65);

  requestAnimationFrame(detect);
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
  const wasmFileset = await FilesetResolverClass.forVisionTasks('./lib/tasks-vision/wasm');
  mpDetector = await PoseLandmarkerClass.createFromOptions(wasmFileset, {
    baseOptions: {
      modelAssetPath: './model-mediapipe/pose_landmarker_full.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 6,
  });
  activeModel = 'mediapipe';
  activeConnections = MEDIAPIPE_CONNECTIONS;
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
    } else {
      await initMoveNet();
    }
    statusEl.textContent = 'Tracking active ✓';
    statusEl.classList.add('ready');
    running = true;
    requestAnimationFrame(detect);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.classList.add('error');
    console.error(err);
  }
}

async function main() {
  try {
    statusEl.textContent = 'Requesting camera access...';
    await setupCamera();

    const selected = modelSelect ? modelSelect.value : 'movenet';
    if (selected === 'mediapipe') {
      await initMediaPipe();
    } else {
      await initMoveNet();
    }

    statusEl.textContent = 'Tracking active ✓';
    statusEl.classList.add('ready');
    running = true;
    requestAnimationFrame(detect);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.classList.add('error');
    console.error(err);
  }
}

if (modelSelect) {
  modelSelect.addEventListener('change', () => switchModel(modelSelect.value));
}

main();
