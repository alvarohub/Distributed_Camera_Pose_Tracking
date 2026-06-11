#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start_local_demo.sh — One-machine demo of the distributed system.
#
# Launches:
#   • collector hub        (WS router :9000  +  collector UI :8090)
#   • tracker HTTP server   (:8080)
#   • collector UI tab
#   • one tracker tab per id you pass (default: cam-left cam-right)
#
# Usage:
#   ./start_local_demo.sh                 # opens cam-left and cam-right
#   ./start_local_demo.sh cam-left        # one webcam? open just one tracker
#   ./start_local_demo.sh cam-a cam-b cam-c   # any ids with a matching trackers/<id>.json
#
# Everything talks over WebSocket exactly as it would across machines — the
# only difference here is that all processes happen to run on this one host.
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COLLECTOR_DIR="$ROOT_DIR/central-collector-machine"
TRACKER_DIR="$ROOT_DIR/skeleton-tracker-computer"

# Tracker ids to open (each needs a matching trackers/<id>.json). Override via args.
TRACKER_IDS=("$@")
if [ ${#TRACKER_IDS[@]} -eq 0 ]; then
  TRACKER_IDS=(cam-left cam-right)
fi

WS_PORT=9000
UI_PORT=8090
HTTP_PORT=8080
COLLECTOR_URL="ws://localhost:${WS_PORT}"

# Ensure the project venv exists with all deps, then use its python ($PY)
source "$ROOT_DIR/venv.sh"

# Let the collector UI's "Stop servers" button take down this whole demo:
# with this flag, the hub stops its own process group (hub + tracker server +
# this script) on request. Without it (standalone launches) the hub only stops
# itself, so we never signal an unrelated process group.
export HUB_KILL_PROCESS_GROUP=1

# Ensure tracker dependencies exist
if [ ! -f "$TRACKER_DIR/lib/tf.min.js" ] || [ ! -f "$TRACKER_DIR/model/model.json" ]; then
  echo "⚠  Tracker dependencies not found. Running setup first..."
  (cd "$TRACKER_DIR" && bash setup.sh)
fi

PIDS=()
cleanup() {
  echo ""
  echo "Stopping…"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  exit 0
}
trap cleanup INT TERM

# 1) Collector hub (serves UI on :8090 and routes WS on :9000)
echo "▸ Collector hub  : ws://localhost:${WS_PORT}  |  UI http://localhost:${UI_PORT}/collector.html"
(cd "$COLLECTOR_DIR" && "$PY" hub.py) &
PIDS+=($!)

# 2) Tracker page server (serves files + persists config on "save defaults")
echo "▸ Tracker server : http://localhost:${HTTP_PORT}"
(cd "$TRACKER_DIR" && "$PY" tracker_server.py "$HTTP_PORT") &
PIDS+=($!)

echo ""
echo "  Opening collector UI and ${#TRACKER_IDS[@]} tracker tab(s): ${TRACKER_IDS[*]}"
echo "  Each tracker reads its camera + settings from trackers/<id>.json."
echo "  If a tracker grabbed the wrong camera, edit that file or use the dropdown."
echo "  Press Ctrl-C to stop everything."
echo ""

# 3) Open tabs: collector first, then one tab per tracker id (camera comes from config files)
(sleep 1 && open "http://localhost:${UI_PORT}/collector.html" 2>/dev/null || true) &
delay=2
for id in "${TRACKER_IDS[@]}"; do
  (sleep "$delay" && open "http://localhost:${HTTP_PORT}/?id=${id}" 2>/dev/null || true) &
  delay=$((delay + 1))
done

wait
