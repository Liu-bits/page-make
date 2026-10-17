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
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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

    func deleteProject(_ id: String) async throws {
        _ = try await request("/api/projects/\(id)", method: "DELETE")
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

    /// 取消上传：清理后端已上传的临时分片
    func cancelUpload(uploadId: String) async throws {
        _ = try await request("/api/upload/\(uploadId)", method: "DELETE")
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

    struct DeleteFileRequest: Encodable {
        let path: String
    }

    func addFile(projectId: String, path: String, content: Data) async throws -> Project {
        let body = try encoder.encode(AddFileRequest(path: path, content: content.base64EncodedString()))
        let data = try await request("/api/projects/\(projectId)/files", method: "POST", body: body)
        let payload = try decoder.decode(ProjectPayload.self, from: data)
        return payload.project
    }

    func deleteFile(projectId: String, path: String) async throws -> Project {
        let body = try encoder.encode(DeleteFileRequest(path: path))
        let data = try await request("/api/projects/\(projectId)/files", method: "DELETE", body: body)
        let payload = try decoder.decode(ProjectPayload.self, from: data)
        return payload.project
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
