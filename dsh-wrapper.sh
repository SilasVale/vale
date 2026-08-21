#!/bin/bash
# DSH 自动重启脚本
# 用法: ./dsh-wrapper.sh
# 停止: Ctrl+C 或 kill 这个脚本的 PID

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
        # 正常退出（比如被 restart_dsh 工具 kill），2秒后重启
        echo "[wrapper] Restarting in 2 seconds..."
        sleep 2
    else
        # 异常退出，等5秒再重启，避免疯狂重启
        echo "[wrapper] Abnormal exit, waiting 5 seconds..."
        sleep 5
    fi
done
