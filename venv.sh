#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# venv.sh — Shared helper. Ensures the project-local .venv exists with all
# Python deps from requirements.txt, then exports $PY pointing at its python.
#
# Source it from any launch script:
#     source "<repo-root>/venv.sh"
#     "$PY" hub.py
# ─────────────────────────────────────────────────────────────────────────────

# Repo root = directory containing this file
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$REPO_ROOT/.venv"
PY="$VENV_DIR/bin/python3"

if [ ! -x "$PY" ]; then
  echo "▸ Creating virtual environment in .venv ..."
  python3 -m venv "$VENV_DIR"
fi

# Install / update dependencies (fast no-op once satisfied)
"$PY" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
"$PY" -m pip install --quiet -r "$REPO_ROOT/requirements.txt"

export PY REPO_ROOT
