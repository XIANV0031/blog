#!/usr/bin/env bash
# 境外 GBB/AEG 简报 —— 每日采集脚本
#
# 作用：探测代理 → 采集 Reddit RSS + 境外媒体 → 输出原始素材
# 输出的文件供 AI 读取后撰写简报
#
# 用法：bash fetch.sh [输出目录]
#       默认输出到 /d/blog-hugo/.cache/fetch
#
# 产物：
#   *.rss / *.xml / *.html  原始素材（供 AI 读取撰写简报）
#   pa_official/*.jpg       **官方贴题配图**（Popular Airsoft 官方产品图，首选）
#                            —— 封面 与 正文插图 共用此图池
#   covers-map.json         标题 → 配图 映射表（含置信度，供选图参考）
#   covers/cover-NN.jpg     Reddit 兜底图（官方源不可用时使用）
#
# 前置：Clash Verge 需运行（端口 127.0.0.1:7897）
# 可选：环境变量 PYBIN 指向 Python 解释器（用于官方图语义匹配）。
#       未设置时自动探测常见路径，全部失败则跳过轨 1。
#
# ⚠️ 两个关键实现约束（踩过坑，勿改）：
#   1. 必须用 shell 重定向 `>` 落盘，不能用 `curl -o`。
#      沙箱会拦截 curl 的写文件操作，报错伪装成 "No such file or directory"。
#   2. 采集目录不要用 /tmp，用 Windows 临时目录或站点内 .cache。

set -uo pipefail

PORT=7897
OUT_DIR="${1:-/d/blog-hugo/.cache/fetch}"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# Python 解释器自动探测（用于封面语义匹配；找不到不影响主流程）
if [ -z "${PYBIN:-}" ]; then
  for cand in \
    "/c/Users/Administrator/.workbuddy/binaries/python/envs/default/python.exe" \
    "/c/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
    "/c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
    "$(command -v python3 2>/dev/null)" \
    "$(command -v python 2>/dev/null)"
  do
    [ -n "$cand" ] && [ -x "$cand" ] && PYBIN="$cand" && break
  done
fi

# ⚠️ MSYS 路径 → Windows 原生路径
#    Python / hugo 都是 Windows 程序，不认 `/d/blog-hugo/xxx` 这种 MSYS 风格路径
#    （会报 FileNotFoundError，且路径被解析成 `D:\d\blog-hugo\...`）。
#    cygpath 在 Git Bash 下可用；不可用时退化为手动替换。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    # 手动：/d/foo/bar -> D:\foo\bar
    echo "$1" | sed -E 's|^/([a-zA-Z])/|\1:/|' | tr '/' '\\'
  fi
}

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
echo "[3/5] 采集境外媒体..."
# Popular Airsoft 是 Drupal 站：/rss.xml 才是真 feed（/feed 返回网页）
fetch "https://www.popularairsoft.com/rss.xml" "$OUT_DIR/popularairsoft.xml" "popularairsoft"
fetch "https://www.hyperdouraku.com/" "$OUT_DIR/hyperdouraku.html" "hyperdouraku"

# ---------- 4. 下载封面候选图 ----------
# 用途：文章列表页与详情页顶部的封面大图。
#
# 【v2 改造（2026-09-20）—— 从「随机热点图」升级为「贴题官方图」】
# 用户要求：封面必须与文章主题对应。例如简报写「东京丸井泷奈之枪」，
#          封面就该是那把枪，而不是随便一张社群实装照。
#
# 两条轨道：
#   轨 1（主）：Popular Airsoft 官方产品图 —— 1000×714 真 JPEG，
#               按 feed 标题做**语义匹配**选图，贴题度最高。
#   轨 2（备）：Reddit 当期热点图 —— 官方源失败时兜底。
#
# ⚠️ 实现约束（踩坑记录）：
#   1. Reddit 的 thumbnail URL 带 `&amp;` HTML 实体，必须先反转义再请求；
#      否则 curl 会把 &amp; 当成路径的一部分，返回 404。
#   2. Reddit 图床（external-preview.redd.it / preview.redd.it）校验 Referer 与 UA，
#      必须带浏览器 UA；Referer 不必带。
#   3. 图片走 shell 重定向落盘（与正文采集同理，`curl -o` 在沙箱下不可靠）。
#   4. 必须用**魔数**校验图片类型，不能用 %{content_type} ——
#      本机 curl 经代理隧道时该字段恒为空。（JPEG=ffd8ff / PNG=89504e47）
COVER_DIR="$OUT_DIR/covers"
mkdir -p "$COVER_DIR"
COVER_N=6
PA_DIR="$OUT_DIR/pa_official"      # 轨 1：Popular Airsoft 官方图
mkdir -p "$PA_DIR"
echo "[4/5] 下载封面候选图..."

