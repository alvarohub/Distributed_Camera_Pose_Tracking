#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# start_local_demo.sh — One-machine demo of the distributed system.
#
# Launches:
#   • collector hub        (WS router :9000  +  collector UI :8090)
#   • tracker HTTP server   (:8080)
#   • collector UI window
#   • one tracker window per id you pass (default: cam-left cam-right)
#
# Usage:
#   ./start_local_demo.sh                 # opens tiled windows for collector/cam-left/cam-right
#   ./start_local_demo.sh cam-left        # one webcam? open just one tracker
#   ./start_local_demo.sh cam-a cam-b cam-c   # any ids with a matching trackers/<id>.json
#
# Optional:
#   BROWSER_APP="Safari" ./start_local_demo.sh
#   BROWSER_APP="Google Chrome" ./start_local_demo.sh
#   BROWSER_APP="xdg-open" ./start_local_demo.sh      # Linux/Jetson
#   NO_BROWSER=1 ./start_local_demo.sh                 # don't auto-open; print URLs only
#
# Everything talks over WebSocket exactly as it would across machines — the
# only difference here is that all processes happen to run on this one host.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COLLECTOR_DIR="$ROOT_DIR/central-collector-machine"
TRACKER_DIR="$ROOT_DIR/skeleton-tracker-computer"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/start_local_demo.pids"
source "$ROOT_DIR/scripts/port_guard.sh"

