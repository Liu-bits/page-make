#!/usr/bin/env bash
# =============================================================================
# 部署到 EdgeOne Pages / Makers（主线路）
# 依赖：EdgeOne Makers API Token（GitHub Secret: EDGEONE_API_TOKEN）
# 官方文档：
#   Edge Functions 开发：https://cloud.tencent.com/document/product/1552/127415
#   EdgeOne CLI：       https://cloud.tencent.com/document/product/1552/127423
# 部署内容：仓库根目录 edge-functions/（EdgeOne Pages Functions 自动识别）
# =============================================================================
set -euo pipefail

if [ -z "${EDGEONE_API_TOKEN:-}" ]; then
  echo "::notice::EDGEONE_API_TOKEN 未配置，跳过 EdgeOne 部署（第一版可先在控制台手动部署 edge-functions/ 目录）。"
  exit 0
fi

echo "EDGEONE_API_TOKEN 已配置（长度 ${#EDGEONE_API_TOKEN}），开始部署 EdgeOne Makers…"

# 方式一（推荐）：EdgeOne CLI（CI 命令）
# edgeone makers deploy -n <项目名> -t <token>
# 项目名可通过仓库变量 EDGEONE_PROJECT_NAME 指定，默认 page-make
PROJECT_NAME="${EDGEONE_PROJECT_NAME:-page-make}"

if command -v edgeone >/dev/null 2>&1; then
  edgeone makers deploy -n "$PROJECT_NAME" -t "$EDGEONE_API_TOKEN"
  exit $?
fi

# 方式二：未安装 CLI 时尝试用 npx 拉取（包名：edgeone）
if npx --yes edgeone --version >/dev/null 2>&1; then
  npx --yes edgeone makers deploy -n "$PROJECT_NAME" -t "$EDGEONE_API_TOKEN"
  exit $?
fi

echo "::warning::未找到 EdgeOne CLI，已跳过自动部署。请在 EdgeOne Pages 控制台手动部署 edge-functions/ 目录（第一版）。"
echo "::warning::提示：控制台也可直接关联本 GitHub 仓库，push main 时自动构建部署。"
