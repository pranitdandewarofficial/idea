#!/usr/bin/env bash
# Run the whole product locally: FastAPI on 127.0.0.1:8000, Vite on :5173.
# The API stays localhost-only by design; the browser talks only to Vite, which
# proxies /api and /ws. Ctrl-C stops both.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_HOST="${PRANIT_HOST:-127.0.0.1}"
BACKEND_PORT="${PRANIT_PORT:-8000}"
FRONTEND_PORT="${PORT:-5173}"

[ -x backend/.venv/bin/python ] || {
  echo "!! backend/.venv is missing. Run ./scripts/setup.sh first."
  exit 1
}
[ -d frontend/node_modules ] || {
  echo "!! frontend/node_modules is missing. Run ./scripts/setup.sh first."
  exit 1
}

# Load backend/.env if present (values already in the environment win).
if [ -f backend/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . backend/.env
  set +a
fi

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Backend  http://${BACKEND_HOST}:${BACKEND_PORT}  (localhost only)"
(cd backend && exec .venv/bin/python -m uvicorn app.main:app \
    --host "$BACKEND_HOST" --port "$BACKEND_PORT" --log-level info) &
PIDS+=("$!")

# Wait for the API before starting the UI, so the first page load succeeds.
for _ in $(seq 1 60); do
  if curl -sf "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "==> Frontend http://localhost:${FRONTEND_PORT}"
(cd frontend && exec ./node_modules/.bin/vite --host 0.0.0.0 --port "$FRONTEND_PORT") &
PIDS+=("$!")

TOKEN_FILE="backend/.data/api_token"
if [ -f "$TOKEN_FILE" ]; then
  echo
  echo "    API token (also on the Settings screen): $(cat "$TOKEN_FILE")"
fi
echo
echo "    Open http://localhost:${FRONTEND_PORT} - Ctrl-C stops both processes."

wait
