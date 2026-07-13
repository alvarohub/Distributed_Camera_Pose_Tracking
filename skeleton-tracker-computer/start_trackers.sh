#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start_trackers.sh — Serve the tracker page and open tracker tabs.
# Each tab reads its camera + settings from trackers/<id>.json.
# Run this on a skeleton-tracker-computer.
#
# Usage:
#   ./start_trackers.sh cam-left cam-right                 # open named tracker configs
#   ./start_trackers.sh                                    # open every trackers/*.json except example.json
#   COLLECTOR=ws://192.168.1.50:9000 ./start_trackers.sh   # optional temporary override
# ─────────────────────────────────────────────────────────────────────────────
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"
source "$BASE_DIR/../scripts/port_guard.sh"

HTTP_PORT=8080
COLLECTOR_OVERRIDE="${COLLECTOR:-}"
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

PORT_GUARD_HINT="STOP_EXISTING=1 ./start_trackers.sh ${TRACKER_IDS[*]}"
prepare_ports "tracker server" "$HTTP_PORT"

# Check that setup has been run
if [ ! -f lib/tf.min.js ] || [ ! -f model/model.json ] || [ ! -f lib/onnxruntime-web/ort.min.js ]; then
  echo "⚠  Dependencies not found. Running setup first..."
  bash setup.sh
fi

# URL-encode the collector override (if any) for safe use in a query string
ENC_COLLECTOR=""
if [ -n "$COLLECTOR_OVERRIDE" ]; then
  ENC_COLLECTOR=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$COLLECTOR_OVERRIDE")
fi

# ── Camera listing ──────────────────────────────────────────────────────────
OS_NAME="$(uname -s)"
echo "▸ Cameras detected on this machine:"
if [ "$OS_NAME" = "Darwin" ]; then
  system_profiler SPCameraDataType 2>/dev/null \
    | awk '/^    [^ ]/{name=$0} /Unique ID/{print NR": "name}' \
    | sed 's/^/    /' \
    || echo "    (system_profiler unavailable)"
else
  if command -v v4l2-ctl >/dev/null 2>&1; then
    v4l2-ctl --list-devices 2>/dev/null | sed 's/^/    /' || true
  fi
  for dev in /dev/video*; do [ -e "$dev" ] && echo "    $dev"; done
fi
echo ""
echo "▸ Tracker camera assignments:"
for id in "${TRACKER_IDS[@]}"; do
  cfg="trackers/${id}.json"
  cam="(default — first camera)"
  if [ -f "$cfg" ]; then
    cam=$(python3 -c "
import json,sys
try:
  d=json.load(open(sys.argv[1]))
  c=d.get('camera')
  print(repr(c) if c is not None else '(default — first camera)')
except Exception as e:
  print('(could not read config: '+str(e)+')')
" "$cfg" 2>/dev/null || echo "(could not read config)")
  fi
  echo "    $id  →  camera: $cam"
done
echo ""

echo "▸ Tracker HTTP server on http://localhost:${HTTP_PORT}"
echo "    Collector hub: ${COLLECTOR_OVERRIDE:-from each trackers/<id>.json}"
echo ""
echo "  Opening tracker tab(s): ${TRACKER_IDS[*]}"
echo "  Each reads its camera + settings from trackers/<id>.json."
echo "  Edit those files (or use the camera dropdown) to pick the right webcam."
echo "  Press Ctrl-C to stop."
echo ""

trap "echo ''; echo 'Stopped.'; exit 0" INT TERM

# Open trackers by id. Camera + settings come from trackers/<id>.json.
# Pass collector= only when COLLECTOR is set in the env, so the config file
# stays authoritative otherwise.
COLLECTOR_Q=""
if [ -n "${COLLECTOR_OVERRIDE:-}" ]; then COLLECTOR_Q="&collector=${ENC_COLLECTOR}"; fi
CACHE_BUST="$(date +%s)"
delay=1
for id in "${TRACKER_IDS[@]}"; do
  if [ ! -f "trackers/${id}.json" ]; then
    echo "⚠  Missing config: trackers/${id}.json"
  fi
  ENC_ID=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$id")
  (sleep "$delay" && open "http://localhost:${HTTP_PORT}/?id=${ENC_ID}${COLLECTOR_Q}&v=${CACHE_BUST}" 2>/dev/null || true) &
  delay=$((delay + 1))
done

# Custom server: serves the page AND persists trackers/<id>.json on "save defaults"
python3 tracker_server.py "$HTTP_PORT"
