# =============================================================================
# Page-make 自托管镜像（ModelScope 创空间 Docker 类型 / 任意容器平台）
# 端口约定：7860（ModelScope）
# 数据目录：/mnt/workspace/pagemake-data（创空间持久卷，重启不丢）
# 运行时零 npm 依赖（仅 Node 标准库 + backend/ 源码）
# =============================================================================
FROM node:22-alpine

WORKDIR /app

# 后端项目支持：npm 随 Node 自带，pnpm 需要额外安装。
# 用 corepack 固定版本，避免不同时间构建出来的 pnpm 行为漂移。
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate \
    && pnpm --version && npm --version

# API 处理器（路由、lib 库，与 CI 测试共用同一份代码）
COPY backend/ ./backend/
# 容器适配层（Node HTTP + 磁盘 KV）
COPY docker/server.mjs ./server.mjs

ENV PORT=7860
ENV DATA_DIR=/mnt/workspace/pagemake-data

EXPOSE 7860

# 数据目录声明：平台挂载持久卷时自动生效；未挂载则数据在容器层（重建丢失）
VOLUME ["/mnt/workspace/pagemake-data"]

# 健康检查（保活探测 / 平台健康检查用）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动前确保数据目录存在（平台未预建时）
ENTRYPOINT ["sh", "-c", "mkdir -p \"$DATA_DIR\" && node server.mjs"]
