#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start_trackers.sh — Serve the tracker page and open two tracker tabs.
# Each tab reads its camera + settings from trackers/<id>.json.
# Run this on a skeleton-tracker-computer.
#
# Usage:
#   ./start_trackers.sh                                    # collector from each config file
#   COLLECTOR=ws://192.168.1.50:9000 ./start_trackers.sh   # override collector for all tabs
# ─────────────────────────────────────────────────────────────────────────────
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

HTTP_PORT=8080
COLLECTOR_OVERRIDE="${COLLECTOR:-}"

# Check that setup has been run
if [ ! -f lib/tf.min.js ] || [ ! -f model/model.json ]; then
  echo "⚠  Dependencies not found. Running setup first..."
  bash setup.sh
fi

# URL-encode the collector override (if any) for safe use in a query string
ENC_COLLECTOR=""
if [ -n "$COLLECTOR_OVERRIDE" ]; then
  ENC_COLLECTOR=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$COLLECTOR_OVERRIDE")
fi

echo "▸ Tracker HTTP server on http://localhost:${HTTP_PORT}"
echo "    Collector hub: ${COLLECTOR_OVERRIDE:-from each trackers/<id>.json}"
echo ""
echo "  Opening two tracker tabs: cam-left and cam-right."
echo "  Each reads its camera + settings from trackers/<id>.json."
echo "  Edit those files (or use the camera dropdown) to pick the right webcam."
echo "  Press Ctrl-C to stop."
echo ""

trap "echo ''; echo 'Stopped.'; exit 0" INT TERM

# Open two trackers by id. Camera + settings come from trackers/<id>.json.
# Pass collector= only when COLLECTOR is set in the env, so the config file
# stays authoritative otherwise.
COLLECTOR_Q=""
if [ -n "${COLLECTOR_OVERRIDE:-}" ]; then COLLECTOR_Q="&collector=${ENC_COLLECTOR}"; fi
(sleep 1 && open "http://localhost:${HTTP_PORT}/?id=cam-left${COLLECTOR_Q}" 2>/dev/null || true) &
(sleep 2 && open "http://localhost:${HTTP_PORT}/?id=cam-right${COLLECTOR_Q}" 2>/dev/null || true) &

# Custom server: serves the page AND persists trackers/<id>.json on "save defaults"
python3 tracker_server.py "$HTTP_PORT"
