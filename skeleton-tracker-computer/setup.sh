#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh — Download TF.js libraries + MoveNet model for fully offline use
# Run once.  After this, the folder is self-contained.
# ─────────────────────────────────────────────────────────────────────────────
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

echo "▸ Downloading TF.js runtime..."
mkdir -p lib
curl -sL -o lib/tf.min.js \
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"

echo "▸ Downloading pose-detection library..."
curl -sL -o lib/pose-detection.min.js \
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js"

echo "▸ Downloading MoveNet MultiPose Lightning model..."
mkdir -p model

# Download model.json
curl -sL -o model/model.json \
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
  curl -sL -o "model/$shard" \
    "https://tfhub.dev/google/tfjs-model/movenet/multipose/lightning/1/${shard}?tfjs-format=file"
done

echo "▸ Downloading MediaPipe Tasks Vision (WASM + JS)..."
mkdir -p lib/tasks-vision/wasm
curl -sL -o lib/tasks-vision/vision_bundle.js \
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"

for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  echo "  ▸ $f"
  curl -sL -o "lib/tasks-vision/wasm/$f" \
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/$f"
done

echo "▸ Downloading MediaPipe Pose Landmarker model (full)..."
mkdir -p model-mediapipe
curl -sL -o model-mediapipe/pose_landmarker_full.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"

echo ""
echo "▸ Installing Python websockets package..."
pip3 install websockets

echo ""
echo "✓ Setup complete!"
echo "  MoveNet model:"
du -sh model/
echo "  MediaPipe model:"
du -sh model-mediapipe/
echo ""
echo "Run ./start.sh to launch the tracker."
