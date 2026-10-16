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
        default: return "error_generic"
        }
    }

    static func message(forErrorCode code: String) -> String {
        L10n.string(messageKey(forErrorCode: code))
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
