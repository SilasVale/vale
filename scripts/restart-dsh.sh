#!/bin/bash
# Restart DSH (DeepSeek Harness) with the same arguments
# Usage: ./scripts/restart-dsh.sh

set -e

DSH_BIN="/home/zhengsaisi/.nvm/versions/node/v22.22.3/bin/dsh"
DSH_ARGS="web --port 7738 --trusted-host dsh.saisi.online"

# Find and kill existing DSH process
PID=$(pgrep -f "node.*dsh web" | head -1)
if [ -n "$PID" ]; then
    echo "Stopping DSH (PID: $PID)..."
    kill "$PID" 2>/dev/null || true
    # Wait for process to exit
    for i in $(seq 1 10); do
        if ! kill -0 "$PID" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done
    # Force kill if still running
    if kill -0 "$PID" 2>/dev/null; then
        echo "Force killing DSH..."
        kill -9 "$PID" 2>/dev/null || true
        sleep 1
    fi
    echo "DSH stopped."
else
    echo "No DSH process found."
fi

# Start DSH in background
echo "Starting DSH..."
nohup "$DSH_BIN" $DSH_ARGS > /tmp/dsh.log 2>&1 &
NEW_PID=$!
echo "DSH started (PID: $NEW_PID)"
echo "Logs: tail -f /tmp/dsh.log"

# Wait a moment and verify
sleep 2
if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "DSH is running."
else
    echo "ERROR: DSH failed to start. Check /tmp/dsh.log"
    exit 1
fi
