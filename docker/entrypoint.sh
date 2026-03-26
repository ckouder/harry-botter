#!/bin/sh
# entrypoint.sh — NanoClaw container entrypoint
# Starts healthcheck server + NanoClaw, handles graceful shutdown.

set -e

HEALTHCHECK_PID=""
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
  fi

  if [ -n "$HEALTHCHECK_PID" ] && kill -0 "$HEALTHCHECK_PID" 2>/dev/null; then
    kill -TERM "$HEALTHCHECK_PID" 2>/dev/null || true
  fi

  # Wait up to 25s for NanoClaw to exit gracefully
  if [ -n "$NANOCLAW_PID" ]; then
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

  if [ -n "$HEALTHCHECK_PID" ] && kill -0 "$HEALTHCHECK_PID" 2>/dev/null; then
    kill -9 "$HEALTHCHECK_PID" 2>/dev/null || true
  fi

  echo "[entrypoint] Shutdown complete"
  exit 0
}

trap cleanup TERM INT QUIT

echo "[entrypoint] Starting NanoClaw pod"
echo "[entrypoint] User ID: ${NANOCLAW_USER_ID:-unknown}"

# 1. Start healthcheck server in background
echo "[entrypoint] Starting healthcheck server..."
node /opt/nanoclaw/healthcheck-server.js &
HEALTHCHECK_PID=$!

# 2. Ensure writable directories (rootfs is read-only, /data is writable)
mkdir -p /data/nanoclaw /data/store /data/groups /data/data 2>/dev/null || true

# 3. Symlink NanoClaw's writable dirs from /app to /data
ln -sfn /data/store /app/store 2>/dev/null || true
ln -sfn /data/groups /app/groups 2>/dev/null || true
ln -sfn /data/data /app/data 2>/dev/null || true

# 4. Start NanoClaw
echo "[entrypoint] Starting NanoClaw..."
cd /app
node dist/index.js &
NANOCLAW_PID=$!
echo "[entrypoint] NanoClaw PID: $NANOCLAW_PID"

# 4. Wait for any child to exit
wait -n "$NANOCLAW_PID" "$HEALTHCHECK_PID" 2>/dev/null || true
EXIT_CODE=$?

if [ "$SHUTTING_DOWN" = "0" ]; then
  echo "[entrypoint] Child process exited unexpectedly (code: $EXIT_CODE)"
  cleanup
fi

exit "$EXIT_CODE"
