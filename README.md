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
├── edge-functions/             # EdgeOne Pages Functions（平台自动识别）
│   ├── api/                    #   auth / upload(分片) / projects / status / refresh / files / feedback
│   ├── p/[projectId]/          #   公开访问（无需登录）
│   └── lib/                    #   kv / zip / diagnostics / deploy(edgeone+cloudflare) / apple-auth
├── dev/run-tests.mjs           # 后端单元测试（Node 22，零依赖）：node dev/run-tests.mjs
├── scripts/                    # CI 部署脚本（EdgeOne 主线路 / Cloudflare 占位）
└── .github/workflows/page-make.yaml
```

## 环境要求

| 项 | 版本 |
| --- | --- |
| iOS 编译 | macOS 27 runner + Xcode 27.0.1 |
| 运行目标 | iOS 27.0.1 模拟器（未安装时回退已安装的最新 iOS 运行时） |
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

## GitHub Actions

`push main / tag v* / PR` 触发：

| Job | runner | 内容 |
| --- | --- | --- |
| backend-test | ubuntu-latest | Node 22 跑后端单元测试 |
| ios-build | macos-27 | Xcode 27.0.1 校验 → xcodegen → 编译（不签名）→ 模拟器测试 |
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
