#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — Launch HTTP server + WebSocket relay, then open browser
# ─────────────────────────────────────────────────────────────────────────────
set -e // Exit on error

BASE_DIR="$(cd "$(dirname "$0")" && pwd)" 
cd "$BASE_DIR"

HTTP_PORT=8080
WS_PORT=8765

# Check that setup has been run
if [ ! -f lib/tf.min.js ] || [ ! -f model/model.json ]; then
  echo "⚠  Dependencies not found. Running setup first..."
  bash setup.sh
fi

# Install websockets if missing
python3 -c "import websockets" 2>/dev/null || {
  echo "▸ Installing websockets Python package..."
  pip3 install websockets
}

# Start WebSocket relay in background
echo "▸ WebSocket relay on ws://localhost:${WS_PORT}"
python3 ws_relay.py &
WS_PID=$!

# Clean up on exit
trap "kill $WS_PID 2>/dev/null; echo ''; echo 'Stopped.'; exit 0" INT TERM

echo "▸ HTTP server  on http://localhost:${HTTP_PORT}"
echo ""
echo "  Tracker: http://localhost:${HTTP_PORT}/"
echo "  Viewer:  http://localhost:${HTTP_PORT}/viewer.html"
echo ""
echo "  Press Ctrl-C to stop."
echo ""

# Open browser
(sleep 1 && open "http://localhost:${HTTP_PORT}" 2>/dev/null || true) &
(sleep 2 && open "http://localhost:${HTTP_PORT}/viewer.html" 2>/dev/null || true) &

python3 -m http.server "$HTTP_PORT"
