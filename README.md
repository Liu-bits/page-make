# Page-make

静态网页托管工具：用户上传 zip 或单个 HTML/CSS/JS 文件，后台自动解压、找入口、诊断、生成可公开访问的链接。

- **iOS**：SwiftUI 纯原生实现 + AuthenticationServices（Sign in with Apple）
- **后端**：Node 22 容器（Docker），部署在 **ModelScope 创空间**（免费 CPU 空间，无按次调用限额）
- **构建**：GitHub Actions · `xcode-27` runner（macOS 27.0.1）· Xcode 27.0.0 · iOS 27.0 模拟器
- **许可**：GPL-3.0（公开仓库，不消耗私有 Actions 额度）

> 架构说明：后端代码原为 EdgeOne Pages Functions 编写（`backend/` 目录），后转移为
> Docker 容器自托管（ModelScope 创空间）。业务逻辑零改动，由 `docker/server.mjs`
> 适配层包成普通 Node HTTP 服务，存储由 EdgeOne KV 换成落盘（`DATA_DIR`）。
> 彻底转移后不再依赖 EdgeOne / Cloudflare，没有按次调用的免费额度墙。

## 目录结构

```
.
├── ios/                        # iOS App（XcodeGen 工程，CI 生成）
│   ├── project.yml             #   工程描述：cd ios && xcodegen generate
│   ├── PageMake/               #   源码（9 个页面 + 服务 + 模型 + 本地化中英 + 双语文档）
│   ├── PageMakeTests/          #   单元测试
│   └── scripts/resolve-simulator.mjs  # CI 模拟器解析（优先 iOS 27.0.1）
├── backend/                    # API 处理器（路由 + lib 库，容器与测试共用）
│   ├── api/                    #   auth / upload(init/chunk/finish/取消) / projects / status / refresh / files / feedback
│   ├── p/[projectId]/          #   公开访问（无需登录）
│   └── lib/                    #   kv / zip / diagnostics / deploy / apple-auth / process
├── docker/server.mjs           # 容器适配层（Node HTTP + 磁盘 KV）
├── Dockerfile                  # 自托管镜像（ModelScope 创空间 / 任意容器平台）
├── dev/run-tests.mjs           # 后端单元测试：node dev/run-tests.mjs
├── dev/test-server.mjs         # 容器冒烟测试（HTTP 全流程）：node dev/test-server.mjs
├── scripts/deploy-modelscope.sh # CI 部署：推送构建子集到创空间 Git
└── .github/workflows/
    ├── page-make.yaml          #   主 CI/CD（测试 + 部署）
    └── keepalive.yaml          #   保活探测（配置 PAGEMAKE_URL 变量后生效）
```

## 环境要求

| 项 | 版本 |
| --- | --- |
| iOS 编译 | `xcode-27` runner（= macOS 27.0.1 镜像）+ Xcode 27.0.0 GM（CI 精确锁定并校验） |
| 运行目标 | 优先 iOS 27.0.1 模拟器，回退 iOS 27.0（Apple 版本线无 27.0.1） |
| 后端 | Node 22（容器内零 npm 依赖，仅标准库） |
| 本地开发 | Windows 11（iOS 无法本地编译，由 GitHub Actions 的 macOS runner 完成） |

## 快速开始

### 本地测试（Windows）

