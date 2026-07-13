#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start_collector.sh — Launch the collector hub (WS router + UI), open the UI.
# Run this on the central-collector-machine.
# ─────────────────────────────────────────────────────────────────────────────
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"
source "$BASE_DIR/../scripts/port_guard.sh"

WS_PORT=9000
UI_PORT=8090

PORT_GUARD_HINT="STOP_EXISTING=1 ./start_collector.sh"
prepare_ports "collector" "$WS_PORT" "$UI_PORT"

# Ensure the project venv exists with all deps, then use its python ($PY)
source "$BASE_DIR/../venv.sh"

echo "▸ Collector hub starting"
echo "    WebSocket router : ws://localhost:${WS_PORT}"
echo "    Collector UI     : http://localhost:${UI_PORT}/collector.html"
echo ""
echo "  Point trackers at:   ws://<this-machine>:${WS_PORT}"
echo "  Press Ctrl-C to stop."
echo ""

# Open the UI shortly after the hub comes up
(sleep 1 && open "http://localhost:${UI_PORT}/collector.html" 2>/dev/null || true) &

exec "$PY" hub.py
