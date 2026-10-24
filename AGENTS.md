# AGENTS.md — Page-make 项目总纲（AI 操作手册）

> 本文件是后续 AI Agent 接手本项目的必读文件。涵盖：用户规定的工作规则、设备规格、
> 源码结构、功能清单、测试体系、CI/CD、账号配置、已知坑。**修改本项目前先读完本文。**

---

## 0. 最高优先级规则（用户规定，必须遵守）

1. **不允许自行部署、不要浪费时间等构建**：代码推送 + CI 全绿 + IPA 下载替换本地后，
   **通知用户去 ModelScope 创空间控制台部署**即可。不要反复探活、不要等空间构建、
  不要手动点「重新部署」（用户会自己操作）。ModelScope 自动构建经常不触发，
  这在用户预期内，不是 bug。
2. **提交顺序**：改代码 → 本地全量测试全绿 → `git commit`（中文详细 message）→
   `git push`（偶发 502/schannel 中断，重试 1-2 次即成功）→ 等 CI 四 job 全绿 →
   下载 IPA artifact 替换本地 `E:/Page-make/PageMake-unsigned.ipa` → 通知用户部署。
3. **本地 IPA 是旧版属正常**，最新版永远以 CI artifact（`PageMake-unsigned-ipa`）为准。
4. 全程**简体中文**回复；commit message 用中文、写清「问题/修复/新增/测试」。
5. `.workbuddy-ai/` 目录是项目数据（记忆/日志），**禁止删除**。
6. 本地无法编译 iOS（无 Xcode）——Swift 改动只能靠 CI 验证，提交前尽量复用文件中
   已验证过的写法（见第 8 节 Swift 坑）。
7. 每次实质性工作完成后，追加当日工作日志到 `.workbuddy-ai/memory/YYYY-MM-DD.md`。

---

## 1. 项目概述

- **是什么**：iOS App + 自托管后端，让用户在手机上创建/发布静态网页（类轻量 Netlify）。
  上传 ZIP、粘贴 HTML/CSS/JS、或虚拟文件夹管理器三种方式建站，生成公开链接分享。
- **仓库**：https://github.com/Liu-bits/page-make （公开，GPL-3.0）
- **技术栈**：
  - iOS：SwiftUI + XcodeGen（`ios/project.yml` 描述工程），最低 iOS 27.0，无第三方 SDK
    （Google 登录用 ASWebAuthenticationSession + PKCE 手写；二维码用 CoreImage）
  - 后端：Node.js **零 npm 依赖**（仅标准库），EdgeOne Pages Functions 风格 handler
    （`backend/index.js`），同一份代码跑在 ModelScope 创空间 Docker 容器
    （`docker/server.mjs` = Node HTTP 适配层 + DiskKV 磁盘 KV，API 与线上 KV 一致）
  - 存储：容器内 DiskKV（`DATA_DIR` 目录 JSON 文件，key 经 `encodeKey` hex 编码为文件名）
- **线上地址**：https://liu20150413-page-make.ms.show （ModelScope 创空间，端口 7860，
  `DATA_DIR=/mnt/workspace/pagemake-data` 持久卷）
- **Bundle ID**：`com.pagemake.app`（Sign in with Apple 的 aud 必须配此值）

---

## 2. 设备与环境规格（开发机 = Windows）

| 项 | 规格 / 路径 |
|---|---|
| OS | Windows（Git Bash 可用；bash 工具走 Git Bash 语法） |
| Node（首选 managed） | `C:/Users/liu20/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe` |
| Python（managed） | `C:/Users/liu20/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe` |
| Swift | 6.4 toolchain：`C:/Users/liu20/AppData/Local/Programs/Swift/Toolchains/6.4.0+Asserts/usr/bin/swiftc.exe`，**仅用于 `-parse` 语法检查**；运行前必须先清除大写 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY` 环境变量（大小写重复键导致 Swift runtime 崩溃） |
| Xcode | **本地没有**。iOS 编译/测试/打包全部靠 GitHub Actions |
| git 推送 | 必须走沙箱 HTTP 代理（如 `git -c http.proxy=http://127.0.0.1:18081 -c https.proxy=http://127.0.0.1:18081 push`；**端口随会话变化**，失败先探测当前代理端口），直连不通；偶发 502 重试即可 |
| 网络限制 | 沙箱**连不上 googleapis.com**（HTTP 000）；GitHub 可达。Google JWKS 种子只能由 CI runner 拉取（见第 8 节） |
| Docker | 本地可 `docker build` 校验镜像（CI 也有该步骤） |


