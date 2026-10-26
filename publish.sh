#!/usr/bin/env bash
# WAR GAME 情报站 + 军事科普库 —— 发布脚本
# 用途：本地构建校验 → 提交 → 推送到 GitHub（触发 Pages 更新）
#
# 用法：bash publish.sh "提交信息"
#
# 前置条件：
#   1. git 凭据已配置（~/.git-credentials + credential.helper=store）
#      —— 无需 GITHUB_TOKEN，推送走凭据管理器，可无人值守
#   2. 文章 markdown 已放入 content/posts/ 或 content/kb/<分栏>/
#
# ⚠️ 2026-10-26 变更：原凭据（github_pat_ 细粒度 PAT）已过期，
#    改用 Git Credential Manager 存储的 OAuth 凭据。
#    注意 Git 安装时 credential.helper 被设为 manager（GCM），
#    而不是 store —— 所以 ~/.git-credentials 文件是空的，
#    真正凭据在 Windows 凭据管理器（cmdkey / GCM）里。
#    验证方式：`git credential fill` 能返回 password 即可。

set -uo pipefail

REPO_DIR="/d/blog-hugo"
REPO_DIR_WIN="D:\\blog-hugo"   # hugo.exe 是 Windows 程序，必须传 Windows 原生路径
BRANCH="main"
HUGO_BIN="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/hugo.exe"

MSG="${1:-post: $(date +%Y-%m-%d) WAR GAME 情报站周报}"

cd "$REPO_DIR" || { echo "错误：无法进入 $REPO_DIR"; exit 1; }

# 1. 构建校验（本地预检；实际产物由 GitHub Actions 构建）
# ⚠️ --source 必须用 Windows 路径（D:\blog-hugo），
#    传 MSYS 风格 /d/blog-hugo 会被解析成 D:\d\blog-hugo 而报路径不存在。
echo "[1/4] 本地构建校验..."
if [ -x "$HUGO_BIN" ]; then
  if ! "$HUGO_BIN" --source "$REPO_DIR_WIN" --gc --minify --quiet 2>&1; then
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
# ⚠️ 代理不是必须的：实测 github.com 直连可通，代理 7897 反而偶发 000。
#    只在直连失败时才回退到代理。
push_once() {
  GIT_TERMINAL_PROMPT=0 git push origin "$BRANCH" 2>&1
}

if PUSH_OUT=$(push_once); then
  echo "      推送成功"
else
  # 直连失败 → 带代理重试一次
  echo "      直连失败，尝试代理 127.0.0.1:7897 ..."
  if HTTP_PROXY="http://127.0.0.1:7897" HTTPS_PROXY="http://127.0.0.1:7897" \
     GIT_TERMINAL_PROMPT=0 git push origin "$BRANCH" 2>&1; then
    echo "      推送成功（经代理）"
  else
    echo "错误：推送失败。"
    echo "  常见原因："
    echo "    1. 凭据失效 —— 跑 'git credential fill' 看能否返回 password；"
    echo "       不能的话重新登录：\"C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe\" github login --browser"
    echo "    2. 网络 —— 直连 github.com:443 不通时，确认代理软件在跑"
    exit 1
  fi
fi

# 5. 提示后续验证
echo "[4/4] 完成。"
echo "      Actions 将自动构建部署（约 1-2 分钟）。"
echo "      请务必验证线上是否真的更新（push 成功 ≠ 部署成功）："
echo "        curl -s \"https://xianv0031.github.io/blog/index.xml?cb=\$RANDOM\" | grep -oE '<title>[^<]*</title>'"
