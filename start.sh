#!/usr/bin/env bash
# MapReduce Shuffle 动画演示 —— 一键启动脚本
# 用法:
#   bash start.sh              # 默认：安装依赖(如需) + 构建 + 预览 (http://localhost:4180)
#   bash start.sh dev          # 开发模式 (http://localhost:5180)
#   bash start.sh build        # 仅构建 dist/
#   bash start.sh preview-only # 直接预览已有 dist/（不重新构建）
#   bash start.sh check        # 运行内核正确性校验
set -euo pipefail

PORT=4180
MODE="${1:-preview}"

# 切换到脚本所在目录，无论从哪里调用都能正确运行
cd "$(dirname "$0")"

echo "[mr-shuffle] 检查依赖 node_modules ..."
if [ ! -d node_modules ]; then
  echo "[mr-shuffle] 首次运行，安装依赖 (npm install) ..."
  npm install --no-audit --no-fund
fi

case "$MODE" in
  dev)
    echo "[mr-shuffle] 启动开发服务器 -> http://localhost:5180"
    npm run dev
    ;;
  build)
    echo "[mr-shuffle] 构建生产产物 ..."
    npm run build
    ;;
  preview-only)
    echo "[mr-shuffle] 预览已有产物 -> http://localhost:$PORT"
    npm run preview -- --port "$PORT" --strictPort
    ;;
  check)
    echo "[mr-shuffle] 运行内核校验 ..."
    npm run check
    ;;
  preview|*)
    echo "[mr-shuffle] 构建生产产物 ..."
    npm run build
    echo "[mr-shuffle] 预览演示 -> http://localhost:$PORT"
    npm run preview -- --port "$PORT" --strictPort
    ;;
esac
