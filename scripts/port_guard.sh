#!/bin/bash
# Shared helpers for checking local demo ports before starting servers.

port_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
}

describe_ports() {
  local found=0
  local port pids pid
  for port in "$@"; do
    pids="$(port_pids "$port")"
    if [ -n "$pids" ]; then
      found=1
      echo "Port $port is already in use:"
      for pid in $pids; do
        ps -p "$pid" -o pid=,ppid=,command= 2>/dev/null | sed 's/^/  /'
      done
    fi
  done
  return "$found"
}

stop_ports() {
  local port pid pids all_pids=()
  for port in "$@"; do
    pids="$(port_pids "$port")"
    for pid in $pids; do
      all_pids+=("$pid")
    done
  done

  if [ ${#all_pids[@]} -eq 0 ]; then
    return 0
  fi

  echo "▸ Stopping existing process(es) on port(s): $*"
  for pid in "${all_pids[@]}"; do
    echo "  kill $pid"
    kill "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in "${all_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  kill -9 $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

require_free_ports() {
  local label="$1"
  shift
  if describe_ports "$@"; then
    return 0
  fi

  echo ""
  echo "Cannot start $label because one or more required ports are already in use."
  echo "Run with STOP_EXISTING=1 to stop the existing listener(s) first, for example:"
  echo "  ${PORT_GUARD_HINT:-STOP_EXISTING=1 $0}"
  echo ""
  return 1
}

prepare_ports() {
  local label="$1"
  shift
  if [ "${STOP_EXISTING:-0}" = "1" ]; then
    stop_ports "$@"
  fi
  require_free_ports "$label" "$@"
}