---

## 3. 源码结构

```
E:/Page-make/
├── AGENTS.md                # 本文件
├── Have-not.md              # 已知限制/未做功能（过审披露用）
├── README.md                # 项目说明 + 上线清单
├── Dockerfile               # node:22-alpine，PORT=7860，ENTRYPOINT=server.mjs
├── PageMake-unsigned.ipa    # 本地 IPA 副本（gitignore，旧版正常，以 CI artifact 为准）
├── backend/                 # 后端全部代码（容器与 CI 测试共用同一份）
│   ├── index.js             #   EdgeOne 风格 handler（路由表在文件头部注释）
│   ├── admin.html           #   管理后台单页（/admin，PBKDF2 登录，token 存 sessionStorage）
│   ├── api/                 #   API 路由
│   │   ├── auth.js          #     Apple 登录（identityToken → JWKS 验签）
│   │   ├── auth/            #     delete(删账号) / google / guest / login / register
│   │   ├── config.js        #     公开配置 + JWKS 诊断（source=live/disk/seed）
│   │   ├── feedback.js      #     用户反馈（= 封禁申诉入口）
│   │   ├── admin/           #     login / action(ban/unban/deleteUser/createTestAccount/
│   │   │                    #       deleteTestAccount/deleteProject/setPassword) / overview
│   │   ├── projects.js      #     项目列表
│   │   ├── projects/        #     paste(粘贴建站) / explorer(项目模式) / [id].js(rename/delete)
│   │   │   └── [id]/        #       files(GET/POST) / refresh(刷新区间链接) / status
│   │   ├── stats.js         #     用量统计
│   │   └── upload/          #     init / chunk(600KB 分片) / finish / [uploadId](取消)
│   ├── lib/                 #   核心库
│   │   ├── kv.js            #     KV 抽象（EdgeOne KV / DiskKV 双实现）+ keys() 键空间
│   │   ├── state.js         #     全部业务常量（见第 4 节）
│   │   ├── session.js       #     会话（7 天 TTL）、requireAuth、isBanned、isTestUser
│   │   ├── password.js      #     PBKDF2（12 万轮+盐+恒定时间比较）
│   │   ├── jwks.js          #     JWKS 三级加载器（live 5s → 磁盘缓存 → 内置种子）
│   │   ├── google-auth.js / apple-auth.js   # 登录验签
│   │   ├── project.js       #     项目 CRUD + syncProjectFiles + deploySite(local 分支)
│   │   ├── process.js       #     ZIP 处理 + 上传管线（过滤 PHP）
│   │   ├── diagnostics.js   #     静态诊断（HTML 引用资源缺失检测）
│   │   ├── zip.js / base64.js / responses.js / admin.js
│   │   └── deploy/          #     edgeone / cloudflare（兼容旧客户端保留，当前只用 local）
│   ├── p/                   #   公开页路由：/p/<projectId>（含 [[default]] 宽容回退）
│   └── data/                #   JWKS 内置种子（apple/google-jwks.json，随镜像分发）
├── docker/server.mjs        # 容器入口：Node HTTP + DiskKV，ROOT 自动探测两种布局
├── ios/PageMake/            # iOS 端（37 个 Swift 文件）
│   ├── App/AppState.swift   #   全局状态、登录（Apple/Google/邮箱/游客）、封禁弹窗
│   ├── Models/              #   Project / Session / CreateSource / PasteTemplates(三套模板)
│   ├── Services/            #   APIClient(自定义头 X-Pagemake-Token) / AuthService /
│   │                        #   GoogleAuthService(ASWebAuthenticationSession+PKCE) /
│   │                        #   KeychainStore(deviceId 持久化) / UploadService
│   ├── Utilities/           #   Config(baseURL/ClientID) / L10n / PlainLanguage(错误码→人话) /
│   │                        #   DocumentStore(中英隐私政策) / FileValidator / LogStore
│   ├── Views/               #   RootView / ProjectListView(搜索排序重命名) / FilePickerView
│   │                        #   (上传+粘贴+模板) / ExplorerView(虚拟文件夹) / PreviewView /
│   │                        #   WebView / QRCodeView / BannedView / PasswordAuthView /
│   │                        #   SettingsView(统计/删账号/游客提示) / UploadQueueView 等 19 个
│   ├── Resources/           #   Documents/(中英 .txt) + en/zh-Hans.lproj（各 243 键，0 重复）
│   ├── PageMake.entitlements  # applesignin（免费 Apple ID 用不了，游客登录兜底）
│   └── PrivacyInfo.xcprivacy  # 隐私清单（过审）
├── ios/project.yml          # XcodeGen 描述（改工程结构改这里，勿直接改 xcodeproj）
├── ios/PageMakeTests/       # 5 个单测文件
├── dev/                     # 测试脚本（见第 5 节）+ make-zip.mjs
├── scripts/
│   ├── deploy-modelscope.sh # CI 部署：推送子集到创空间 Git → 平台自动构建
│   └── refresh-jwks.mjs     # 拉取官方 JWKS 写种子（失败保留旧种子）
└── .github/workflows/       # page-make.yaml(主 CI) / keepalive.yaml / jwks-refresh.yaml
```


