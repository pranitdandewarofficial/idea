#!/usr/bin/env bash
# One-shot install for Ubuntu 22.04 / 24.04 (also fine on Debian 12+).
# Idempotent: safe to re-run. Never needs sudo after the first apt step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-npm}"

echo "==> Repository: $REPO_ROOT"

# --- python ---------------------------------------------------------------
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "!! $PYTHON_BIN not found. Install it first:"
  echo "     sudo apt update && sudo apt install -y python3 python3-venv python3-pip"
  exit 1
fi

PY_VERSION="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "==> Python $PY_VERSION"
"$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || {
  echo "!! Python 3.11+ is required (found $PY_VERSION)."
  echo "     sudo apt install -y python3.11 python3.11-venv"
  exit 1
}

if ! "$PYTHON_BIN" -c 'import venv' >/dev/null 2>&1; then
  echo "!! The venv module is missing:  sudo apt install -y python3-venv"
  exit 1
fi

echo "==> Creating backend/.venv and installing dependencies"
[ -d backend/.venv ] || "$PYTHON_BIN" -m venv backend/.venv
backend/.venv/bin/pip install --quiet --upgrade pip
backend/.venv/bin/pip install --quiet -r backend/requirements.txt

# --- node -----------------------------------------------------------------
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "!! npm not found. Install Node 20+ first:"
  echo "     curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "     sudo apt install -y nodejs"
  exit 1
fi

echo "==> Node $(node --version), npm $($NODE_BIN --version)"
echo "==> Installing frontend dependencies"
(cd frontend && $NODE_BIN install --no-audit --no-fund)

# --- environment ----------------------------------------------------------
if [ ! -f backend/.env ]; then
  cp .env.example backend/.env
  echo "==> Created backend/.env from .env.example (all defaults are the safe ones)"
fi

echo
echo "==> Done. Next:"
echo "     ./scripts/dev.sh            # backend on :8000 + UI on :5173"
echo "     ./scripts/test.sh           # 186 backend tests + 99 frontend tests"
echo
echo "    Then open http://localhost:5173 and read the readiness checklist."