# ---------- 轨 1：Popular Airsoft 官方产品图 ----------
# 步骤：① 抓一则文章页（含全部最新文章缩略图）
#       ② 用 fetch_covers.py 按标题语义匹配，产出「标题 → 图片」映射
#       ③ 按映射下载到 pa_official/，文件名沿用原图名（含产品信息）
#
# ⚠️ 为什么匹配不用「feed 顺序 ↔ 图片顺序」：
#    实测该映射不同步（页面首图对应 feed 第 3 条），错配率 5/10。
#    改用语义打分后 10/10 全中，其中 8 条高置信。详见 fetch_covers.py 注释。
if [ -s "$OUT_DIR/popularairsoft.xml" ]; then
  PA_PAGE="$OUT_DIR/_pa_page.html"
  # 抓 feed 首条文章作为「最新文章列表」样本页
  pa_first=$(grep -oE '<link>[^<]*popularairsoft[^<]*</link>' "$OUT_DIR/popularairsoft.xml" 2>/dev/null \
             | sed 's/<link>//; s/<\/link>//' | head -1)
  if [ -n "$pa_first" ]; then
    curl -sS -L -m 30 -A "$UA" -x "$PROXY" "$pa_first" > "$PA_PAGE" 2>/dev/null
    echo "      已取 Popular Airsoft 样本页（$(wc -c < "$PA_PAGE" | tr -d ' ') bytes）"
  fi

  MAP_JSON="$OUT_DIR/covers-map.json"
  if [ -s "$PA_PAGE" ]; then
    # fetch_covers.py 只依赖标准库，任意 Python 均可
    # ⚠️ 路径必须转 Windows 原生格式，否则 Python 报 FileNotFoundError
    if [ -n "${PYBIN:-}" ] && [ -x "$PYBIN" ]; then
      SCRIPT_PY="$(winpath "$(dirname "$0")/.cache/tools/fetch_covers.py")"
      FEED_W="$(winpath "$OUT_DIR/popularairsoft.xml")"
      PAGE_W="$(winpath "$PA_PAGE")"
      MAP_W="$(winpath "$MAP_JSON")"
      "$PYBIN" "$SCRIPT_PY" "$FEED_W" "$PAGE_W" "$MAP_W" 2>&1 \
        | grep -E '^(OK|~|\?|!!|配图成功|feed 条目)' || true
    else
      echo "      （未找到 Python，跳过官方图语义匹配）"
    fi
  fi

  # 依据映射下载官方图
  if [ -s "$MAP_JSON" ]; then
    # 用 Python 解析 JSON（避免 jq 依赖），输出 "urlpath<TAB>basename"
    if [ -n "${PYBIN:-}" ] && [ -x "$PYBIN" ]; then
      MAP_W2="$(winpath "$MAP_JSON")"
      "$PYBIN" -c '
import json,sys,os
d=json.load(open(sys.argv[1],encoding="utf-8"))
for r in d:
    p=r.get("image") or ""
    if p: print(p+"\t"+os.path.basename(p))