---

## 4. 功能清单与业务常量

### 4.1 已上线功能

**登录（4 种方式）**
- Sign in with Apple（entitlement 已配；免费 Apple ID 无法启用该能力 → 游客兜底）
- Google OAuth（iOS Client ID `242453650088-...apps.googleusercontent.com`，已填 Config +
  后端 aud；ASWebAuthenticationSession + PKCE 手写，无 SDK）
- 邮箱密码（PBKDF2 12 万轮哈希；用户不存在/密码错误同一错误码不泄露账号存在性）
- 游客登录（deviceId → SHA-256 派生 `guest_<hash>`；**限 1 个项目；链接 10 分钟过期**；
  退出登录时清除 deviceId 重置身份）

**建站（3 种方式）**
- 上传 ZIP：分片 600KB × N（base64 后约 800KB/片），项目总上限 5MB；异步处理 + 轮询
- 粘贴代码：HTML 必填 + CSS/JS 可选（合计 300KB）；css/js 文件名自动跟随 HTML 的
  link href / script src；HTML 片段自动包裹完整文档；三套内置模板（主页/落地页/博客）
- 项目模式（Explorer）：Windows 风格资源管理器，支持路径栏/返回、文件与文件夹分区、
  详情、新建/重命名/删除、持久化空文件夹、发布后直接预览；单文件 900KB / 总 5MB；
  仅 html/css/js 白名单；路径安全（禁 `..`、`\`、控制字符）；新建 HTML 骨架自动引用
  style.css；publish 时 index.html 优先选入口 + 静态诊断

**公开页与服务端**
- `/p/<id>` 长期有效（登录用户）；游客 10 分钟；到期 410 中文过期页
- 宽容识别：静态 404 时按 basename（忽略目录/大小写）在项目内唯一匹配自动返回
- 静态诊断：HTML 引用的资源缺失 → 「引用了 x，其实在 y」提示
- PHP / C++：均不支持；ZIP 中的 `.php` 会跳过，项目模式拒绝 `.php`，公开路由对历史 `.php` 返回 404
- 入口选择统一：index.html → 任意 html（publish/findEntry/上传管线一致）
- 刷新链接（refresh.js，成功/失败均持久化 kvPut——曾有不写回的存量 bug）
- 反馈接口（App 内反馈 = 封禁申诉入口）；用量统计 /api/stats；账号删除（过审项）

**管理后台 /admin**（密码初始 123456，PBKDF2 哈希存储，改密用 setPassword）
- 封号 L1-L4（必填原因，用户端 BannedView 可见原因/等级/解封时间；封号同时全部项目
  下架，解封自动恢复——注意索引 key 取项目 ID 必须 decodeKey，曾有二次编码 bug）
- 删除账号（deleteUser：用户 + 全部项目含文件 + 全部会话 = 强制下线）
- 测试账号（createTestAccount：指定邮箱+密码；isTest 标识**豁免粘贴/上传/文件三处
  大小上限**；deleteTestAccount 仅允许删 isTest）
- 解封前所有登录入口（邮箱/Google/游客）均拦截

**iOS 端**
- Liquid Glass（iOS 26+ 原生 API：GlassEffectContainer / .glassEffect / .glassProminent）
- 项目列表搜索 + 排序（最新/最旧/名称/大小）+ 滑动重命名
- 二维码分享（CoreImage CIFilter.qrCodeGenerator + ShareLink）
- WebView 预览（reloadToken、轮询 150 次上限、runtimeErrors 去重上限 50）
- 中英本地化（各 243 键，0 重复）；错误码文案中立化（未知码显示码本身便于反馈定位）
- 隐私政策/用户协议 App 内展示（Documents 双语文档，文件名后缀区分语言）

### 4.2 业务常量（backend/lib/state.js，与 iOS 端保持一致）

| 常量 | 值 | 说明 |
|---|---|---|
| SESSION_TTL_SECONDS | 7 天 | 登录态有效期（到期前 1 天 iOS 静默刷新） |
| MAX_TOTAL_BYTES | 5MB | 项目总大小 |
| CHUNK_BYTES | 600KB | 分片大小 |
| UPLOAD_TTL_SECONDS | 30 分钟 | 未完成上传清理 |
| PASTE_MAX_BYTES | 300KB | 粘贴 HTML+CSS+JS 合计 |
| FILE_MAX_BYTES | 900KB | 项目模式单文件 |
| GUEST_LINK_TTL_SECONDS | 10 分钟 | 游客链接有效期 |
| BAN_LEVELS | L1/1天 L2/7天 L3/30天 L4/永久 | 封号分级（L4=色情暴恐恶意软件） |
| TAKEDOWN_RETENTION_SECONDS | 7 天 | 违规项目保留留证 |
| PROVIDERS | local（唯一） | edgeone/cloudflare 仅兼容旧客户端 |

---

## 5. 测试体系（共 127 项，提交前必须全绿）

| 命令 | 数量 | 内容 |
|---|---|---|
| `node dev/run-tests.mjs` | 39 | 单元测试（含 JWKS 三级加载、ZIP 炸弹防护、密码强度校验【leetspeak 变形/反向键盘对角线】、MIME 类型映射） |
| `node dev/test-server.mjs` | 45 | 容器冒烟（真实 HTTP 全流程，用 docker/server.mjs + 临时 DATA_DIR；含 ZIP PHP 过滤、历史 PHP 入口 404、zip 炸弹端到端、Explorer 空目录/重命名/目录迁移/冲突、反馈限流、删号 KV 残留断言、弱口令拒绝、登录 429 限速） |
| `node dev/test-guest-ttl.mjs` | 8 | 游客链路（真实游客会话/篡改磁盘 KV 模拟到期/身份重置） |
| `node dev/test-assets.mjs` | 25 | CSS/JS 引用全模式回归（诊断归一单测/粘贴完整/片段/`<head>` 缺失与只有 `<body>` 注入/内置模板逐字回归/子目录/`../`与`/`归一/查询串+type/外链忽略/ZIP 上传链路/explorer publish/PHP 拒绝/CSS 内部 url() 归一三链路/HTML 其他引用标签 img/iframe/source/a/form/srcset/外链与 data URI 原样保留/**CSS @import 字符串形式与注释/文本属性边界**） |
| `node dev/test-admin.mjs` | 10 | 后台（登录/哈希存储/测试账号权益/封禁下架+禁登/解封恢复/删号） |

> Node 用 managed 绝对路径运行。测试脚本坑：`fail()` 的 error 字段是错误码字符串本身；
> DiskKV 文件名 = `encodeKey(keys.project(id))`；DEV_NO_AUTH 下测试身份用 `X-Test-User` 头。


---

## 6. CI/CD 与部署链路

### 6.1 GitHub Actions（.github/workflows/）

| 工作流 | 触发 | 内容 |
|---|---|---|
| page-make.yaml | push/PR to main | 四 job：backend-test（Node22 跑 127 项）→ ios-build（**xcode-27 runner**：macOS 27.0.1 + Xcode 27.0.0，编译+单测）→ ipa（归档不签名 → ad-hoc codesign → artifact `PageMake-unsigned-ipa`，保留 14 天）→ deploy（仅 main：scripts/deploy-modelscope.sh） |
| keepalive.yaml | 每 10 分钟 | 探 `${PAGEMAKE_URL}/healthz`，**必须带 UA**（`-A "PageMake-Keepalive/1.0"`），并回显 /api/config 的 jwks 诊断 |
| jwks-refresh.yaml | 每日 02:37 | runner 拉官方 JWKS 写种子并提交（境内拉不到 Google，只能靠 runner） |

> 注意：deploy job 依赖 ios-build 通过；`if:` 表达式必须**单引号**（双引号导致整个
> workflow 校验失败、0s 失败无 job）；GitHub 无 macos-27 标签，正确标签是 **xcode-27**。

### 6.2 部署链路（用户负责最后一步）

```
push main → CI 全绿 → deploy job 把构建子集（Dockerfile + backend/ + docker/）
推送到创空间 Git（commit "deploy: <sha>"）→ ModelScope 平台自动构建（约 4 分钟）
→ 新实例上线
```

- **Agent 职责到此为止**：通知用户去控制台确认/点「重新部署」。平台自动构建偶尔
  不触发（历史多次遇到），用户手动点「重新部署」是标准操作，不要反复探活验证。
- 创空间仓库：`https://oauth2:TOKEN@www.modelscope.cn/studios/liu20150413/page-make.git`
  （MODELSCOPE_TOKEN 在 GitHub Secrets，MODELSCOPE_SPACE=liu20150413/page-make 在 Variables）
