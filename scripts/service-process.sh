#!/usr/bin/env bash

# 供启动和停止脚本共用；只识别当前仓库启动的 Node 服务。
workbench_valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

workbench_listener_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

workbench_owns_process() {
  local pid="$1" root="$2" process_cwd process_command
  process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$process_cwd" = "$root" ] || return 1
  process_command="$(ps -p "$pid" -o command=)" || return 1
  case "$process_command" in
    "node server/index.mjs"|*/node\ server/index.mjs|"node $root/server/index.mjs"|*/node\ "$root/server/index.mjs") return 0 ;;
    *) return 1 ;;
  esac
}
