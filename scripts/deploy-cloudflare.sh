#!/usr/bin/env bash
# =============================================================================
# 部署到 Cloudflare Pages（备选线路）
# 说明：Page-make 的后端（edge-functions/）按 EdgeOne Pages Functions 规范编写，
#       Cloudflare 线路需要 Workers 适配层，属于第二版范围。
#       本脚本第一版为占位：token 已配置时只做检查提示，不做真实部署。
# =============================================================================
set -euo pipefail

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "::notice::CLOUDFLARE_API_TOKEN 未配置，跳过 Cloudflare 部署（第一版备选线路占位）。"
  exit 0
fi

echo "::warning::Cloudflare 备选线路第一版为占位：后端 edge-functions/ 为 EdgeOne Pages Functions 规范，接入 Cloudflare 需要 Workers 适配层（第二版）。"
echo "::warning::注意：*.pages.dev 在国内访问不稳定，这是已知问题；线路选择已在 App 内向用户说明。"
exit 0
