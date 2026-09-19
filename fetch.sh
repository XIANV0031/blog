#!/usr/bin/env bash
# 境外 GBB/AEG 简报 —— 每日采集脚本
#
# 作用：探测代理 → 采集 Reddit RSS + 境外媒体 → 输出原始素材
# 输出的文件供 AI 读取后撰写简报
#
# 用法：bash fetch.sh [输出目录]
#       默认输出到 /d/blog-hugo/.cache/fetch
#
# 前置：Clash Verge 需运行（端口 127.0.0.1:7897）
#
# ⚠️ 两个关键实现约束（踩过坑，勿改）：
#   1. 必须用 shell 重定向 `>` 落盘，不能用 `curl -o`。
#      沙箱会拦截 curl 的写文件操作，报错伪装成 "No such file or directory"。
#   2. 采集目录不要用 /tmp，用 Windows 临时目录或站点内 .cache。

set -uo pipefail

PORT=7897
OUT_DIR="${1:-/d/blog-hugo/.cache/fetch}"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# ---------- 1. 代理探活 ----------
echo "[1/4] 探测代理端口 $PORT ..."
if ! timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
  echo "ERROR: 代理端口 $PORT 未开放。"
  echo "      请确认 Clash Verge 正在运行。本次采集取消。"
  exit 2
fi
echo "      OK，代理可用"

PROXY="http://127.0.0.1:$PORT"
mkdir -p "$OUT_DIR" || { echo "ERROR: 无法创建目录 $OUT_DIR"; exit 1; }

# 统一的抓取函数：用重定向落盘，回显 HTTP 码与字节数
# 关键：`-w` 输出到 stderr（2>file），body 走 stdout 重定向到目标文件，两者分流。
# 沙箱下 `curl -o` 不可靠，所以 body 必须用 shell 重定向。
fetch() {
  local url="$1" out="$2" label="$3"
  local tmp code size
  tmp="$OUT_DIR/.code.$$"
  # body → $out（stdout 重定向，沙箱可用）
  # 状态码 → $tmp（%{stderr} 前缀 + fd2 重定向，与 body 完全分流）
  curl -sS -L -m 30 -A "$UA" -x "$PROXY" \
       --write-out '%{stderr}%{http_code}' \
       "$url" > "$out" 2> "$tmp"
  code=$(tr -dc '0-9' < "$tmp" 2>/dev/null)
  rm -f "$tmp"
  size=$(wc -c < "$out" 2>/dev/null | tr -d ' ')
  echo "      $label -> HTTP ${code:-?}, ${size:-0} bytes"
  [ "$code" = "429" ] && echo "      (被限流，稍后重试)"
  return 0
}

# ---------- 2. 采集 Reddit（必须串行 + 间隔 ≥25s） ----------
echo "[2/4] 采集 Reddit（串行，间隔 25s，避免 429）..."
# top/day 是质量最高的当日热门；r/airsoft 为主力源
SUBS=("airsoft" "GBBR" "airsoftmarket")
for sub in "${SUBS[@]}"; do
  fetch "https://www.reddit.com/r/$sub/top/.rss?t=day" "$OUT_DIR/$sub.rss" "r/$sub"
  sleep 25
done

# 追加一份 airsoft 最新流（间隔已足够）
fetch "https://www.reddit.com/r/airsoft/new/.rss" "$OUT_DIR/airsoft-new.rss" "r/airsoft/new"
sleep 25

# ---------- 3. 采集境外媒体 ----------
echo "[3/4] 采集境外媒体..."
# Popular Airsoft 是 Drupal 站：/rss.xml 才是真 feed（/feed 返回网页）
fetch "https://www.popularairsoft.com/rss.xml" "$OUT_DIR/popularairsoft.xml" "popularairsoft"
fetch "https://www.hyperdouraku.com/" "$OUT_DIR/hyperdouraku.html" "hyperdouraku"

# ---------- 4. 汇总 ----------
echo "[4/4] 采集完成。素材目录：$OUT_DIR"
echo
echo "--- 素材清单 ---"
for f in "$OUT_DIR"/*; do
  [ -f "$f" ] && echo "  $(basename "$f"): $(wc -c < "$f" | tr -d ' ') bytes"
done
echo
echo "下一步：读取素材撰写简报 markdown 到 content/posts/，然后运行 publish.sh"

# 退出码约定：
#   0 = 正常（即使部分源失败，只要主力源有数据）
#   2 = 代理未开，任务应中止
exit 0