- 线上验证方法：`/api/config` 含 `jwks` 字段即新构建生效；Google `source:"seed"`、
  Apple `source:"live"` 为设计行为（境内容器拉不到 googleapis，种子回退生效）。

### 6.3 GitHub 仓库配置（已配好）
- Variables：`MODELSCOPE_SPACE`、`PAGEMAKE_URL`（保活用）
- Secrets：`MODELSCOPE_TOKEN`

---

## 7. 账号与配置信息

| 项 | 值 |
|---|---|
| Bundle ID | com.pagemake.app（APPLE_CLIENT_ID 环境变量验 Apple 登录 aud） |
| Google OAuth iOS Client ID | 242453650088-qm3mk3l3eg7b8ukraenl0gdufeuvc0dj.apps.googleusercontent.com |
| iOS baseURL | https://liu20150413-page-make.ms.show（Config.swift） |
| 管理后台 | /admin，初始密码 123456（PBKDF2 哈希，KV 无明文） |
| 线上测试账号 | verify@example.com（早期测试残留，可忽略） |
| 环境变量 | APPLE_CLIENT_ID / DATA_DIR / PORT(7860)；DEV_NO_AUTH 仅本地调试（=关闭鉴权，生产禁止） |
| IPA | 未签名（供 iLoader/TrollStore 类工具自签）；可安装 IPA 需 Apple 签名材料，已与用户确认此边界 |

