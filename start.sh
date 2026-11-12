#!/usr/bin/env bash
set -euo pipefail

# 切换到项目根目录
cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd -P)"
source ./scripts/service-process.sh

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-3210}"
URL="http://127.0.0.1:${PORT}"

if ! workbench_valid_port "$PORT"; then
  echo "错误：PORT 必须是 1～65535 的端口号。"
  exit 1
fi

echo "======================================"
echo "  砚台 · LaTeX 写作台"
echo "======================================"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 Node.js，请先安装 Node.js。"
  exit 1
fi

if ! command -v tectonic >/dev/null 2>&1; then
  echo "提示：未检测到 tectonic，PDF 编译功能需要安装 tectonic（如 brew install tectonic）。"
fi

# 首次运行或缺少依赖时自动安装
if [ ! -d "node_modules" ]; then
  echo "正在安装项目依赖 (npm install)..."
  npm install
fi

# 缺少构建产物或源码有更新时自动重新构建
NEED_BUILD=0
if [ ! -f "dist/index.html" ]; then
  NEED_BUILD=1
elif [ -n "$(find src index.html package.json -newer dist/index.html 2>/dev/null)" ]; then
  NEED_BUILD=1
fi

if [ "${NEED_BUILD}" -eq 1 ]; then
  echo "正在构建前端界面 (npm run build)..."
  npm run build
fi

# 复用当前仓库的服务；其他程序占用端口时明确报错。
PIDS="$(workbench_listener_pids "$PORT")"
if [ -n "$PIDS" ]; then
  for pid in $PIDS; do
    if ! workbench_owns_process "$pid" "$PROJECT_ROOT"; then
      echo "错误：端口 ${PORT} 被其他程序占用，请改用其他 PORT。"
      exit 1
    fi
  done
  echo "砚台已在运行，正在打开浏览器：${URL}"
  echo "此窗口没有新启动服务；关闭网页或此窗口不会停止原服务。"
  echo "要停止服务，请双击「停止砚台.command」或运行 ./stop.sh。"
  open "${URL}" >/dev/null 2>&1 || true
  exit 0
fi

# 后台等待服务就绪后自动打开浏览器
(
  for _ in $(seq 1 40); do
    if curl -s "${URL}/api/status" >/dev/null 2>&1; then
      open "${URL}" >/dev/null 2>&1 || true
      exit 0
    fi
    sleep 0.15
  done
) &

echo "正在启动本地服务：${URL}"
echo "停止服务：在此终端按 Control+C，或双击「停止砚台.command」。"
echo "关闭浏览器页面不会停止服务；停止前请保存文档。"
exec env PORT="${PORT}" node server/index.mjs
