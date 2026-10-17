import Foundation

/// 错误码 → 小白话（全部走本地化，不硬编码中文）
enum PlainLanguage {
    /// 错误码 → 本地化 key（纯逻辑，可单测）
    static func messageKey(forErrorCode code: String) -> String {
        switch code {
        case "NO_ENTRY": return "error_no_entry"
        case "TOO_LARGE": return "error_too_large"
        case "BAD_ZIP": return "error_bad_zip"
        case "STORAGE_ERROR": return "error_storage_error"
        case "DB_ERROR": return "error_db_error"
        case "INVALID_PROVIDER": return "error_invalid_provider"
        case "EXPIRED": return "error_expired"
        case "INVALID_EMAIL": return "error_invalid_email"
        case "WEAK_PASSWORD": return "error_weak_password"
        case "EMAIL_TAKEN": return "error_email_taken"
        case "INVALID_CREDENTIALS": return "error_invalid_credentials"
        case "INVALID_GOOGLE_TOKEN": return "error_invalid_google_token"
        case "GUEST_LIMIT": return "error_guest_limit"
        default: return ""
        }
    }

    static func message(forErrorCode code: String) -> String {
        let key = messageKey(forErrorCode: code)
        // 未知错误码：直接显示码本身（便于用户反馈时定位，如 GOOGLE_JWKS_FETCH_FAILED）
        return key.isEmpty ? code : L10n.string(key)
    }

    /// 技术报错 → 小白话 key（纯逻辑，可单测）
    static func technicalKey(_ raw: String) -> String {
        let lower = raw.lowercased()
        if lower.contains("404") || lower.contains("not found") { return "tech_not_found" }
        if lower.contains("referenceerror") || lower.contains("is not defined") { return "tech_undefined_variable" }
        if lower.contains("cors") { return "tech_cors" }
        if lower.contains("mime") { return "tech_mime" }
        if lower.contains("unexpected token") || lower.contains("syntaxerror") { return "tech_syntax" }
        if lower.contains("failed to load resource") || lower.contains("resource") { return "tech_resource" }
        return ""
    }

    static func technical(_ raw: String) -> String {
        let key = technicalKey(raw)
        return key.isEmpty ? raw : L10n.string(key)
    }
}