---

## 8. 已知坑（必读，踩过一遍的不要踩第二次）

**ModelScope 网关三坑**（ms.show 域名）：
1. UA 拦截——curl 默认 UA 被拦（提示用 API 专用地址），必须带浏览器式/Keepalive UA；
   任何 App/浏览器 UA 均直通容器
2. Authorization 头拦截（误判 SDK Token）→ 鉴权头改 **X-Pagemake-Token**
   （后端优先读自定义头，兼容 Authorization）
3. DELETE 方法拦截（403）→ 删除类操作改 POST + action

**其他后端坑**：
- **密码强度别用「键盘物理坐标 + 相邻距离」判断**：试过用 (行,列) 坐标 +
  Chebyshev 距离判定键盘行走位，但不存在单一阈值能同时满足两个方向——
  要求 `1qaz2wsx3edc` 被判弱时，`Ab1#efgh`（b-1-e 恰好也相邻）必被误伤。
  加行偏移（模拟键盘错位）也无效。最终回到**显式枚举所有方向的走法串**
  （行正反/列正反/主对角线正反/次对角线正反/Shift 形态），逐个子串匹配
- **leetspeak 全串归一会污染词根边界**：`P@ssw0rd!` 归一成 `passwordi`、
  `4dm1n2024` 归一成 `adminzoza`，尾部符号/数字被当成字母，反而匹配不上原词根。
  正确做法是 `matchLeetPrefix` 逐字符比对，只比对词根长度范围内的字符
