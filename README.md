# Page-make

静态网页托管工具：用户上传 zip 或单个 HTML/CSS/JS 文件，后台自动解压、找入口、诊断、部署，生成可公开访问的链接。

- **iOS**：SwiftUI + ZIPFoundation 风格纯原生实现 + AuthenticationServices（Sign in with Apple）
- **后端**：EdgeOne Pages Functions + EdgeOne KV（主线路）
- **备选线路**：Cloudflare Pages（Direct Upload）
- **构建**：GitHub Actions · macos-27 runner · Xcode 27.0.1 · iOS 27.0.1 模拟器
- **许可**：GPL-3.0（公开仓库，不消耗私有 Actions 额度）

## 目录结构

```
.
├── ios/                        # iOS App（XcodeGen 工程，CI 生成）
│   ├── project.yml             #   工程描述：cd ios && xcodegen generate
│   ├── PageMake/               #   源码（9 个页面 + 服务 + 模型 + 本地化中英）
│   ├── PageMakeTests/          #   单元测试
│   └── scripts/resolve-simulator.mjs  # CI 模拟器解析（优先 iOS 27.0.1）
├── edge-functions/             # EdgeOne Pages Functions（平台自动识别；容器版复用同一份代码）
│   ├── api/                    #   auth / upload(分片) / projects / status / refresh / files / feedback
│   ├── p/[projectId]/          #   公开访问（无需登录）
│   └── lib/                    #   kv / zip / diagnostics / deploy(edgeone+cloudflare) / apple-auth
├── docker/server.mjs           # 容器适配层（Node HTTP + 磁盘 KV，复用全部边缘函数）
├── Dockerfile                  # 自托管镜像（ModelScope 创空间 / 任意容器平台）
├── dev/run-tests.mjs           # 后端单元测试：node dev/run-tests.mjs
├── dev/test-server.mjs         # 容器冒烟测试（HTTP 全流程）：node dev/test-server.mjs
├── scripts/                    # CI 部署脚本（EdgeOne 主线路 / Cloudflare 占位）
└── .github/workflows/
    ├── page-make.yaml          #   主 CI/CD
    └── keepalive.yaml          #   保活探测（自托管模式，配置 PAGEMAKE_URL 变量后生效）
```

## 环境要求

| 项 | 版本 |
| --- | --- |
| iOS 编译 | `xcode-27` runner（= macOS 27.0.1 镜像）+ Xcode 27.0.0 GM（CI 精确锁定并校验） |
| 运行目标 | 优先 iOS 27.0.1 模拟器，回退 iOS 27.0（Apple 版本线无 27.0.1，Xcode 27.0.1 同理） |
| 后端测试 | Node 22 |
| 本地开发 | Windows 11（iOS 无法本地编译，由 GitHub Actions 的 macOS runner 完成） |

## 快速开始

### 本地（Windows）

```bash
# 后端逻辑测试（zip 解压 / 诊断 / 状态机 / 完整上传管线）
node dev/run-tests.mjs

# iOS 工程生成（CI 里自动执行，本地有 macOS 时）
cd ios && xcodegen generate && xcodebuild -scheme PageMake ...
```

### 部署后端到 EdgeOne Pages

```bash
npm install -g edgeone
edgeone makers deploy -n <项目名> -t <EDGEONE_API_TOKEN>
```

控制台配置：

1. 存储 → KV 存储 → 创建命名空间 → 绑定到项目，**变量名固定 `PAGEMAKE`**
2. 环境变量：`APPLE_CLIENT_ID`（iOS Bundle ID）、Cloudflare 三件套（备选线路）

### iOS 端接入

打开 `ios/PageMake/Utilities/Config.swift`，把 `baseURL` 改成部署后的 EdgeOne Pages 域名。

## 方案 B：Docker 自托管（完全免费，无调用限额）

EdgeOne / Cloudflare 都有按次调用的免费额度墙；把后端打包成 Docker 容器跑在**免费容器平台**（推荐 ModelScope 创空间）就没有这个问题——限制只有机器本身的 CPU / 内存 / 磁盘，没有按次计费。

容器版复用 `edge-functions/` 全部处理器（**业务逻辑零改动**），仅把 KV 换成落盘存储、静态文件由 `/p/` 路由本地提供。

### 部署到 ModelScope 创空间（免费 CPU 空间，推荐）

1. 在 ModelScope 创建创空间，SDK 类型选 **Docker**
2. 把本仓库同步到空间仓库（根目录 `Dockerfile` 即构建入口）
3. 创空间环境变量配置 `APPLE_CLIENT_ID`（iOS Bundle ID）
4. 上线后 iOS 端 `Config.baseURL` 改为空间域名即可

