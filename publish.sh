#!/usr/bin/env bash
# 境外 GBB/AEG 简报 —— 发布脚本
# 用途：本地构建校验 → 提交 → 推送到 GitHub（触发 Pages 更新）
#
# 用法：bash publish.sh "提交信息"
#
# 前置条件：
#   1. git 凭据已配置（~/.git-credentials + credential.helper=store）
#      —— 无需 GITHUB_TOKEN，推送走凭据管理器，可无人值守
#   2. 简报 markdown 已放入 content/posts/

set -uo pipefail

REPO_DIR="/d/blog-hugo"
BRANCH="main"
HUGO_BIN="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/hugo.exe"

MSG="${1:-brief: $(date +%Y-%m-%d) 境外 GBB/AEG 资讯简报}"

cd "$REPO_DIR" || { echo "错误：无法进入 $REPO_DIR"; exit 1; }

# 1. 构建校验（本地预检；实际产物由 GitHub Actions 构建）
echo "[1/4] 本地构建校验..."
if [ -x "$HUGO_BIN" ]; then
  if ! "$HUGO_BIN" --source "$REPO_DIR" --gc --minify --quiet 2>&1; then
    echo "构建失败（出现 ERROR），终止发布。"
    exit 1
  fi
  echo "      构建通过"
else
  echo "      警告：未找到 hugo（$HUGO_BIN），跳过本地校验，交由 Actions 构建"
fi

# 2. 检查是否有变更
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "无变更，跳过推送"
  exit 0
fi

# 3. 提交
echo "[2/4] 提交变更..."
git add -A
if ! git commit -m "$MSG"; then
  echo "      （无需提交，可能已提交过）"
fi

# 4. 推送（走凭据管理器；GIT_TERMINAL_PROMPT=0 确保不阻塞等待输入）
echo "[3/4] 推送..."
export http_proxy="http://127.0.0.1:7897"
export https_proxy="http://127.0.0.1:7897"
if GIT_TERMINAL_PROMPT=0 git push origin "$BRANCH"; then
  echo "      推送成功"
else
  echo "错误：推送失败。请检查网络/代理与 git 凭据（~/.git-credentials）。"
  exit 1
fi

# 5. 提示后续验证
echo "[4/4] 完成。"
echo "      Actions 将自动构建部署（约 1-2 分钟）。"
echo "      请务必验证线上是否真的更新（push 成功 ≠ 部署成功）："
echo "        curl -s \"https://xianv0031.github.io/blog/index.xml?cb=\$RANDOM\" | grep -oE '<title>[^<]*</title>'"
