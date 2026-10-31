# Page-make

网页与 Node 服务托管工具：用户上传 ZIP、粘贴 HTML/CSS/JS，或使用项目模式管理虚拟文件，
后台自动解压、找入口、诊断并生成可公开访问的链接。VIP 及以上可部署 npm / pnpm
后端项目；普通用户仍可上传，但部署选项只能选择纯前端。PHP 与 C++ 不支持。

- **iOS**：SwiftUI 纯原生实现 + AuthenticationServices（Sign in with Apple）
- **后端**：Node 22 容器（Docker），npm / pnpm 项目在受限子进程中安装、构建与运行
- **构建**：CI · `xcode-27` runner（macOS 27.0.1）· Xcode 27.0.0 · iOS 27.0 模拟器
- **许可**：专有软件，保留所有权利

> 架构说明：业务 handler 位于 `backend/`，由 `docker/server.mjs` 适配为普通
> Node HTTP 服务，数据落盘到 `DATA_DIR`。静态站点直接由 `/p/<id>` 下发；
> npm / pnpm 项目由 `backend/lib/backend-runtime.js` 安装、构建并反向代理；
> 发布与刷新是异步状态机，客户端轮询 `/status`，避免长请求被网关或 iOS 超时截断。

## 目录结构

```
.
├── ios/                        # iOS App（XcodeGen 工程，CI 生成）
│   ├── project.yml             #   工程描述：cd ios && xcodegen generate
│   ├── PageMake/               #   源码（页面 + 服务 + 模型 + 本地化中英 + 双语文档）
│   ├── PageMakeTests/          #   单元测试
│   └── scripts/resolve-simulator.mjs  # CI 模拟器解析（优先 iOS 27.0.1）
├── backend/                    # API 处理器（路由 + lib 库，容器与测试共用）
│   ├── api/                    #   auth / upload / projects / export / admin / feedback
│   ├── p/[projectId]/          #   公开访问（静态文件或后端反向代理）
│   └── lib/                    #   kv / zip / diagnostics / tiers / backend-runtime / process
├── docker/server.mjs           # 容器适配层（Node HTTP + 磁盘 KV）
├── Dockerfile                  # 部署镜像（私有容器 / 任意容器平台）
├── dev/run-tests.mjs           # 后端单元测试：node dev/run-tests.mjs
├── dev/test-server.mjs         # 容器冒烟测试（HTTP 全流程）：node dev/test-server.mjs
├── dev/test-guest-ttl.mjs      # 游客 10 分钟试用与身份重置
├── dev/test-assets.mjs         # HTML/CSS/JS 引用与静态资源回归
├── dev/test-admin.mjs          # VIP、封禁、解封、删号与后台安全
|├── scripts/deploy-modelscope.sh # CI 部署：推送构建子集到部署仓库 Git
├── scripts/check-localization.mjs # 中英本地化 key 完整性校验
└── .github/workflows/
    ├── page-make.yaml          #   主 CI/CD（测试 + 部署）
    └── keepalive.yaml          #   保活探测（配置 PAGEMAKE_URL 变量后生效）
```

## 环境要求

| 项 | 版本 |
| --- | --- |
| iOS 编译 | `xcode-27` runner（= macOS 27.0.1 镜像）+ Xcode 27.0.0 GM（CI 精确锁定并校验） |
| 运行目标 | 优先 iOS 27.0.1 模拟器，回退 iOS 27.0（Apple 版本线无 27.0.1） |
| 后端 | Node 22；用户项目可使用 npm 或 pnpm 安装依赖 |
| 本地开发 | Windows 11（iOS 无法本地编译，由 CI 的 macOS runner 完成） |

## 快速开始

### 本地测试（Windows）

```bash
# 后端逻辑测试（zip 解压 / 诊断 / 状态机 / 完整上传管线）
node dev/run-tests.mjs

# 容器冒烟测试（启动真实 HTTP 服务，跑完整上传 → 公开访问全流程）
node dev/test-server.mjs

# VIP/后台、游客、静态资源与管理后台测试
node dev/test-guest-ttl.mjs
node dev/test-assets.mjs
node dev/test-admin.mjs
```

### 本地运行容器

