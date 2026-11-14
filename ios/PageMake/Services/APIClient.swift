import Foundation

/// API 错误
enum APIError: LocalizedError, Equatable {
    case invalidURL
    case network
    case decoding
    case http(status: Int, code: String?)
    case banned(ban: BanInfo)

    var errorDescription: String? {
        switch self {
        case .invalidURL, .network, .decoding: return L10n.string("error_network")
        case .http(_, let code): return code.map(PlainLanguage.message(forErrorCode:)) ?? L10n.string("error_generic")
        case .banned: return L10n.string("banned_title")
        }
    }
}

/// 后端 API 客户端
final class APIClient {
    static let shared = APIClient()

    var baseURL: URL = Config.baseURL
    private(set) var token: String?

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        // 后端字段为 camelCase；配置 snake_case 兼容对未来改动免疫（无下划线的 key 不受影响）
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()
    private let encoder = JSONEncoder()

    private init() {}

    func setToken(_ token: String?) {
        self.token = token
    }

    // MARK: - 请求基座

    private func request(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = "application/json",
        requiresAuth: Bool = true,
        maxAttempts: Int? = nil,
        timeout: TimeInterval = 25
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.invalidURL
        }
        // 读请求允许短暂重试：服务冷启动时网关会先返回 502/503，
        // 首开直接弹“网络出错”其实是可恢复的启动抖动。写请求绝不自动重试，
        // 避免重复创建项目或重复上传分片。
        let attempts = max(1, maxAttempts ?? ((method == "GET" || method == "HEAD") ? 3 : 1))
        var lastError: Error = APIError.network

        for attempt in 1...attempts {
            if Task.isCancelled { throw CancellationError() }
            var req = URLRequest(url: url)
            req.httpMethod = method
            req.timeoutInterval = timeout
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body {
                req.httpBody = body
                if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
            }
            if requiresAuth, let token {
                // 自定义头：网关会拦截 Authorization（误判为 SDK Token）
                req.setValue(token, forHTTPHeaderField: "X-Pagemake-Token")
            }

            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await URLSession.shared.data(for: req)
            } catch {
                lastError = error
                if attempt < attempts {
                    try? await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
                    continue
                }
                throw APIError.network
            }
            guard let http = response as? HTTPURLResponse else {
                lastError = APIError.network
                if attempt < attempts {
                    try? await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
                    continue
                }
                throw APIError.network
            }

            if http.statusCode == 403,
               let payload = try? decoder.decode(ErrorPayload.self, from: data),
               payload.error == "BANNED",
               let ban = payload.ban {
                throw APIError.banned(ban: ban)
            }