约定：服务监听 `0.0.0.0:7860`，数据持久化在 `/mnt/workspace/pagemake-data`（重启不丢）。

### 本地运行

```bash
# 方式一：不用 Docker，直接 Node 跑
DATA_DIR=./data node docker/server.mjs        # 监听 7860

# 方式二：Docker
docker build -t pagemake .
docker run -p 7860:7860 -e APPLE_CLIENT_ID=com.pagemake.app pagemake

# 本地调试可跳过登录鉴权（生产禁止！）
DEV_NO_AUTH=1 DATA_DIR=./data node docker/server.mjs
```

### 保活

创空间免费 CPU 空间为常驻运行态（官方要求空间保持 running，无 48 小时休眠规则）。保险起见已内置 `keepalive.yaml`：配置仓库变量 `PAGEMAKE_URL` 后每 10 分钟自动探测 `/healthz`，同时充当健康监控。也可用 UptimeRobot 免费档（5 分钟粒度）。

### 自托管注意事项

- **数据自行备份**：定期导出 `DATA_DIR`（/mnt/workspace 持久卷）
- **单点**：容器重启期间短暂不可用（Node 冷启动 1~2 秒，数据不丢）
- **网络**：国内快、海外慢（无 CDN）；用户主要在海外可改部署到 Oracle Always Free 等海外机房（同一镜像，零改动）
- `DEV_NO_AUTH=1` **仅限本地调试**，生产环境禁止设置（等于关闭登录）
- Cloudflare 线路未配置凭证时自动降级为容器本地服务（链接长期有效），无需额外配置

## GitHub Actions

`push main / tag v* / PR` 触发：

| Job | runner | 内容 |
| --- | --- | --- |
| backend-test | ubuntu-latest | Node 22 后端单测 + 容器冒烟测试（HTTP 全流程）+ Docker 镜像构建校验 |
| ios-build | xcode-27（macOS 27.0.1） | Xcode 27.0.0 校验 → xcodegen → 编译（不签名）→ iOS 27.0 模拟器测试 |
| deploy | ubuntu-latest | 仅 main 分支，依赖前两者全部通过 |

需要的 Secrets（Settings → Secrets and variables → Actions）：

- `EDGEONE_API_TOKEN` — EdgeOne 部署令牌（第一版实际使用）
- `CLOUDFLARE_API_TOKEN` — 备选线路占位
- `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` — 第一版占位，不启用

## API 一览

| 路由 | 说明 |
| --- | --- |
| `POST /api/auth` | Sign in with Apple 换 7 天会话凭证 |
| `POST /api/upload/init` | 初始化分片上传（校验 provider，5MB 上限） |
| `POST /api/upload/chunk` | 上传分片（600KB/片，规避 1MB body 限制） |
| `POST /api/upload/finish` | 完成上传，后台处理（processing → ready/failed） |
| `GET /api/projects` | 我的项目列表 |
| `GET/DELETE /api/projects/:id` | 详情 / 删除 |
| `GET /api/projects/:id/status` | 状态轮询（每 2 秒） |
| `POST /api/projects/:id/refresh` | 刷新链接（EdgeOne 3 小时限制） |
| `POST/DELETE /api/projects/:id/files` | 增删文件 |
| `POST /api/feedback` | 反馈 / 举报 |
| `GET /p/:projectId` | 公开访问（无需登录；已下架 / 已过期有专门页面） |

## 核心规则

- 未登录：只能浏览公开链接，不能创建、管理、看诊断详情、选线路
- 创建网页必须登录；公开链接任何人可访问
- 每次创建都必须选线路，不设默认、不记住上次
- 语言：跟随 iOS 系统语言（中文/英文，其他默认英文），不提供手动切换
- 诊断详情是登录特权，未登录只显示「您的代码有错误」

## 已知限制（第一版）

1. EdgeOne 默认域名 3 小时预览限制 → `expiresAt` = 3 小时，用户手动刷新链接续期（自定义域名可解除限制）
2. Cloudflare `*.pages.dev` 国内访问不稳（已知问题，App 内向用户说明）
3. EdgeOne Functions 单请求 body ≤ 1MB → 分片上传
4. EdgeOne Functions CPU 200ms → 上传处理走 `waitUntil` 异步 + 状态轮询
5. KV 最终一致性（边缘缓存 ≤60s）→ 分片读取带重试
6. Windows 无法本地编译 iOS → 依赖 GitHub Actions macOS runner
7. 封号：用户举报 + 人工审核（第一版不做自动扫描）
8. 第一版不做：签名、App Store 上传、订阅、npm 后端、在线编辑

## License

[GPL-3.0](LICENSE)
