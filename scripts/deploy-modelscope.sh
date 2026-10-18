#!/usr/bin/env bash
# =============================================================================
# 部署到 ModelScope 创空间（Docker 类型）
# 流程：把容器构建所需的文件子集推送到创空间 Git 仓库 → 平台自动构建上线
# 所需配置（GitHub 仓库 Settings → Secrets and variables → Actions）：
#   Variables: MODELSCOPE_SPACE   用户名/空间名（如 liu20/pagemake）
#   Secrets:   MODELSCOPE_TOKEN   ModelScope API Token（控制台 → 个人中心 → 访问令牌）
# 未配置时自动跳过，不影响其他 CI。
# =============================================================================
set -euo pipefail

SPACE="${MODELSCOPE_SPACE:-}"
TOKEN="${MODELSCOPE_TOKEN:-}"

if [ -z "$SPACE" ] || [ -z "$TOKEN" ]; then
  echo "::notice::MODELSCOPE_SPACE / MODELSCOPE_TOKEN 未配置，跳过 ModelScope 部署（配置后自动生效）"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "克隆创空间仓库：${SPACE}"
git clone --depth 1 "https://oauth2:${TOKEN}@www.modelscope.cn/studios/${SPACE}.git" "${WORK}/space"

# 只同步容器构建需要的文件（不含 iOS / CI / 文档 / 本地脚本）
# 先刷新 JWKS 种子（Google/Apple 验签公钥）：CI runner 有外网，容器在境内没有；
# 失败不阻断部署（保留旧种子，加载器会回退磁盘缓存/种子）
echo "刷新 JWKS 种子（登录验签公钥）"
node scripts/refresh-jwks.mjs || echo "::warning::JWKS 种子刷新失败，使用旧种子继续部署"

cp Dockerfile .dockerignore "${WORK}/space/"
rm -rf "${WORK}/space/backend" "${WORK}/space/docker"
cp -r backend "${WORK}/space/backend"
cp -r docker "${WORK}/space/docker"

cd "${WORK}/space"
git add -A

if git diff --cached --quiet; then
  echo "创空间已是最新，无需推送"
  exit 0
fi

SHORT_SHA="${GITHUB_SHA:-local}"
SHORT_SHA="${SHORT_SHA:0:7}"
git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -m "deploy: ${SHORT_SHA}"

echo "推送到创空间（触发自动构建）"
git push origin HEAD:master
echo "✓ 已推送，ModelScope 将自动构建并上线"
