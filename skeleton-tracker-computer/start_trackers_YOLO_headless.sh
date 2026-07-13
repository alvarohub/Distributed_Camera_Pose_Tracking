#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start_trackers_YOLO_headless.sh — Run YOLO pose trackers without browser tabs.
# Each process reads camera + collector settings from trackers/<id>.json.
#
# Usage:
#   ./start_trackers_YOLO_headless.sh front-door side-view
#   ./start_trackers_YOLO_headless.sh        # all trackers/*.json except example.json
# ─────────────────────────────────────────────────────────────────────────────
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$BASE_DIR/.."
cd "$BASE_DIR"

source "$ROOT_DIR/venv.sh"

if ! "$PY" - <<'PY'
import cv2  # noqa: F401
import ultralytics  # noqa: F401
PY
then
  echo ""
  echo "Missing optional YOLO headless dependencies. Install once with:"
  echo "  cd \"$ROOT_DIR\""
  echo "  .venv/bin/python -m pip install -r requirements-headless-yolo.txt"
  exit 1
fi

TRACKER_IDS=("$@")
if [ ${#TRACKER_IDS[@]} -eq 0 ]; then
  while IFS= read -r file; do
    id="$(basename "$file" .json)"
    [ "$id" = "example" ] && continue
    TRACKER_IDS+=("$id")
  done < <(find trackers -maxdepth 1 -type f -name '*.json' | sort)
fi

if [ ${#TRACKER_IDS[@]} -eq 0 ]; then
  echo "No tracker configs found. Create trackers/<id>.json or pass ids explicitly."
  exit 1
fi

echo "▸ Starting YOLO headless tracker(s): ${TRACKER_IDS[*]}"
echo "  Each reads trackers/<id>.json and streams to that file's collector URL."
echo "  Press Ctrl-C to stop."
echo ""

PIDS=()
cleanup() {
  echo ""
  echo "Stopping YOLO headless trackers..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

for id in "${TRACKER_IDS[@]}"; do
  if [ ! -f "trackers/${id}.json" ]; then
    echo "⚠  Missing config: trackers/${id}.json"
  fi
  "$PY" headless_yolo_tracker.py --id "$id" &
  PIDS+=($!)
done

wait