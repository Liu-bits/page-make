# =============================================================================
# Page-make 自托管镜像（ModelScope 创空间 Docker 类型 / 任意容器平台）
# 端口约定：7860（ModelScope）
# 数据目录：/mnt/workspace/pagemake-data（创空间持久卷，重启不丢）
# 运行时零 npm 依赖（仅 Node 标准库 + edge-functions 源码）
# =============================================================================
FROM node:22-alpine

WORKDIR /app

# 边缘函数处理器（与 EdgeOne 部署共用同一份代码，零业务改动）
COPY edge-functions/ ./edge-functions/
# 容器适配层（Node HTTP + 磁盘 KV）
COPY docker/server.mjs ./server.mjs

ENV PORT=7860
ENV DATA_DIR=/mnt/workspace/pagemake-data

EXPOSE 7860

# 数据目录声明：平台挂载持久卷时自动生效；未挂载则数据在容器层（重建丢失）
VOLUME ["/mnt/workspace/pagemake-data"]

# 启动前确保数据目录存在（平台未预建时）
ENTRYPOINT ["sh", "-c", "mkdir -p \"$DATA_DIR\" && node server.mjs"]