- **短词根不能做前缀/包含匹配**：`test`/`admin`/`login`/`secret` 这类 4-5 位词根
  配上「词根 + 任意尾巴」规则会把 `Test#Passw0rd1`、`AdminPanel2026` 误判。
  已拆分 `COMMON_ROOTS`（精确表）与 `PREFIX_ROOTS`（长度 >= 5 才参与前缀匹配），
  且**回退**了「词根出现在任意位置」的兜底（误伤率高于收益）
- **HTML 引用归一别只做 link/script**：`img/iframe/source/audio/video/track/
  embed/object/a/area/form` 全是同一根因，漏一个就有资源 404 或内页链接
  跳出站点外。`srcset` 是逗号分隔多值，必须逐候选归一，不能当单一路径折叠
- **CSS `@import` 有两种等价语法**：`url("../a.css")` 与 `"../a.css"` 字符串形式。
  只处理 url() 会漏掉字符串形式（`@import` 正则要单独写）。注意别误伤
  `@charset` / `@media` / `@font-face` 等其它 @ 规则
- `x-forwarded-proto` 可能是逗号分隔多值（"https, https"）→ 取第一个值，否则 URL 非法 500
- kvPut 直传对象会失败 → 已加自动 JSON 序列化；索引 key 后缀必须 decodeKey 后再查
  （双重编码 bug 出过**三**次：projects 列表 + banUser/unbanUser + **auth/delete.js 漏 decodeKey**
  → 删号只删了 user_ 记录，site_/project_/uproject_/meta_ 全残留，且 `/p/<id>` 公开链接
  继续 200 可访问；测试盲区：当时只断言 user_ 文件消失，没断言 KV 残留，现已补齐断言）
- **CSS/JS 断链「半截修复」坑（出过两次）**：入口页 URL 是 `/p/<id>`（**无尾斜杠**），
  用户写 `../style.css` 时浏览器解析成 `https://host/style.css`，直接跳出 `/p/` 前缀 → 404。
  只把**存储路径**归一（`normalizeRelPath`）而不改**下发 HTML 里的引用字符串** = 没修：
  实测存储是 style.css、`/p/<id>/style.css` 也 200，但页面引用仍是 `../style.css`。
  必须 `rewriteLocalRefs` 同步改写，且四条链路都要覆盖：粘贴 / ZIP 上传 / 项目模式 publish /
  测试盲区：旧用例只断言「资源 200」没断言「served HTML 里的引用字符串」，所以漏了一整轮；
  现在两条都断言。
- **静态诊断要与服务端用同一套路径归一**：diagnostics.js 曾只剥 `./` 和首部 `/`，
  没折叠 `..` → 文件存在却误报「引用了 ../style.css，但文件其实在 style.css」。
  诊断给用户看的是假告警，改 `normalizeRelPath` 后消掉。