```bash
# 后端逻辑测试（zip 解压 / 诊断 / 状态机 / 完整上传管线）
node dev/run-tests.mjs

# 容器冒烟测试（启动真实 HTTP 服务，跑完整上传 → 公开访问全流程）
node dev/test-server.mjs
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

## 部署到 ModelScope 创空间（唯一部署目标）

### 第一次部署（手动）

1. 在 [ModelScope](https://www.modelscope.cn) 创建创空间，SDK 类型选 **Docker**
2. 把本仓库同步到空间仓库（根目录 `Dockerfile` 即构建入口，服务监听 `0.0.0.0:7860`）
3. 创空间**环境变量**配置 `APPLE_CLIENT_ID`（iOS Bundle ID，校验 Apple 登录）
4. 上线后 iOS 端 `Config.baseURL` 改为空间域名

约定：数据持久化在 `/mnt/workspace/pagemake-data`（重启不丢）；链接**长期有效**（自托管无预览域名限制），直到用户删除项目。

### 之后每次提交（自动）

配置 GitHub 仓库后，push 到 main 且测试全绿即自动部署：

| 位置 | 名称 | 值 |
| --- | --- | --- |
| Variables | `MODELSCOPE_SPACE` | `用户名/空间名`（如 `liu20/pagemake`） |
| Secrets | `MODELSCOPE_TOKEN` | ModelScope API Token（控制台 → 个人中心 → 访问令牌） |

CI 会把容器构建所需的文件子集（`Dockerfile` + `backend/` + `docker/`）推送到创空间 Git，平台自动构建上线。未配置时自动跳过。

### 保活

创空间免费 CPU 空间为常驻运行态（官方要求空间保持 running，无 48 小时休眠规则）。保险起见已内置 `keepalive.yaml`：配置仓库变量 `PAGEMAKE_URL` 后每 10 分钟自动探测 `/healthz`，同时充当健康监控。Dockerfile 也带 `HEALTHCHECK`。也可用 UptimeRobot 免费档（5 分钟粒度）。

### 自托管注意事项

- **数据自行备份**：定期导出 `DATA_DIR`（/mnt/workspace 持久卷）
- **单点**：容器重启期间短暂不可用（Node 冷启动 1~2 秒，数据不丢）
- **网络**：国内快、海外慢（无 CDN）；用户主要在海外可改部署到 Oracle Always Free 等海外机房（同一镜像，零改动）
- `DEV_NO_AUTH=1` **仅限本地调试**，生产环境禁止设置（等于关闭登录）
- 容器模式下 App 内的「选线路」（EdgeOne / Cloudflare）两个选项均由本容器本地服务，体验一致；该选择暂时保留兼容，后续版本可能简化

## GitHub Actions

`push main / tag v* / PR` 触发：

| Job | runner | 内容 |
| --- | --- | --- |
| backend-test | ubuntu-latest | Node 22 后端单测 + 容器冒烟测试（HTTP 全流程）+ Docker 镜像构建校验 |
| ios-build | xcode-27（macOS 27.0.1） | Xcode 27.0.0 校验 → xcodegen → 编译（不签名）→ iOS 27.0 模拟器测试 |
| ipa | xcode-27（macOS 27.0.1） | 仅 main / tag：真机归档（不签名）→ 打包 **未签名 IPA** 产物（Actions 页面 Artifacts 下载） |
| deploy | ubuntu-latest | 仅 main 分支，推送构建子集到 ModelScope 创空间（需配置 `MODELSCOPE_SPACE` / `MODELSCOPE_TOKEN`） |

## API 一览

| 路由 | 说明 |
| --- | --- |
| `POST /api/auth` | Sign in with Apple 换 7 天会话凭证 |
| `POST /api/upload/init` | 初始化分片上传（校验线路选择，5MB 上限） |
| `POST /api/upload/chunk` | 上传分片（600KB/片） |
| `POST /api/upload/finish` | 完成上传，后台处理（processing → ready/failed） |
| `GET /api/projects` | 我的项目列表 |
| `POST /api/projects/paste` | 粘贴代码直接创建（HTML 必填，CSS/JS 可选，自动注入引用） |
| `GET/DELETE /api/projects/:id` | 详情 / 删除 |
| `GET /api/projects/:id/status` | 状态轮询（每 2 秒） |
| `POST /api/projects/:id/refresh` | 刷新链接（重新部署） |
| `POST/DELETE /api/projects/:id/files` | 增删文件 |
| `DELETE /api/upload/:uploadId` | 取消上传（清理临时分片） |
| `POST /api/feedback` | 反馈 / 举报 |
| `GET /p/:projectId` | 公开访问（无需登录；已下架有专门页面） |

## 核心规则

- 未登录：只能浏览公开链接，不能创建、管理、看诊断详情、选线路
- 创建网页必须登录；公开链接任何人可访问
- 每次创建都必须选线路，不设默认、不记住上次
- 语言：跟随 iOS 系统语言（中文/英文，其他默认英文），不提供手动切换
- 诊断详情是登录特权，未登录只显示「您的代码有错误」

## 上线前检查清单

- [x] 隐私政策 / 用户协议：App 内直接展示（`ios/PageMake/Resources/Documents/`，中英双语随系统语言切换）
- [ ] App Store Connect 填写「App 隐私」标签（数据收集类型声明）
- [ ] ModelScope 创空间环境变量配置 `APPLE_CLIENT_ID`
- [ ] iOS 端 `Config.baseURL` 改为创空间域名
- [ ] 配置仓库变量 `PAGEMAKE_URL` 启用保活探测
- [ ] 配置 `MODELSCOPE_SPACE` / `MODELSCOPE_TOKEN` 启用 CI 自动部署

## 已知限制（第一版）

1. 自托管单容器：单点故障（重启秒级恢复）、无 CDN（海外慢）、容量受机器限制（约 2 核 / 8GB + 持久盘，以创空间控制台为准）
2. 存储：每个项目 ≤ 5MB，磁盘满后无法再上传（可定期清理或扩容）
3. 容器模式无 1MB body / 200ms CPU 限制（沿用分片协议是出于兼容）
4. Windows 无法本地编译 iOS → 依赖 GitHub Actions macOS runner
5. 封号：用户举报 + 人工审核（第一版不做自动扫描）
6. 第一版不做：签名、App Store 上传、订阅、npm 后端、在线编辑

## License

[GPL-3.0](LICENSE)
