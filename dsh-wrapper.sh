#!/bin/bash
# DSH auto-restart wrapper
# Usage: ./dsh-wrapper.sh
# Stop: Ctrl+C or kill this script's PID

DSH_BIN="/home/zhengsaisi/.nvm/versions/node/v22.22.3/bin/dsh"
DSH_ARGS="web --port 7738 --trusted-host dsh.saisi.online"

echo "[wrapper] DSH wrapper started (PID: $$)"
echo "[wrapper] Press Ctrl+C to stop"

trap 'echo "[wrapper] Stopped by user"; exit 0' INT TERM

while true; do
    echo "[wrapper] Starting DSH at $(date)"
    $DSH_BIN $DSH_ARGS
    EXIT_CODE=$?
    echo "[wrapper] DSH exited with code $EXIT_CODE at $(date)"

    if [ $EXIT_CODE -eq 0 ]; then
        # Normal exit (e.g. killed by the restart_dsh tool): restart after 2 seconds
        echo "[wrapper] Restarting in 2 seconds..."
        sleep 2
    else
        # Abnormal exit: wait 5 seconds before restarting to avoid a restart loop
        echo "[wrapper] Abnormal exit, waiting 5 seconds..."
        sleep 5
    fi
done
