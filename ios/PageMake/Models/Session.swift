import Foundation

/// 登录会话（凭证存 Keychain，有效期 7 天）
struct UserSession: Equatable {
    let token: String
    let userId: String
    let email: String?
    let expiresAt: Date

    var isExpired: Bool { expiresAt.timeIntervalSinceNow <= 0 }
    var isExpiringSoon: Bool { expiresAt.timeIntervalSinceNow <= Config.silentRefreshWindowSeconds }
}

/// 封号信息
struct BanInfo: Equatable, Codable {
    let level: Int
    let reason: String
    let until: Date?
    let permanent: Bool

    enum CodingKeys: String, CodingKey {
        case level, reason, until, permanent
    }

    init(level: Int, reason: String, until: Date?, permanent: Bool) {
        self.level = level
        self.reason = reason
        self.until = until
        self.permanent = permanent
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = try c.decodeIfPresent(Int.self, forKey: .level) ?? 1
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
        let untilString = try c.decodeIfPresent(String.self, forKey: .until)
        let decodedUntil = untilString.flatMap(DateParsing.parse)
        let declaredPermanent = try c.decodeIfPresent(Bool.self, forKey: .permanent) ?? false
        until = decodedUntil
        permanent = declaredPermanent || decodedUntil == nil
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(level, forKey: .level)
        try c.encode(reason, forKey: .reason)
        try c.encodeIfPresent(until.map(DateParsing.string), forKey: .until)
        try c.encode(permanent, forKey: .permanent)
    }
}

/// /api/auth 响应
struct AuthResponse: Decodable {
    let token: String
    let userId: String
    let email: String?
    let expiresAt: Date

    enum CodingKeys: String, CodingKey {
        case token, userId, email, expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        userId = try c.decode(String.self, forKey: .userId)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        let expiresAtString = try c.decode(String.self, forKey: .expiresAt)
        guard let date = DateParsing.parse(expiresAtString) else {
            throw DecodingError.dataCorruptedError(forKey: .expiresAt, in: c, debugDescription: "无效的 expiresAt")
        }
        expiresAt = date
    }
}

/// /api/projects/:id/status 响应
struct ProjectStatusResponse: Decodable {
    let projectId: String
    let status: ProjectStatus
    let errorCode: String?
    let url: URL?
    let diagnostics: [DiagnosticItem]
    let runtimeErrors: [String]
    let project: Project?

    enum CodingKeys: String, CodingKey {
        case projectId, status, errorCode, url, diagnostics, runtimeErrors, project
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try c.decode(String.self, forKey: .projectId)
        status = (try? c.decode(ProjectStatus.self, forKey: .status)) ?? .processing
        errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
        if let urlString = try c.decodeIfPresent(String.self, forKey: .url) {
            url = URL(string: urlString)
        } else {
            url = nil
        }
        diagnostics = try c.decodeIfPresent([DiagnosticItem].self, forKey: .diagnostics) ?? []
        runtimeErrors = try c.decodeIfPresent([String].self, forKey: .runtimeErrors) ?? []
        project = try c.decodeIfPresent(Project.self, forKey: .project)
    }
}

/// 用量统计
struct UserStats: Decodable, Equatable {
    let projectCount: Int
    let totalSize: Int
    let fileCount: Int
}
