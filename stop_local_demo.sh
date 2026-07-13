#!/bin/bash
# Stop local demo servers listening on the default demo ports.
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$ROOT_DIR/scripts/port_guard.sh"

PORTS=(9000 8090 8080)

if describe_ports "${PORTS[@]}"; then
  echo "No local demo listeners found on ${PORTS[*]}."
  exit 0
fi

stop_ports "${PORTS[@]}"

if describe_ports "${PORTS[@]}"; then
  echo "Stopped local demo listeners."
else
  echo "Some listeners are still running; inspect the process list above."
  exit 1
fi