```bash
# 方式一：不用 Docker，直接 Node 跑
DATA_DIR=./data node docker/server.mjs        # 监听 7860

# 方式二：Docker
docker build -t pagemake .
docker run -p 7860:7860 -e APPLE_CLIENT_ID=com.pagemake.app pagemake

# 本地调试可跳过登录鉴权（生产禁止！）
DEV_NO_AUTH=1 DATA_DIR=./data node docker/server.mjs
```

## 部署到私有容器（唯一部署目标）

### 第一次部署（手动）

1. 创建容器空间，SDK 类型选 **Docker**
2. 把部署仓库同步到空间仓库（根目录 `Dockerfile` 即构建入口，服务监听 `0.0.0.0:7860`）
3. 空间**环境变量**配置 `APPLE_CLIENT_ID`（iOS Bundle ID，校验 Apple 登录）
4. 上线后 iOS 端 `Config.baseURL` 改为空间域名

约定：数据持久化在 `/mnt/workspace/pagemake-data`（重启不丢）；链接**长期有效**（自托管无预览域名限制），直到用户删除项目。

### 之后每次提交（自动）

配置仓库后，push 到 main 且测试全绿即自动部署：

| 位置 | 名称 | 值 |
| --- | --- | --- |
| Variables | `MODELSCOPE_SPACE` | `用户名/空间名`（如 `liu20/pagemake`） |
| Secrets | `MODELSCOPE_TOKEN` | 平台 API Token（控制台 → 个人中心 → 访问令牌） |

CI 会把容器构建所需的文件子集（`Dockerfile` + `backend/` + `docker/`）推送到空间 Git，平台自动构建上线。未配置时自动跳过。

### 保活

平台免费 CPU 空间为常驻运行态（官方要求空间保持 running，无 48 小时休眠规则）。保险起见已内置 `keepalive.yaml`：配置仓库变量 `PAGEMAKE_URL` 后每 10 分钟自动探测 `/healthz`，同时充当健康监控。Dockerfile 也带 `HEALTHCHECK`。也可用 UptimeRobot 免费档（5 分钟粒度）。

### 部署注意事项

- **数据自行备份**：定期导出 `DATA_DIR`（持久卷）
- **单点**：容器重启期间短暂不可用（Node 冷启动 1~2 秒，数据不丢）
- **网络**：国内快、海外慢（无 CDN）；用户主要在海外可改部署到 Oracle Always Free 等海外机房（同一镜像，零改动）
- `DEV_NO_AUTH=1` **仅限本地调试**，生产环境禁止设置（等于关闭登录）
- 部署形态由创建页选择：纯前端、npm、pnpm；npm / pnpm 仅 VIP 及以上可用

## CI

`push main / tag v* / PR` 触发：

| Job | runner | 内容 |
| --- | --- | --- |
| backend-test | ubuntu-latest | Node 22 后端单测 + 容器冒烟测试（HTTP 全流程）+ Docker 镜像构建校验 |
| ios-build | xcode-27（macOS 27.0.1） | Xcode 27.0.0 校验 → xcodegen → 编译（不签名）→ iOS 27.0 模拟器测试 |
| ipa | xcode-27（macOS 27.0.1） | 仅 main / tag：真机归档（不签名）→ 打包 **未签名 IPA** 产物（CI 页面 Artifacts 下载） |
| deploy | ubuntu-latest | 仅 main 分支，推送构建子集到部署空间（需配置 `MODELSCOPE_SPACE` / `MODELSCOPE_TOKEN`） |

## API 一览

