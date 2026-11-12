#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd -P)"
source ./scripts/service-process.sh
PORT="${PORT:-3210}"

if ! workbench_valid_port "$PORT"; then
  echo "错误：PORT 必须是 1～65535 的端口号。"
  exit 1
fi

PIDS="$(workbench_listener_pids "$PORT")"
if [ -z "$PIDS" ]; then
  echo "砚台服务未运行（端口 ${PORT}），无需停止。"
  exit 0
fi

# 先检查全部进程，避免停止同一端口上的其他程序。
for pid in $PIDS; do
  if ! workbench_owns_process "$pid" "$PROJECT_ROOT"; then
    echo "端口 ${PORT} 被其他程序占用；未停止任何进程。"
    exit 1
  fi
done

for pid in $PIDS; do
  kill -TERM "$pid" 2>/dev/null || true
done

for (( attempt = 0; attempt < 50; attempt++ )); do
  STILL_RUNNING=0
  for pid in $PIDS; do
    if workbench_owns_process "$pid" "$PROJECT_ROOT"; then
      STILL_RUNNING=1
    fi
  done
  if [ "$STILL_RUNNING" -eq 0 ]; then
    echo "已停止砚台服务（端口 ${PORT}）。"
    exit 0
  fi
  sleep 0.1
done

echo "服务尚未退出，请查看启动终端；未强制结束进程。"
exit 1