# Tracker ids to open (each needs a matching trackers/<id>.json). Override via args.
TRACKER_IDS=("$@")
if [ ${#TRACKER_IDS[@]} -eq 0 ]; then
  TRACKER_IDS=(cam-left cam-right)
fi

WS_PORT=9000
UI_PORT=8090
HTTP_PORT=8080
COLLECTOR_URL="ws://localhost:${WS_PORT}"
OS_NAME="$(uname -s)"
if [ "$OS_NAME" = "Darwin" ]; then
  BROWSER_APP="${BROWSER_APP:-Safari}"
else
  BROWSER_APP="${BROWSER_APP:-}"
fi
OPEN_BROWSER=1

mkdir -p "$RUN_DIR"

PORT_GUARD_HINT="STOP_EXISTING=1 ./start_local_demo.sh ${TRACKER_IDS[*]}"
prepare_ports "local demo" "$WS_PORT" "$UI_PORT" "$HTTP_PORT"

# Ensure the project venv exists with all deps, then use its python ($PY)
source "$ROOT_DIR/venv.sh"

# Let the collector UI's "Stop servers" button take down this whole demo:
# with this flag, the hub stops its own process group (hub + tracker server +
# this script) on request. Without it (standalone launches) the hub only stops
# itself, so we never signal an unrelated process group.
export HUB_KILL_PROCESS_GROUP=1

# Ensure tracker dependencies exist
if [ ! -f "$TRACKER_DIR/lib/tf.min.js" ] || [ ! -f "$TRACKER_DIR/model/model.json" ] || [ ! -f "$TRACKER_DIR/lib/onnxruntime-web/ort.min.js" ]; then
  echo "⚠  Tracker dependencies not found. Running setup first..."
  (cd "$TRACKER_DIR" && bash setup.sh)
fi

PIDS=()
OPEN_PIDS=()
CLEANUP_DONE=0

kill_and_wait() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done

  kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    return 0
  fi
  CLEANUP_DONE=1
  trap - INT TERM EXIT

  echo ""
  echo "Stopping…"

  if [ ${#OPEN_PIDS[@]} -gt 0 ]; then
    for pid in "${OPEN_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi

  if [ ${#PIDS[@]} -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      kill_and_wait "$pid"
    done
  fi

  rm -f "$PID_FILE"
}

on_signal() {
  cleanup
  exit 0
}

on_exit() {
  cleanup
}

cleanup_previous_local_demo() {
  if [ -f "$PID_FILE" ]; then
    # shellcheck disable=SC1090
    source "$PID_FILE"
    if [ -n "${HUB_PID:-}" ] || [ -n "${TRACKER_PID:-}" ]; then
      echo "▸ Found a previous local demo instance. Cleaning it up first..."
      [ -n "${HUB_PID:-}" ] && kill_and_wait "$HUB_PID"
      [ -n "${TRACKER_PID:-}" ] && kill_and_wait "$TRACKER_PID"
    fi
    rm -f "$PID_FILE"
  fi

  # Safety net for orphaned listeners from prior local-demo launches.
  local hub_pid=""
  local tracker_pid=""
  hub_pid="$(lsof -tiTCP:${WS_PORT} -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  tracker_pid="$(lsof -tiTCP:${HTTP_PORT} -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"

  if [ -n "$hub_pid" ]; then
    local hub_cmd
    hub_cmd="$(ps -p "$hub_pid" -o command= 2>/dev/null || true)"
    if [[ "$hub_cmd" == *"hub.py"* ]]; then
      echo "▸ Stopping stale hub process on :${WS_PORT}"
      kill_and_wait "$hub_pid"
    fi
  fi

  if [ -n "$tracker_pid" ]; then
    local tracker_cmd
    tracker_cmd="$(ps -p "$tracker_pid" -o command= 2>/dev/null || true)"
    if [[ "$tracker_cmd" == *"tracker_server.py"* ]]; then
      echo "▸ Stopping stale tracker server on :${HTTP_PORT}"
      kill_and_wait "$tracker_pid"
    fi
  fi
}

wait_for_listen_port() {
  local port="$1"
  local name="$2"
  for _ in $(seq 1 60); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "✗ ${name} did not start listening on port ${port}."
  return 1
}

ensure_browser_available() {
  if [ "${NO_BROWSER:-0}" = "1" ]; then
    OPEN_BROWSER=0
    return
  fi

  if [ "$OS_NAME" = "Darwin" ]; then
    if ! osascript -e "id of application \"${BROWSER_APP}\"" >/dev/null 2>&1; then
      echo "✗ Browser app '${BROWSER_APP}' is not installed."
      echo "  Set BROWSER_APP to an installed app, e.g. Safari or Google Chrome."
      exit 1
    fi
    return
  fi

  # Linux/Jetson: prefer explicit BROWSER_APP command, else fallback to xdg-open.
  if [ -n "$BROWSER_APP" ] && command -v "$BROWSER_APP" >/dev/null 2>&1; then
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    BROWSER_APP="xdg-open"
    return
  fi

  OPEN_BROWSER=0
  echo "⚠  No browser launcher found (BROWSER_APP/xdg-open)."
  echo "   Services will still start; open these URLs manually:"
  echo "   - Collector: http://localhost:${UI_PORT}/collector.html"
  echo "   - Trackers:  http://localhost:${HTTP_PORT}/?id=<tracker-id>"
}

open_url() {
  local url="$1"
  if [ "$OS_NAME" = "Darwin" ]; then
    open -a "$BROWSER_APP" "$url" 2>/dev/null || true
  else
    "$BROWSER_APP" "$url" >/dev/null 2>&1 &
  fi
}

open_window_at_bounds() {
  local url="$1"
  local x1="$2"
  local y1="$3"
  local x2="$4"
  local y2="$5"

  if [ "$BROWSER_APP" = "Safari" ]; then
    osascript - "$url" "$x1" "$y1" "$x2" "$y2" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set theUrl to item 1 of argv
  set x1 to (item 2 of argv) as integer
  set y1 to (item 3 of argv) as integer
  set x2 to (item 4 of argv) as integer
  set y2 to (item 5 of argv) as integer

  tell application "Safari"
    activate
    make new document with properties {URL:theUrl}
    delay 0.15
    set bounds of front window to {x1, y1, x2, y2}
  end tell
end run
APPLESCRIPT
    return
  fi

  if [ "$BROWSER_APP" = "Google Chrome" ]; then
    osascript - "$url" "$x1" "$y1" "$x2" "$y2" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set theUrl to item 1 of argv
  set x1 to (item 2 of argv) as integer
  set y1 to (item 3 of argv) as integer
  set x2 to (item 4 of argv) as integer
  set y2 to (item 5 of argv) as integer

  tell application "Google Chrome"
    activate
    set w to make new window
    set URL of active tab of w to theUrl
    delay 0.15
    set bounds of w to {x1, y1, x2, y2}
  end tell
end run
APPLESCRIPT
    return
  fi

  # Generic fallback if AppleScript window placement isn't implemented.
  open_url "$url"
}

open_tiled_windows() {
  local bounds
  bounds="$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null || true)"
  if [ -z "$bounds" ]; then
    open_url "http://localhost:${UI_PORT}/collector.html"
    for id in "${TRACKER_IDS[@]}"; do
      open_url "http://localhost:${HTTP_PORT}/?id=${id}"
    done
    return
  fi

  local min_x min_y max_x max_y
  IFS=',' read -r min_x min_y max_x max_y <<< "$bounds"
  min_x="${min_x// /}"
  min_y="${min_y// /}"
  max_x="${max_x// /}"
  max_y="${max_y// /}"

  local screen_w=$((max_x - min_x))
  local screen_h=$((max_y - min_y))
  if [ "$screen_w" -lt 400 ] || [ "$screen_h" -lt 300 ]; then
    open_url "http://localhost:${UI_PORT}/collector.html"
    for id in "${TRACKER_IDS[@]}"; do
      open_url "http://localhost:${HTTP_PORT}/?id=${id}"
    done
    return
  fi

  local gutter=10
  local top_margin=34
  local usable_h=$((screen_h - 2 * top_margin))
  local window_h=$((screen_h * 74 / 100))
  if [ "$window_h" -gt "$usable_h" ]; then window_h="$usable_h"; fi
  if [ "$window_h" -gt 820 ]; then window_h=820; fi
  if [ "$window_h" -lt 560 ]; then window_h=560; fi
  local y_start=$((min_y + (screen_h - window_h) / 2))

  local collector_w=$((screen_w * 28 / 100))
  if [ "$collector_w" -lt 430 ]; then collector_w=430; fi
  if [ "$collector_w" -gt 560 ]; then collector_w=560; fi
  if [ "$collector_w" -gt $((screen_w - 320)) ]; then collector_w=$((screen_w - 320)); fi

  local collector_x1="$min_x"
  local collector_y1="$y_start"
  local collector_x2=$((collector_x1 + collector_w - gutter))
  local collector_y2=$((collector_y1 + window_h - gutter))

  open_window_at_bounds "http://localhost:${UI_PORT}/collector.html" "$collector_x1" "$collector_y1" "$collector_x2" "$collector_y2"

  local tracker_count=${#TRACKER_IDS[@]}
  if [ "$tracker_count" -eq 0 ]; then
    return
  fi

  local cols
  cols="$(awk -v n="$tracker_count" 'BEGIN { c = 1; while (c*c < n) c++; print c }')"
  local rows=$(((tracker_count + cols - 1) / cols))

  local tracker_x_start=$((collector_x2 + gutter))
  local tracker_w_total=$((max_x - tracker_x_start))
  local tracker_h_total="$window_h"
  local cell_w=$((tracker_w_total / cols))
  local cell_h=$((tracker_h_total / rows))
  if [ "$cell_w" -gt 620 ]; then cell_w=620; fi
  if [ "$cell_h" -gt 760 ]; then cell_h=760; fi

  local grid_w=$((cell_w * cols))
  local grid_h=$((cell_h * rows))
  local grid_x_start="$tracker_x_start"
  local grid_y_start="$y_start"
  if [ "$grid_w" -lt "$tracker_w_total" ]; then
    grid_x_start=$((tracker_x_start + (tracker_w_total - grid_w) / 2))
  fi
  if [ "$grid_h" -lt "$tracker_h_total" ]; then
    grid_y_start=$((y_start + (tracker_h_total - grid_h) / 2))
  fi

  local i=0
  for id in "${TRACKER_IDS[@]}"; do
    local row=$((i / cols))
    local col=$((i % cols))

    local x1=$((grid_x_start + col * cell_w))
    local y1=$((grid_y_start + row * cell_h))
    local x2=$((x1 + cell_w - gutter))
    local y2=$((y1 + cell_h - gutter))

    open_window_at_bounds "http://localhost:${HTTP_PORT}/?id=${id}" "$x1" "$y1" "$x2" "$y2"
    i=$((i + 1))
  done
}

trap on_signal INT TERM
trap on_exit EXIT

cleanup_previous_local_demo
ensure_browser_available

# 1) Collector hub (serves UI on :8090 and routes WS on :9000)
echo "▸ Collector hub  : ws://localhost:${WS_PORT}  |  UI http://localhost:${UI_PORT}/collector.html"
(cd "$COLLECTOR_DIR" && exec "$PY" hub.py) &
PIDS+=($!)
HUB_PID=${PIDS[0]}

# 2) Tracker page server (serves files + persists config on "save defaults")
echo "▸ Tracker server : http://localhost:${HTTP_PORT}"
(cd "$TRACKER_DIR" && exec "$PY" tracker_server.py "$HTTP_PORT") &
PIDS+=($!)
TRACKER_PID=${PIDS[1]}

cat >"$PID_FILE" <<EOF
HUB_PID=$HUB_PID
TRACKER_PID=$TRACKER_PID
EOF

wait_for_listen_port "$WS_PORT" "Collector hub"
wait_for_listen_port "$UI_PORT" "Collector UI"
wait_for_listen_port "$HTTP_PORT" "Tracker server"

echo ""
echo "  Opening collector UI and ${#TRACKER_IDS[@]} tracker window(s): ${TRACKER_IDS[*]}"
echo "  Each tracker reads its camera + settings from trackers/<id>.json."
echo "  If a tracker grabbed the wrong camera, edit that file or use the dropdown."
if [ "$OPEN_BROWSER" -eq 1 ]; then
  echo "  Browser app: ${BROWSER_APP} (separate windows, tiled layout when supported)."
else
  echo "  Browser auto-open: disabled"
  echo "  Open manually: http://localhost:${UI_PORT}/collector.html"
fi
echo "  Press Ctrl-C to stop everything."
echo ""

# 3) Open windows (collector first, then one tracker window per id) and tile them.
if [ "$OPEN_BROWSER" -eq 1 ]; then
  open_tiled_windows
fi

while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo ""
      echo "✗ A required service stopped unexpectedly. Shutting down remaining services."
      exit 1
    fi
  done
  sleep 1
done
