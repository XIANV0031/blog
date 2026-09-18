#!/usr/bin/env bash
# 境外 GBB/AEG 简报 —— 发布脚本
# 用途：把新生成的简报 markdown 提交并推送到 GitHub，触发 Pages 更新
#
# 用法：bash publish.sh "提交信息"
#
# 前置条件：
#   1. 已设置 GITHUB_TOKEN 环境变量（Fine-grained PAT，需 Contents: Read and write）
#   2. 简报 markdown 已放入 content/posts/

set -euo pipefail

REPO_DIR="/d/blog-hugo"
REMOTE="https://github.com/XIANV0031/blog.git"
BRANCH="main"
HUGO_BIN="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/hugo.exe"

MSG="${1:-update: 每日简报 $(date +%Y-%m-%d)}"

cd "$REPO_DIR"

# 1. 构建（本地校验，产物不推送，由 GitHub Actions 构建）
echo "[1/4] 本地构建校验..."
"$HUGO_BIN" --gc --minify --quiet || { echo "构建失败，终止"; exit 1; }

# 2. 检查是否有变更
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "无变更，跳过推送"
  exit 0
fi

# 3. 提交
echo "[2/4] 提交变更..."
git add -A
git commit -m "$MSG" || echo "（无需提交）"

# 4. 推送（用 token 注入 remote，不落盘）
echo "[3/4] 推送..."
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git push "https://XIANV0031:${GITHUB_TOKEN}@github.com/XIANV0031/blog.git" "HEAD:${BRANCH}"
else
  echo "错误：未设置 GITHUB_TOKEN"
  exit 1
fi

echo "[4/4] 完成。站点将在 1-2 分钟后于 https://xianv0031.github.io/blog/ 更新"
