#!/bin/sh
# entrypoint.sh — NanoClaw container entrypoint
# Starts healthcheck server + NanoClaw, handles graceful shutdown.

set -e

NANOCLAW_PID=""
SHUTTING_DOWN=0

cleanup() {
  if [ "$SHUTTING_DOWN" = "1" ]; then
    return
  fi
  SHUTTING_DOWN=1
  echo "[entrypoint] Received shutdown signal, grace period 30s..."

  if [ -n "$NANOCLAW_PID" ] && kill -0 "$NANOCLAW_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping NanoClaw (PID $NANOCLAW_PID)..."
    kill -TERM "$NANOCLAW_PID" 2>/dev/null || true

    WAIT_COUNT=0
    while kill -0 "$NANOCLAW_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 25 ]; do
      sleep 1
      WAIT_COUNT=$((WAIT_COUNT + 1))
    done
    if kill -0 "$NANOCLAW_PID" 2>/dev/null; then
      echo "[entrypoint] Force killing NanoClaw..."
      kill -9 "$NANOCLAW_PID" 2>/dev/null || true
    fi
  fi

  echo "[entrypoint] Shutdown complete"
  exit 0
}

trap cleanup TERM INT QUIT

echo "[entrypoint] Starting NanoClaw pod"
echo "[entrypoint] User ID: ${NANOCLAW_USER_ID:-unknown}"

# 1. Set up writable working directory
mkdir -p /data/store /data/groups /data/data /data/.claude 2>/dev/null || true

# 2. Symlink Claude Code config to persistent volume
ln -sfn /data/.claude /home/nanoclaw/.claude 2>/dev/null || true

# 3. Start NanoClaw (it has its own HTTP health endpoint on port 4000)
echo "[entrypoint] Starting NanoClaw..."
cd /data
HTTP_WEBHOOK_ENABLED=true exec node /app/dist/index.js
