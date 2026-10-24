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

/// 后端 API 客户端（EdgeOne Pages Functions）
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
        requiresAuth: Bool = true
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        }
        if requiresAuth, let token {
            // 自定义头：ModelScope 网关会拦截 Authorization（误判为 SDK Token）
            req.setValue(token, forHTTPHeaderField: "X-Pagemake-Token")
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.network
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.network }

        if http.statusCode == 403,
           let payload = try? decoder.decode(ErrorPayload.self, from: data),
           payload.error == "BANNED",
           let ban = payload.ban {
            throw APIError.banned(ban: ban)
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? decoder.decode(ErrorPayload.self, from: data)
            throw APIError.http(status: http.statusCode, code: payload?.errorCode ?? payload?.error)
        }
        return data
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

    /// 邮箱 + 密码注册（注册成功即登录）
    func register(email: String, password: String) async throws -> AuthResponse {
        let body = try encoder.encode(PasswordAuthRequest(email: email, password: password))
        let data = try await request("/api/auth/register", method: "POST", body: body, requiresAuth: false)
        return try decoder.decode(AuthResponse.self, from: data)
    }

    /// 邮箱 + 密码登录
    func login(email: String, password: String) async throws -> AuthResponse {
        let body = try encoder.encode(PasswordAuthRequest(email: email, password: password))
        let data = try await request("/api/auth/login", method: "POST", body: body, requiresAuth: false)
        return try decoder.decode(AuthResponse.self, from: data)
    }

    struct PasswordAuthRequest: Encodable {
        let email: String
        let password: String
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
    }

    func listProjects() async throws -> [Project] {
        let data = try await request("/api/projects")
        let payload = try decoder.decode(ProjectsPayload.self, from: data)
        return payload.projects
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
    }

    /// 删除项目（ModelScope 网关拦截 DELETE 方法，改用 POST + action）
    func deleteProject(_ id: String) async throws {
        let body = try encoder.encode(ActionRequest(action: "delete"))
        _ = try await request("/api/projects/\(id)", method: "POST", body: body)
    }

    /// 粘贴代码直接创建网页（同步返回 ready 项目，无需轮询）
    func createPastedProject(
        provider: HostProvider,
        html: String,
        css: String,
        js: String,
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
        let data = try await request("/api/projects/\(id)/status")
        return try decoder.decode(ProjectStatusResponse.self, from: data)
    }

    // MARK: - 上传（分片，规避 EdgeOne Functions 1MB body 限制）

    struct UploadInitRequest: Encodable {
        let provider: String
        let files: [FileMeta]

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

    func initUpload(provider: HostProvider, files: [PickedFile]) async throws -> UploadInitResponse {
        let body = try encoder.encode(UploadInitRequest(
            provider: provider.rawValue,
            files: files.map { .init(name: $0.name, size: $0.size) }
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

    // MARK: - 项目模式（虚拟文件管理器）

    struct ExplorerCreateRequest: Encodable {
        let name: String
    }

    /// 创建空白项目（项目模式：初始无文件无链接，逐个创建文件后 publish）
    func createExplorerProject(name: String) async throws -> Project {
        let body = try encoder.encode(ExplorerCreateRequest(name: name))
        let data = try await request("/api/projects/explorer", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
    }

    struct FileContentPayload: Decodable {
        let path: String
        let content: String
    }

    /// 读取文本文件内容（编辑器载入用）
    func readTextFile(projectId: String, path: String) async throws -> String {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let data = try await request("/api/projects/\(projectId)/files?path=\(encoded)")
        let payload = try decoder.decode(FileContentPayload.self, from: data)
        guard let bytes = Data(base64Encoded: payload.content),
              let text = String(data: bytes, encoding: .utf8) else {
            throw APIError.decoding
        }
        return text
    }

    /// 生成公开链接（publish：选入口 → 静态诊断 → 返回带 url 的项目）
    func publishProject(_ id: String) async throws -> Project {
        let body = try encoder.encode(ActionRequest(action: "publish"))
        let data = try await request("/api/projects/\(id)", method: "POST", body: body)
        return try decoder.decode(ProjectPayload.self, from: data).project
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