' "$MAP_W2" \
      | while IFS=$'\t' read -r upath bname; do
          [ -z "$upath" ] && continue
          dst="$PA_DIR/$bname"
          [ -s "$dst" ] && continue
          curl -sS -L -m 40 -A "$UA" -x "$PROXY" "https://www.popularairsoft.com$upath" > "$dst" 2>/dev/null
          sz=$(wc -c < "$dst" 2>/dev/null | tr -d ' ')
          mg=$(head -c 3 "$dst" 2>/dev/null | od -An -tx1 | tr -d ' \n')
          if [ "$mg" = "ffd8ff" ] && [ "${sz:-0}" -gt 30000 ]; then
            echo "      [官方] $bname  ${sz}B"
          else
            rm -f "$dst"
          fi
        done
    fi
    pa_got=$(find "$PA_DIR" -maxdepth 1 -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')
    echo "      → 官方图目录：$PA_DIR（$pa_got 张）"
  fi
fi

# ---------- 轨 2（兜底）：Reddit 当期热点图 ----------
# 仅在官方源不可用时使用。命名 cover-NN.jpg，便于与官方图区分。
echo "      [轨2] 采集 Reddit 兜底图..."

# 从 Atom feed 抽取 media:thumbnail URL，反转义 HTML 实体，去重。
#
# ⚠️ Reddit feed 的缩略图有两种规格（实测 25 条中 13 大 / 12 小）：
#     · width=640  → 可做封面的合格大图
#     · width=140  → 方形/条形缩略图，仅 2~7KB，做封面必糊
#   且**不能改 width 参数升采样** —— URL 里的 `s=` 是签名，改任何参数都返回 403。
#   因此只能先筛选大图，再下载。
extract_thumbs() {
  # 入参：rss 文件路径；输出：每行一个已反转义的大图 URL（仅 width>=640）
  grep -o 'media:thumbnail url="[^"]*"' "$1" 2>/dev/null \
    | sed 's/media:thumbnail url="//; s/"$//' \
    | sed 's/&amp;/\&/g' \
    | grep -E 'width=(640|960|1080|[1-9][0-9]{3,})' \
    | awk '!seen[$0]++'
}

THUMBS="$COVER_DIR/.thumbs.$$"
: > "$THUMBS"
# 优先用 r/airsoft/top（热度最高），不足时补 airsoftmarket
for src in "$OUT_DIR/airsoft.rss" "$OUT_DIR/airsoftmarket.rss"; do
  [ -s "$src" ] || continue
  extract_thumbs "$src" >> "$THUMBS"
done

if [ -s "$THUMBS" ]; then
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    slot=$(find "$COVER_DIR" -maxdepth 1 -name 'cover-*.jpg' 2>/dev/null | wc -l | tr -d ' ')
    [ "$slot" -ge "$COVER_N" ] && break
    out="$COVER_DIR/cover-$(printf '%02d' "$((slot + 1))").jpg"

    # ⚠️ 不要用 %{content_type} 判断 —— 本机 curl 经代理隧道时该字段恒为空。
    #    改用「魔数 + 体积」双闸：JPEG=ffd8ff / PNG=89504e47
    curl -sS -L -m 40 -A "$UA" -x "$PROXY" "$url" > "$out" 2>/dev/null
    size=$(wc -c < "$out" 2>/dev/null | tr -d ' ')
    magic=$(head -c 4 "$out" 2>/dev/null | od -An -tx1 | tr -d ' \n')

    case "$magic" in
      ffd8ff*)  kind="jpeg" ;;
      89504e47) kind="png";  mv "$out" "${out%.jpg}.png"; out="${out%.jpg}.png" ;;
      *)        kind="" ;;
    esac
    base=$(basename "$out")

    # 140px 级缩略图通常 <8KB，画质不足以做封面 → 同时要求体积达标
    if [ -z "$kind" ]; then
      echo "      ${base%.*}.jpg 非图片（magic=${magic:-空}），丢弃"
      rm -f "$out"
    elif [ "${size:-0}" -lt 15360 ]; then
      echo "      ${base%.*}.jpg 体积过小（${size}B，不足做封面），丢弃"
      rm -f "$out"
    else
      echo "      $base -> $kind, ${size} bytes"
    fi
  done < "$THUMBS"
  rm -f "$THUMBS"
else
  echo "      未从 feed 中解析到图片链接（feed 可能为空或被限流）"
fi