| 路由 | 说明 |
| --- | --- |
| `POST /api/auth` | Sign in with Apple 换 7 天会话凭证 |
| `POST /api/auth/guest` | 游客登录（设备 ID 免密，免费 Apple ID 兜底） |
| `POST /api/auth/google` | Google 登录（校验 id_token） |
| `GET /api/vip-request` | 读取当前账号的 VIP 升级申请状态（仅游客） |
| `POST /api/vip-request` | 提交 / 重新提交 VIP 升级申请（仅普通游客，同 IP 每分 5 次） |
| `POST /api/upload/init` | 初始化分片上传（校验部署形态与账号等级配额） |
| `POST /api/upload/chunk` | 上传分片（600KB/片） |
| `POST /api/upload/finish` | 完成上传，后台处理（processing → ready/failed） |
| `GET /api/projects` | 我的项目列表 |
| `POST /api/projects/paste` | 粘贴代码直接创建（HTML 必填，CSS/JS 可选，自动注入引用） |
| `GET/POST /api/projects/:id` | 详情 / 重命名或删除（网关兼容：删除走 `POST action=delete`） |
| `GET /api/projects/:id/export` | 导出项目源码 ZIP（VIP 及以上） |
| `GET /api/projects/:id/status` | 状态轮询（每 2 秒） |
| `POST /api/projects/:id/refresh` | 刷新链接（静态项目重发；npm/pnpm 异步重启进程） |
| `GET/POST /api/projects/:id/files` | 读取 / 新增、编辑、重命名、删除文件 |
| `POST /api/upload/:uploadId` | 取消上传（`action=cancel`，清理临时分片） |
| `POST /api/feedback` | 反馈 / 举报 |
| `GET /p/:projectId` | 公开访问（无需登录；已下架有专门页面） |

## 核心规则

- 未登录：只能浏览公开链接，不能创建、管理、看诊断详情或选择部署形态
- 创建网页必须登录（Apple / Google）或使用游客试用；游客由管理员升级 VIP 后保留原身份与作品
- VIP 是现有 Apple / Google / 游客账号的附加权益，不提供独立 VIP 账号或邮箱密码登录
- 等级从低到高为普通、VIP、SVIP、Ultra；管理员可在 `/admin` 原地调整，不更换 userId / 会话 / 项目
- 项目配额：普通静态项目 5MB；VIP 1MB；SVIP 100MB；Ultra 不设业务上限
- npm / pnpm 后端部署从 VIP 起可用；普通用户仍可上传，但部署选项只有纯前端
- 升级链路：App 内设置页「升级 VIP」→ 提交申请（可附 300 字说明）→ 管理后台 `/admin`
  审核（批准保留原 userId / token / 项目，权益即时生效；驳回可附原因并允许重新提交）
- 单线路部署（私有容器），创建时无需选择线路
- 语言：跟随 iOS 系统语言（中文/英文，其他默认英文），不提供手动切换
- 诊断详情是登录特权，未登录只显示「您的代码有错误」

## 上线前检查清单

- [x] 隐私政策 / 用户协议：App 内直接展示（`ios/PageMake/Resources/Documents/`，中英双语随系统语言切换）
- [ ] App Store Connect 填写「App 隐私」标签（数据收集类型声明）
- [ ] 容器空间环境变量配置 `APPLE_CLIENT_ID`
- [ ] iOS 端 `Config.baseURL` 改为空间域名
- [ ] 配置仓库变量 `PAGEMAKE_URL` 启用保活探测
- [ ] 配置 `MODELSCOPE_SPACE` / `MODELSCOPE_TOKEN` 启用 CI 自动部署

## 已知限制（第一版）

1. 单容器部署：单点故障（重启秒级恢复）、无 CDN（海外慢）、容量受机器限制（约 2 核 / 8GB + 持久盘，以空间控制台为准）
2. 存储配额：普通静态项目 ≤ 5MB，VIP ≤ 1MB，SVIP ≤ 100MB，Ultra 不设业务上限；
   后端项目按源码包计算，不含安装生成的 `node_modules`。实际仍受服务器磁盘与内存约束
3. 容器模式无 1MB body / 200ms CPU 限制（沿用分片协议是出于兼容）
4. Windows 无法本地编译 iOS → 依赖 CI macOS runner
5. 封号：用户举报 + 人工审核（第一版不做自动扫描）
6. 第一版不做：邮箱注册或邮箱密码登录、签名、App Store 上传、订阅、PHP、C++
7. npm / pnpm 项目运行用户代码：依赖安装最长 4 分钟、构建最长 3 分钟、启动等待 1 分钟；
   同时常驻 3 个后端进程，单进程堆上限 256MB，崩溃最多自动重启 3 次

## 许可

专有软件，保留所有权利。未经授权不得复制、分发或修改。
