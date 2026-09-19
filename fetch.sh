#!/usr/bin/env bash
# 境外 GBB/AEG 简报 —— 每日采集脚本
#
# 作用：探测代理 → 采集 Reddit RSS + 境外媒体 → 输出原始素材
# 输出的 .rss 文件供 AI 读取后撰写简报
#
# 用法：bash fetch.sh [输出目录]
#
# 前置：Clash Verge 需运行（端口 127.0.0.1:7897）

set -uo pipefail

PORT=7897
OUT_DIR="${1:-/d/blog-hugo/.cache/fetch}"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# ---------- 1. 代理探活 ----------
echo "[1/3] 探测代理端口 $PORT ..."
if ! timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
  echo "ERROR: 代理端口 $PORT 未开放。"
  echo "      请确认 Clash Verge 正在运行。本次采集取消。"
  exit 2
fi
echo "      OK，代理可用"

export http_proxy="http://127.0.0.1:$PORT"
export https_proxy="http://127.0.0.1:$PORT"

mkdir -p "$OUT_DIR"

# ---------- 2. 采集 Reddit（必须串行 + 间隔） ----------
echo "[2/3] 采集 Reddit（串行，间隔 18s，避免 429）..."
SUBS=("airsoft" "GasBlowBack" "airsoftmarket")
for sub in "${SUBS[@]}"; do
  code=$(curl -sS -L -m 30 -A "$UA" \
    "https://www.reddit.com/r/$sub/.rss" -o "$OUT_DIR/$sub.rss" \
    -w "%{http_code}" 2>/dev/null)
  size=$(stat -c %s "$OUT_DIR/$sub.rss" 2>/dev/null || echo 0)
  echo "      r/$sub -> HTTP $code, $size bytes"
  # 最后一个不用等
  [ "$sub" != "${SUBS[-1]}" ] && sleep 18
done

# ---------- 3. 采集境外媒体 ----------
echo "[3/3] 采集境外媒体..."
declare -A MEDIA=(
  ["popularairsoft"]="https://www.popularairsoft.com/"
  ["hyperdouraku"]="https://www.hyperdouraku.com/"
)
for name in "${!MEDIA[@]}"; do
  code=$(curl -sS -L -m 30 -A "$UA" "${MEDIA[$name]}" \
    -o "$OUT_DIR/$name.html" -w "%{http_code}" 2>/dev/null)
  size=$(stat -c %s "$OUT_DIR/$name.html" 2>/dev/null || echo 0)
  echo "      $name -> HTTP $code, $size bytes"
done

echo
echo "采集完成。素材目录：$OUT_DIR"
echo "下一步：读取素材，撰写简报 markdown 到 content/posts/，然后运行 publish.sh"