- Dockerfile 里 server.mjs 在 /app/ 根目录，`resolve(__dirname,'..')` 会指向 / →
  ROOT 按 backend/ 实际位置自动探测（兼容两种布局）
 - ZIP 解压必须设「解压后总量」与「条目数」双上限：init 只校验压缩包 ≤ 5MB，
   306KB 的包能解出 300MB 打满容器持久卷（全站无法建站）→ lib/zip.js 已加实时拦截
   （ZIP_MAX_TOTAL_BYTES=32MB / ZIP_MAX_ENTRIES=500，超限抛 TOO_LARGE）
 - 未登录可写的接口（feedback 等）必须加 IP 限流：否则脚本可无限刷量打满 KV →
   lib/ratelimit.js 通用滑动窗口（admin 登录与 feedback 共用，每 IP 每分钟 5 次）
 - **文件路径必须经 `lib/paths.js` 的 normalizeRelPath 规范化后再入库**：外部路径来自
   用户 HTML 引用、ZIP 条目名、API 入参三处。漏规范化会导致「存 `../style.css`、
   浏览器请求被 URL 规范化成 /p/style.css」→ 404 断链，以及 ZIP 路径穿越
 - 识别 HTML 里的 link/script 引用**不能**用 `<tag[^>]+attr=["']([^"']+\.ext)["']`
   这类正则：`type="text/javascript"` 会抢先匹配、`a.js?v=1`（.ext 后带查询串）匹配不到，
   两者都会让「是否已引用」误判 → 重复注入 + 用户引用的文件 404。
   正确做法：先抓标签目标属性值，再按「剥查询串后的扩展名」筛选，并跳过外链/data URI
 - 加限速后跑测试套件要注意：**同套件共用一个 IP**，限速用例必须放文件最后，
   否则会把后续用例的注册/登录一起限掉（用户登录 8 次/分、注册 20 次/小时）
 - 密码不能只查长度：`password.js` 的 checkPasswordStrength 已含常见口令表、
   重复/连续序列、字符类别三类校验，新增任何设密码的入口都要复用它
 - 给已有文件加 import 时 apply_patch 可能静默失败（不报错但内容没进去）→
   改动后用 `node -e "import('file:///...').then(m=>console.log(...))"` 冒烟验证，
   否则会出现 `xxx is not defined` 且只在运行时暴露
- JWKS：Node fetch 无默认超时，境内连 googleapis 挂 75s+ → 三级加载（live 5s →
  DATA_DIR 磁盘缓存 → 内置种子）；种子由 CI/runner 刷新，**沙箱自己拉不到 Google**
- Dockerfile 的 `data/` ignore 只匹配根级，`backend/data/` 种子不受影响

**iOS/Swift 坑**（本地无 Xcode，只能靠 CI 验证）：
- SwiftUI `Section("标题"){ } footer:{ }`（头部字符串参数 + 双尾随闭包）**无匹配重载**
  → xcodebuild exit 65；改为 Section 内 Text 行
- Swift 计算属性块内不能有以 `get` 开头的方法调用（get 是访问器关键字）
- 本地验语法：`swiftc -parse`，**先删大写 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY**
  （大小写重复键导致 Swift runtime 崩溃）
