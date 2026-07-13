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

fail_with_message() {
  echo ""
  echo "✗ Could not create Python virtual environment (.venv)."
  echo "  This usually means Python venv/ensurepip support is missing on this system."
  echo ""
  echo "  On Ubuntu/Jetson, install it with:"
  echo "    sudo apt update"
  echo "    sudo apt install -y python3-venv"
  echo ""
  echo "  If your distro uses versioned packages, try (example):"
  echo "    sudo apt install -y python3.10-venv"
  echo ""
  echo "  Then re-run the same command."
  return 1 2>/dev/null || exit 1
}

pip_missing_message() {
  echo ""
  echo "✗ Virtual environment exists but pip is missing inside .venv."
  echo "  This system likely lacks ensurepip/pip support for this Python build."
  echo ""
  echo "  On Ubuntu/Jetson, install:"
  echo "    sudo apt update"
  echo "    sudo apt install -y python3-venv python3-pip"
  echo ""
  echo "  If you use versioned Python packages, try (example):"
  echo "    sudo apt install -y python3.10-venv python3-pip"
  echo ""
  echo "  Then recreate the venv and retry:"
  echo "    rm -rf .venv"
  echo "    source venv.sh"
  return 1 2>/dev/null || exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found. Install Python 3 first."
  return 1 2>/dev/null || exit 1
fi

if [ ! -x "$PY" ]; then
  echo "▸ Creating virtual environment in .venv ..."
  if ! python3 -m venv "$VENV_DIR"; then
    fail_with_message
  fi
fi

# Some distro Python builds can create a venv without pip. Try to bootstrap it.
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "▸ pip missing in .venv, attempting bootstrap with ensurepip ..."
  if ! "$PY" -m ensurepip --upgrade >/dev/null 2>&1; then
    pip_missing_message
  fi
fi

if ! "$PY" -m pip --version >/dev/null 2>&1; then
  pip_missing_message
fi

# Install / update dependencies (fast no-op once satisfied)
"$PY" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
"$PY" -m pip install --quiet -r "$REPO_ROOT/requirements.txt"

export PY REPO_ROOT
