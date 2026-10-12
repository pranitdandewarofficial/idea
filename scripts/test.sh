#!/usr/bin/env bash
# Run every automated check in the repository and print one honest summary.
#   ./scripts/test.sh            backend + frontend
#   ./scripts/test.sh backend    backend only
#   ./scripts/test.sh frontend   frontend only
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WHICH="${1:-all}"
BACKEND_RC=0
FRONTEND_RC=0
TYPECHECK_RC=0
BUILD_RC=0

if [ "$WHICH" = "all" ] || [ "$WHICH" = "backend" ]; then
  echo "==================== backend: pytest ===================="
  if [ ! -x backend/.venv/bin/python ]; then
    echo "!! backend/.venv missing - run ./scripts/setup.sh" >&2
    BACKEND_RC=1
  else
    (cd backend && .venv/bin/python -m pytest tests/ -q) || BACKEND_RC=$?
  fi
fi

if [ "$WHICH" = "all" ] || [ "$WHICH" = "frontend" ]; then
  echo
  echo "==================== frontend: tsc ======================"
  if [ ! -d frontend/node_modules ]; then
    echo "!! frontend/node_modules missing - run ./scripts/setup.sh" >&2
    TYPECHECK_RC=1
    FRONTEND_RC=1
  else
    (cd frontend && ./node_modules/.bin/tsc -b --noEmit) || TYPECHECK_RC=$?

    echo
    echo "==================== frontend: vitest ===================="
    (cd frontend && ./node_modules/.bin/vitest run) || FRONTEND_RC=$?

    echo
    echo "==================== frontend: build ====================="
    (cd frontend && ./node_modules/.bin/vite build) || BUILD_RC=$?
  fi
fi

echo
echo "==================== summary ===================="
printf 'backend pytest      : %s\n' "$([ "$BACKEND_RC" -eq 0 ] && echo PASS || echo "FAIL ($BACKEND_RC)")"
if [ "$WHICH" = "all" ] || [ "$WHICH" = "frontend" ]; then
  printf 'frontend typecheck  : %s\n' "$([ "$TYPECHECK_RC" -eq 0 ] && echo PASS || echo "FAIL ($TYPECHECK_RC)")"
  printf 'frontend vitest     : %s\n' "$([ "$FRONTEND_RC" -eq 0 ] && echo PASS || echo "FAIL ($FRONTEND_RC)")"
  printf 'frontend build      : %s\n' "$([ "$BUILD_RC" -eq 0 ] && echo PASS || echo "FAIL ($BUILD_RC)")"
fi

[ "$BACKEND_RC" -eq 0 ] && [ "$FRONTEND_RC" -eq 0 ] && [ "$TYPECHECK_RC" -eq 0 ] && [ "$BUILD_RC" -eq 0 ]