- XcodeGen 把 Documents/*.txt 拍平到 .app 根目录 → 查找路径根目录优先+子目录兼容；
  语言放文件名后缀，不要建 zh-Hans/ 语言目录（variant group 重复拷贝报错）
- 归档不签名 + `codesign --force --sign - --entitlements` 手动 ad-hoc 签名
  （CODE_SIGNING_ALLOWED=NO 的构建不产出 .xcent）

**git/网络坑**：
- 推送偶发 502/schannel 中断 → 重试 1-2 次；推送必须走沙箱代理（端口随会话变化）
- CI 绿 ≠ 线上生效：ModelScope 自动构建可能不触发，deploy 后必须验证新接口
  （历史教训：游客登录"不行"实为镜像旧版缺 guest.js）
- 误提交过 ipa 临时解包目录 → .gitignore 已有 `ipa-*/`

---

## 9. 历史里程碑（2026-10-16 ~ 10-23）

1. **10-16** 第一版（iOS + EdgeOne Functions）；转容器化（ModelScope 创空间方案 B）；
   CI 自动部署配通；登录修复（补 applesignin entitlement + ad-hoc 签名）
2. **10-17** 粘贴代码建站；游客登录（免费 Apple ID 兜底）；Google 登录 + 邮箱密码；
   网关三坑规避（UA/X-Pagemake-Token/POST+action）；Liquid Glass；
   项目模式（虚拟文件夹）；平铺文件宽容识别；游客 10 分钟试用 + 后台合规；
   JWKS 三级加载修复境内 Google 登录（线上实证 google=seed/apple=live）
3. **管理后台三件套**：测试账号（豁免大小上限）/ 封禁全登录入口拦截 / 删号强制下线；
   修复 banUser 索引 key 二次编码存量 bug；管理员密码确认早已 PBKDF2
4. **10-23** 全流程交付（run 39101031130 四 job 全绿；IPA 584KB 替换本地；
   创空间自动构建上线并实证 JWKS 种子回退生效）

> 详细踩坑记录见 `.workbuddy-ai/memory/2026-10-16.md` 和 `2026-10-17.md`。

---

## 10. 历史里程碑（2026-10-24）

5. **CSS/JS 断链第三类根因：CSS 内部 url() 未归一**（`9904695`）
   - 前两轮修的是 HTML 的 `link/script` 引用字符串（`../style.css` 跳出 `/p/` 前缀）
     和 MIME 缺失（200 但 octet-stream）。这轮发现**独立第三类根因**：
     CSS 文件内部写 `url(../img/bg.png)`、`url(../fonts/f.woff2)` 时，
     该字符串原样存储并原样下发。CSS 以 `/p/<id>/style.css` 被 `<link>` 引入，
     浏览器按 **CSS 自身 URL**（而非入口页）解析相对引用 → 跳出 `/p/` 前缀 → 404。
     症状与前两类完全相同（资源不生效），但根因在 CSS 内容里，HTML 侧修复
     完全覆盖不到。本地复现证实两类 url() 均原样下发。
   - 修复：`lib/paths.js` 新增 `rewriteCssRefs`（覆盖 `url(x)`/`url("x")`/`url('x')`，
     外链与 data URI 原样保留）；下发侧 `p/[projectId]/[[default]].js` 统一改写
     （仅 `text/css`，二进制不碰）作为**所有链路的兜底**（编辑器直存也覆盖）；
     存储侧同步归一保持存访一致（paste / process / `[id].js`）
   - 测试新增 3 项（粘贴 / ZIP 上传 / explorer publish），test-assets 13→16，
     全量 105→108 项
   - **坑**：`localAssetRef(value, '')` 不能用——空扩展名会生成 `\.(?:[?#]|$)`
     正则，反而要求引用必须带小数点，漏判无扩展名引用。需写专用判断函数
6. **computer-use 触发 ModelScope 重新部署的实操坑**
   - Edge 未启动时 extension 通道不可见，必须先（提权）启动 Edge 才能
     `agent.browsers.get(id)`；`Start-Process msedge` 在沙箱内会静默失败
   - ModelScope 页面上「重新部署」文本出现多处，必须用元素**自身文本节点**
     （`childNodes` 里的 text node）过滤，`innerText` 会命中父容器和 `<script>`
   - **部署是否生效的判定信号**：settings 页「文件有更新，与已部署内容不一致」
     提示消失 = 新提交已部署；比轮询「构建中/运行中」可靠（版本号会持续自增，
     状态常驻「运行中」，容易误判）
   - Playwright `.click()` 在宽视口（2292px）下可能因目标点落在可滚动容器外
     而超时；`tab.click([x,y])` 坐标点击会导致 native pipe 断开。
     解法：先 `edge.user.claimTab` 重载页面，等提示消失再验证
   - Edge 扩展通道会断（`Browser is not available`），重启 Edge 后 browser id
     会变（3→4），需重新 `agent.browsers.list()` 取新 id
