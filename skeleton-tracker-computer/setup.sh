#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh — Download browser runtimes + pose models for fully offline use
# Run once.  After this, the folder is self-contained.
# ─────────────────────────────────────────────────────────────────────────────
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
else
  echo "✗ Neither curl nor wget is installed."
  echo "  Install one of them, then re-run ./setup.sh"
  exit 1
fi

download_to_file() {
  local out="$1"
  local url="$2"
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL -o "$out" "$url"
  else
    wget -q -O "$out" "$url"
  fi
}

echo "▸ Downloading TF.js runtime..."
mkdir -p lib
download_to_file lib/tf.min.js \
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"

echo "▸ Downloading pose-detection library..."
download_to_file lib/pose-detection.min.js \
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js"

echo "▸ Downloading MoveNet MultiPose Lightning model..."
mkdir -p model

# Download model.json
download_to_file model/model.json \
  "https://tfhub.dev/google/tfjs-model/movenet/multipose/lightning/1/model.json?tfjs-format=file"

# Extract weight-shard filenames from model.json and download each one
SHARDS=$(python3 -c "
import json
with open('model/model.json') as f:
    data = json.load(f)
for group in data.get('weightsManifest', []):
    for path in group.get('paths', []):
        print(path)
")

for shard in $SHARDS; do
  echo "  ▸ $shard"
  download_to_file "model/$shard" \
    "https://tfhub.dev/google/tfjs-model/movenet/multipose/lightning/1/${shard}?tfjs-format=file"
done

echo "▸ Downloading MediaPipe Tasks Vision (WASM + JS)..."
mkdir -p lib/tasks-vision/wasm
download_to_file lib/tasks-vision/vision_bundle.js \
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"

for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  echo "  ▸ $f"
  download_to_file "lib/tasks-vision/wasm/$f" \
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/$f"
done

echo "▸ Downloading MediaPipe Pose Landmarker model (full)..."
mkdir -p model-mediapipe
download_to_file model-mediapipe/pose_landmarker_full.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"

echo "▸ Downloading ONNX Runtime Web..."
ORT_VERSION="1.18.0"
mkdir -p lib/onnxruntime-web
download_to_file lib/onnxruntime-web/ort.min.js \
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js"
for f in ort-wasm.wasm ort-wasm-simd.wasm ort-wasm-threaded.wasm ort-wasm-simd-threaded.wasm; do
  echo "  ▸ $f"
  download_to_file "lib/onnxruntime-web/$f" \
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/$f"
done

echo "▸ Preparing YOLO pose ONNX models..."
mkdir -p model-yolo
if [ "${SKIP_YOLO:-0}" = "1" ]; then
  echo "  ▸ skipped (SKIP_YOLO=1)"
else
  if ! python3 - <<'PY'
import importlib.util
raise SystemExit(0 if importlib.util.find_spec('ultralytics') else 1)
PY
  then
    echo "  ▸ installing ultralytics exporter (this may take a while)..."
    pip3 install ultralytics
  fi

  if ! python3 - <<'PY'
from pathlib import Path
from ultralytics import YOLO

outdir = Path('model-yolo')
outdir.mkdir(exist_ok=True)
for weights in ('yolov8n-pose.pt', 'yolo11n-pose.pt'):
    out = outdir / f'{Path(weights).stem}.onnx'
    if out.exists():
        print(f'  ▸ {out} already exists')
        continue
    print(f'  ▸ exporting {weights} → {out}')
    exported = Path(YOLO(weights).export(format='onnx', imgsz=640, opset=12, simplify=False, dynamic=False))
    exported.replace(out)
PY
  then
    echo "  ⚠ YOLO export failed. MoveNet/MediaPipe still work."
    echo "    To add YOLO later, place yolov8n-pose.onnx and yolo11n-pose.onnx in model-yolo/."
  fi
fi

echo ""
echo "▸ Installing Python websockets package..."
pip3 install websockets

echo ""
echo "✓ Setup complete!"
echo "  MoveNet model:"
du -sh model/
echo "  MediaPipe model:"
du -sh model-mediapipe/
echo "  ONNX Runtime Web:"
du -sh lib/onnxruntime-web/
if [ -d model-yolo ]; then
  echo "  YOLO pose models:"
  du -sh model-yolo/
fi
echo ""
echo "Run ./start_trackers.sh to launch the tracker."