            if (500...599).contains(http.statusCode), attempt < attempts {
                let payload = try? decoder.decode(ErrorPayload.self, from: data)
                lastError = APIError.http(status: http.statusCode, code: payload?.errorCode ?? payload?.error)
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 900_000_000)
                continue
            }

            guard (200..<300).contains(http.statusCode) else {
                let payload = try? decoder.decode(ErrorPayload.self, from: data)
                throw APIError.http(status: http.statusCode, code: payload?.errorCode ?? payload?.error)
            }
            return data
        }
        throw lastError
    }

    // MARK: - 鉴权

    struct AuthRequest: Encodable {
        let identityToken: String
        let nonce: String
    }

    func authenticate(identityToken: String, nonce: String) async throws -> AuthResponse {
        let body = try encoder.encode(AuthRequest(identityToken: identityToken, nonce: nonce))
        let data = try await request("/api/auth", method: "POST", body: body, requiresAuth: false)
        return try decoder.decode(AuthResponse.self, from: data)
    }

    /// Google 登录（id_token 由 App 端 OAuth 换取，后端验签）
    func googleAuthenticate(idToken: String) async throws -> AuthResponse {
        let body = try encoder.encode(GoogleAuthRequest(idToken: idToken))
        let data = try await request("/api/auth/google", method: "POST", body: body, requiresAuth: false)
        return try decoder.decode(AuthResponse.self, from: data)
    }

    struct GoogleAuthRequest: Encodable {
        let idToken: String
    }

    /// 游客登录（设备 ID 免密，免费 Apple ID 环境的兜底）
    func guestAuthenticate(deviceId: String) async throws -> AuthResponse {
        let body = try encoder.encode(GuestAuthRequest(deviceId: deviceId))
        let data = try await request("/api/auth/guest", method: "POST", body: body, requiresAuth: false)
        return try decoder.decode(AuthResponse.self, from: data)
    }

    struct GuestAuthRequest: Encodable {
        let deviceId: String
    }

    // MARK: - 项目

    struct ProjectsPayload: Decodable {
        let projects: [Project]
        let role: AccountRole?
        let accountKind: AccountKind?
        let quota: AccountQuota?
    }

    struct ProjectListResult {
        let projects: [Project]
        let account: AccountSnapshot?
    }

    func listProjects() async throws -> ProjectListResult {
        let data = try await request("/api/projects")
        let payload = try decoder.decode(ProjectsPayload.self, from: data)
        let account = payload.role.flatMap { role in
            payload.accountKind.map { AccountSnapshot(role: role, accountKind: $0, quota: payload.quota) }
        }
        return ProjectListResult(projects: payload.projects, account: account)
    }

    /// 读取单个项目详情（资源管理器刷新）
    func project(_ id: String) async throws -> Project {
        let data = try await request("/api/projects/\(id)")
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    /// 重命名项目（POST + action=rename）
    func renameProject(_ id: String, name: String) async throws -> Project {
        let body = try encoder.encode(RenameRequest(action: "rename", name: name))
        let data = try await request("/api/projects/\(id)", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    struct RenameRequest: Encodable {
        let action: String
        let name: String
    }

    /// 用量统计
    func stats() async throws -> UserStats {
        let data = try await request("/api/stats")
        return try decoder.decode(StatsPayload.self, from: data).stats
    }

    struct StatsPayload: Decodable {
        let stats: UserStats
        let role: AccountRole?
        let accountKind: AccountKind?
        let quota: AccountQuota?
    }

    /// 读取最新账号权益。管理后台升级 VIP 后用于无需重登即时刷新。
    func accountSnapshot() async throws -> AccountSnapshot {
        let data = try await request("/api/stats")
        let payload = try decoder.decode(StatsPayload.self, from: data)
        guard let role = payload.role, let accountKind = payload.accountKind else {
            throw APIError.decoding
        }
        return AccountSnapshot(role: role, accountKind: accountKind, quota: payload.quota)
    }

    /// 删除项目（网关拦截 DELETE 方法，改用 POST + action）
    func deleteProject(_ id: String) async throws {
        let body = try encoder.encode(ActionRequest(action: "delete"))
        _ = try await request("/api/projects/\(id)", method: "POST", body: body)
    }

    /// 粘贴代码直接创建网页（同步返回 ready 项目，无需轮询）
    func createPastedProject(
        provider: HostProvider,
        html: String,
        css: String,
        js: String = "",
        name: String
    ) async throws -> Project {
        let body = try encoder.encode(PasteRequest(
            provider: provider.rawValue,
            html: html,
            css: css,
            js: js,
            name: name
        ))
        let data = try await request("/api/projects/paste", method: "POST", body: body)
        return try decoder.decode(PasteResponse.self, from: data).project
    }

    struct PasteRequest: Encodable {
        let provider: String
        let html: String
        let css: String
        let js: String
        let name: String
    }

    struct PasteResponse: Decodable {
        let project: Project
    }

    /// 取消上传：清理后端已上传的临时分片（POST + action，网关拦截 DELETE）
    func cancelUpload(uploadId: String) async throws {
        let body = try encoder.encode(ActionRequest(action: "cancel"))
        _ = try await request("/api/upload/\(uploadId)", method: "POST", body: body)
    }

    func refreshLink(_ id: String) async throws -> Project {
        let data = try await request("/api/projects/\(id)/refresh", method: "POST", body: Data())
        let payload = try decoder.decode(ProjectPayload.self, from: data)
        return payload.project
    }

    func projectStatus(_ id: String) async throws -> ProjectStatusResponse {
        // 大文件部署时服务端同步写盘会短暂阻塞事件循环，
        // 25s 默认超时可能在这个窗口内触发「网络出错」。
        let data = try await request(
            "/api/projects/\(id)/status",
            timeout: 60
        )
        return try decoder.decode(ProjectStatusResponse.self, from: data)
    }

    /// 后端项目的安装/构建/启动在服务端异步执行；客户端统一轮询到终态。
    /// 900 次 × 2 秒 = 30 分钟：SVIP 服务端超时约 18 分钟、Ultra 约 23 分钟，
    /// 12 分钟窗口会在 Ultra 大项目上提前放弃，把「仍在部署」误报成失败。
    func waitForProjectReady(_ id: String, maxAttempts: Int = 900) async throws -> Project {
        for attempt in 0..<maxAttempts {
            if Task.isCancelled { throw CancellationError() }
            if attempt > 0 {
                try await Task.sleep(
                    nanoseconds: UInt64(Config.pollIntervalSeconds * 1_000_000_000)
                )
            }
            let response = try await projectStatus(id)
            switch response.status {
            case .ready:
                if let project = response.project { return project }
            case .failed:
                throw APIError.http(status: 500, code: response.errorCode)
            case .expired:
                throw APIError.http(status: 410, code: "EXPIRED")
            case .uploading, .processing:
                continue
            }
        }
        throw APIError.http(status: 408, code: "RUNTIME_TIMEOUT")
    }

    // MARK: - 上传（分片，规避单请求 1MB body 限制）

    struct UploadInitRequest: Encodable {
        let provider: String
        let files: [FileMeta]
        let name: String
        let kind: String

        struct FileMeta: Encodable {
            let name: String
            let size: Int64
        }
    }

    struct UploadInitResponse: Decodable {
        let uploadId: String
        let chunkSize: Int
    }

    struct UploadChunkRequest: Encodable {
        let uploadId: String
        let fileIndex: Int
        let chunkIndex: Int
        let data: String
    }

    struct UploadFinishRequest: Encodable {
        let uploadId: String
    }

    struct UploadFinishResponse: Decodable {
        let projectId: String
        let status: String
    }

    func initUpload(
        provider: HostProvider,
        files: [PickedFile],
        name: String,
        kind: ProjectKind = .staticSite
    ) async throws -> UploadInitResponse {
        let body = try encoder.encode(UploadInitRequest(
            provider: provider.rawValue,
            files: files.map { .init(name: $0.name, size: $0.size) },
            name: name,
            kind: kind.rawValue
        ))
        let data = try await request("/api/upload/init", method: "POST", body: body)
        return try decoder.decode(UploadInitResponse.self, from: data)
    }

    func uploadChunk(uploadId: String, fileIndex: Int, chunkIndex: Int, data: Data) async throws {
        let body = try encoder.encode(UploadChunkRequest(
            uploadId: uploadId,
            fileIndex: fileIndex,
            chunkIndex: chunkIndex,
            data: data.base64EncodedString()
        ))
        _ = try await request("/api/upload/chunk", method: "POST", body: body)
    }

    func finishUpload(uploadId: String) async throws -> UploadFinishResponse {
        let body = try encoder.encode(UploadFinishRequest(uploadId: uploadId))
        let data = try await request("/api/upload/finish", method: "POST", body: body)
        return try decoder.decode(UploadFinishResponse.self, from: data)
    }

    // MARK: - 文件管理

    struct AddFileRequest: Encodable {
        let path: String
        let content: String
    }

    struct RemoveFileRequest: Encodable {
        let action: String
        let path: String
    }

    struct ExplorerActionRequest: Encodable {
        let action: String
        let path: String?
        let from: String?
        let to: String?
    }

    struct ActionRequest: Encodable {
        let action: String
    }

    func addFile(projectId: String, path: String, content: Data) async throws -> Project {
        let body = try encoder.encode(AddFileRequest(path: path, content: content.base64EncodedString()))
        let data = try await request("/api/projects/\(projectId)/files", method: "POST", body: body)
        let payload = try decoder.decode(ProjectPayload.self, from: data)
        return payload.project
    }

    /// 删除文件（POST + action=remove，网关拦截 DELETE）
    func deleteFile(projectId: String, path: String) async throws -> Project {
        let body = try encoder.encode(RemoveFileRequest(action: "remove", path: path))
        let data = try await request("/api/projects/\(projectId)/files", method: "POST", body: body)
        let payload = try decoder.decode(ProjectPayload.self, from: data)
        return payload.project
    }

    /// 创建文件夹（支持多级路径，空文件夹会持久化）
    func createFolder(projectId: String, path: String) async throws -> Project {
        let body = try encoder.encode(ExplorerActionRequest(
            action: "createFolder", path: path, from: nil, to: nil
        ))
        let data = try await request("/api/projects/\(projectId)/files", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    /// 删除文件夹及其全部子文件
    func deleteFolder(projectId: String, path: String) async throws -> Project {
        let body = try encoder.encode(ExplorerActionRequest(
            action: "removeFolder", path: path, from: nil, to: nil
        ))
        let data = try await request("/api/projects/\(projectId)/files", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    /// 重命名文件或文件夹
    func renameEntry(projectId: String, from: String, to: String) async throws -> Project {
        let body = try encoder.encode(ExplorerActionRequest(
            action: "rename", path: nil, from: from, to: to
        ))
        let data = try await request("/api/projects/\(projectId)/files", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    // MARK: - 运行日志 / 表单收集 / 快照

    struct RuntimeLogsPayload: Decodable {
        let logs: String?
        let running: Bool
    }

    /// 后端项目最近运行日志（stdout/stderr 环形缓冲；进程未运行时 logs 为 nil）
    func runtimeLogs(projectId: String) async throws -> RuntimeLogsPayload {
        let data = try await request("/api/projects/\(projectId)/logs", method: "GET")
        return try decoder.decode(RuntimeLogsPayload.self, from: data)
    }

    struct FormListPayload: Decodable {
        let submissions: [FormSubmission]
        let count: Int
    }

    struct FormActionRequest: Encodable {
        let action: String
        var id: String? = nil
    }

    /// 表单提交列表（静态站 /p/<id>/__form 收集的数据）
    func formSubmissions(projectId: String) async throws -> FormListPayload {
        let data = try await request("/api/projects/\(projectId)/form", method: "GET")
        return try decoder.decode(FormListPayload.self, from: data)
    }

    /// 删除单条表单提交
    func deleteFormSubmission(projectId: String, submissionId: String) async throws {
        let body = try encoder.encode(FormActionRequest(action: "delete", id: submissionId))
        _ = try await request("/api/projects/\(projectId)/form", method: "POST", body: body)
    }

    /// 清空全部表单提交
    func clearFormSubmissions(projectId: String) async throws {
        let body = try encoder.encode(FormActionRequest(action: "clear", id: nil))
        _ = try await request("/api/projects/\(projectId)/form", method: "POST", body: body)
    }

    struct SnapshotPayload: Decodable {
        let snapshot: SnapshotInfo?
    }

    struct SnapshotActionRequest: Encodable {
        let action: String
    }

    struct SnapshotResultPayload: Decodable {
        let created: Bool?
        let restored: Int?
        let deleted: Bool?
        let fileCount: Int?
        let entryPath: String?
    }

    /// 快照信息（无备份返回 nil）
    func snapshotInfo(projectId: String) async throws -> SnapshotInfo? {
        let data = try await request("/api/projects/\(projectId)/snapshot", method: "GET")
        return try decoder.decode(SnapshotPayload.self, from: data).snapshot
    }

    /// 快照操作：create（备份当前版本，覆盖旧备份）/ restore（回滚到备份点）/ delete
    @discardableResult
    func snapshotAction(projectId: String, action: String) async throws -> SnapshotResultPayload {
        let body = try encoder.encode(SnapshotActionRequest(action: action))
        let data = try await request("/api/projects/\(projectId)/snapshot", method: "POST", body: body)
        return try decoder.decode(SnapshotResultPayload.self, from: data)
    }

    // MARK: - 项目模式（虚拟文件管理器）

    struct ExplorerCreateRequest: Encodable {
        let name: String
        let kind: String
    }

    /// 创建空白项目（项目模式：初始无文件无链接，逐个创建文件后 publish）
    func createExplorerProject(name: String, kind: ProjectKind = .staticSite) async throws -> Project {
        let body = try encoder.encode(ExplorerCreateRequest(name: name, kind: kind.rawValue))
        let data = try await request("/api/projects/explorer", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    struct FileContentPayload: Decodable {
        let path: String
        let content: String
    }

    /// 读取文本文件内容（编辑器载入用）
    func readTextFile(projectId: String, path: String) async throws -> String {
        // 不能用 `.urlQueryAllowed`：它会放行 `+ & = ? ;` 等子分隔符，
        // `C++.html` 拼进查询串后会被服务端解析成 `C  .html`（读文件必然 404）。
        // 统一交给 URLComponents 按 queryItems 编码，由它决定哪些字符需要转义。
        guard var components = URLComponents(
            url: URL(string: "/api/projects/\(projectId)/files", relativeTo: baseURL) ?? baseURL,
            resolvingAgainstBaseURL: true
        ) else { throw APIError.invalidURL }
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        // URLComponents 不转义 `+`（RFC 3986 允许它出现在 query 中），但服务端用
        // URLSearchParams 解析，会把 `+` 当成空格 —— `C++.html` 仍会被读成
        // `C  .html`。这里显式把 `+` 编码成 %2B。
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw APIError.invalidURL }
        let data = try await request(url.absoluteString)
        let payload = try decoder.decode(FileContentPayload.self, from: data)
        guard let bytes = Data(base64Encoded: payload.content),
              let text = String(data: bytes, encoding: .utf8) else {
            throw APIError.decoding
        }
        return text
    }

    /// 生成公开链接（publish：选入口 → 静态诊断 → 返回带 url 的项目）
    func publishProject(_ id: String, kind: ProjectKind? = nil) async throws -> Project {
        let payload = PublishRequest(action: "publish", kind: kind?.rawValue)
        let body = try encoder.encode(payload)
        let data = try await request("/api/projects/\(id)", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    struct PublishRequest: Encodable {
        let action: String
        let kind: String?
    }

    /// 导出项目为 ZIP（备份）。返回原始字节，由调用方写入临时文件后分享。
    func exportProject(_ id: String) async throws -> Data {
        try await request("/api/projects/\(id)/export", method: "GET", requiresAuth: true)
    }

    // MARK: - VIP 升级申请

    struct VIPRequestPayload: Decodable {
        let request: VIPUpgradeRequest?
    }

    struct VIPRequestEnvelope: Encodable {
        let note: String
    }

    /// 读取当前账号的等级、下一档与申请状态。
    /// 服务端契约：`{ tier, nextTier, canApply, request }`；nextTier 为 null 表示已到顶。
    func vipUpgradeRequestStatus() async throws -> VIPRequestStatus {
        let data = try await request("/api/vip-request")
        return try decoder.decode(VIPRequestStatus.self, from: data)
    }

    /// 提交升级申请；重复提交时后端返回原记录（409 ALREADY_PENDING），不会生成重复工单。
    @discardableResult
    func submitVIPUpgradeRequest(note: String) async throws -> VIPUpgradeRequest {
        let body = try encoder.encode(VIPRequestEnvelope(note: note))
        let data = try await request("/api/vip-request", method: "POST", body: body)
        guard let result = try decoder.decode(VIPRequestPayload.self, from: data).request else {
            throw APIError.decoding
        }
        return result
    }

    // MARK: - 账号删除（App Store 5.1.1(v) 要求）

    struct DeleteAccountRequest: Encodable {
        let confirm: Bool
    }

    /// 删除账号：服务端清除全部项目与用户记录；成功后客户端清空本地会话
    func deleteAccount() async throws {
        let body = try encoder.encode(DeleteAccountRequest(confirm: true))
        _ = try await request("/api/auth/delete", method: "POST", body: body)
    }

    // MARK: - 反馈 / 举报

    struct FeedbackRequest: Encodable {
        let type: String
        let message: String
        let projectId: String?
        let errorCode: String?
    }

    func sendFeedback(type: String = "feedback", message: String, projectId: String?, errorCode: String?) async throws {
        let body = try encoder.encode(FeedbackRequest(
            type: type,
            message: message,
            projectId: projectId,
            errorCode: errorCode
        ))
        _ = try await request("/api/feedback", method: "POST", body: body)
    }
}

// MARK: - 内部载荷

private struct ProjectPayload: Decodable {
    let project: Project
}

private struct ErrorPayload: Decodable {
    let error: String?
    let errorCode: String?
    let ban: BanInfo?
}