# ---------- 5. 汇总 ----------
echo "[5/5] 采集完成。素材目录：$OUT_DIR"
echo
echo "--- 素材清单 ---"
for f in "$OUT_DIR"/*; do
  [ -f "$f" ] && echo "  $(basename "$f"): $(wc -c < "$f" | tr -d ' ') bytes"
done

# 轨 1：官方贴题图（首选）
if [ -d "$PA_DIR" ]; then
  pa_count=$(find "$PA_DIR" -maxdepth 1 -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')
  echo "--- 官方贴题图（$pa_count 张，**首选**）：$PA_DIR ---"
  find "$PA_DIR" -maxdepth 1 -name '*.jpg' 2>/dev/null | sort | while read -r c; do
    echo "      $(basename "$c")  $(wc -c < "$c" | tr -d ' ') bytes"
  done
  [ -s "$OUT_DIR/covers-map.json" ] && echo "      映射表：$OUT_DIR/covers-map.json（标题 → 图片 + 置信度）"
fi

# 轨 2：Reddit 兜底图
if [ -d "$COVER_DIR" ]; then
  cover_count=$(find "$COVER_DIR" -maxdepth 1 \( -name 'cover-*.jpg' -o -name 'cover-*.png' \) 2>/dev/null | wc -l | tr -d ' ')
  echo "--- Reddit 兜底图（$cover_count 张）：$COVER_DIR ---"
  find "$COVER_DIR" -maxdepth 1 \( -name 'cover-*.jpg' -o -name 'cover-*.png' \) 2>/dev/null \
    | sort | while read -r c; do
      echo "      $(basename "$c")  $(wc -c < "$c" | tr -d ' ') bytes"
    done
fi

echo
echo "下一步："
echo "  ── A. 封面图 ──"
echo "  1) 读 covers-map.json，按文章主题选定官方图（置信度 high 可直接用；"
echo "     medium/low 需人工确认；标记「重复」的说明多篇同主题，择一或换图）"
echo "  2) 若某篇文章在 2026 年目录下无对应官方图（多为更早的产品），"
echo "     可另在 tokyo-marui.co.jp / hyperdouraku.com 找官方图："
echo "       · 东京丸井：https://www.tokyo-marui.co.jp/appimg/product/p_main_*.jpg"
echo "       · Hyperdouraku：https://www.hyperdouraku.com/airgun/<slug>/images/for_top305.jpg"
echo "  3) 复制选定图到 static/images/covers/<日期>.jpg"
echo "     ⚠️ 采集图比例极不统一（实测 0.56 ~ 3.81）。"
echo "        入库前必须统一宽度到 1600px，最终比例由 CSS 的"
echo "        aspect-ratio + object-fit:cover 归一化。"
echo "  4) 在 front matter 写 cover.image / cover.alt / cover.caption"
echo
echo "  ── B. 正文插图（图池同上，取自 pa_official/）──"
echo "  5) 复制插图到 static/images/posts/<日期>-<slug>.jpg"
echo "     ⚠️ 统一宽度到 1400px（与封面 1600 区分使用，避免同一图两处同尺寸）"
echo
echo "  6) 【第一张图规则】正文开头必须有且仅有一张「定调首图」，"
echo "     优先级：开箱图 > 官网宣传图 > 官网产品图；"
echo "     若主题涉及动漫（如《莉可丽丝》联名），首图必须是**动漫相关**图"
echo "     （动画原画 / 官方联名宣传图）。"
echo "     ⚠️ 实拍演示图、评测实拍图 只能作为第二张及以后，不得占首图位。"
echo
echo "  7) 【各小节配图】每个小节可配一张该产品自己的图，"
echo "     同样优先开箱图/官网宣传图；只有实拍图可用时，"
echo "     须在图注末尾注明「（评测实拍，非官网产品图）」。"
echo
echo "  8) Markdown 写法（图注 = title 部分，会渲染为 <figcaption>）："
echo '     ![替代文本](images/posts/xxx.jpg "图注文字 · 图源：XXX")'
echo "     ⚠️ 需给图片加 class 时，属性块**必须独占一行**写在图片下方："
echo '       ![alt](src "cap")'
echo '       {class="wide-banner"}'
echo "       写在同行（![...](...){class=...}）会被静默忽略。"
echo "     ⚠️ 超宽横幅图（厂商长条宣传图，比例 >3:1）务必加 {class=\"wide-banner\"}，"
echo "        否则 16:9 框会横向裁掉大量内容。"
echo
echo "  9) 不要给封面用过的图重复做正文首图（同图不同裁切可接受）"
echo
echo "  9.5) 【合规硬性要求 — 涉港澳台表述】"
echo "     本站公开可见，涉台表述必须规范："
echo "       · 中文行文中一律写「中国台湾」或「台湾地区」，禁止单写「台湾」"
echo "       · 同理：中国香港 / 中国澳门"
echo "       · ⚠️ 唯一的例外是**专有名词**：媒体/渠道品牌名如「Taiwan Gun」"
echo "         可保留英文原名，但其后的中文说明仍须规范"
echo "         （例：「中国台湾渠道（Taiwan Gun）」）"
echo "       · 采集素材里原文若有「Taiwan」，转写中文时必须按上述规则处理，"
echo "         不得直接照抄为「台湾」"
echo
echo "  10) 运行 publish.sh"

# 退出码约定：
#   0 = 正常（即使部分源失败，只要主力源有数据）
#   2 = 代理未开，任务应中止
exit 0
