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
        case "INVALID_GOOGLE_TOKEN": return "error_invalid_google_token"
        case "GOOGLE_INVALID_AUD": return "error_google_invalid_aud"
        case "GOOGLE_INVALID_ISS": return "error_google_invalid_iss"
        case "GOOGLE_TOKEN_EXPIRED": return "error_token_expired"
        case "GOOGLE_KEY_NOT_FOUND": return "error_google_key_not_found"
        case "GOOGLE_INVALID_SIGNATURE": return "error_invalid_google_token"
        case "GOOGLE_INVALID_ALG": return "error_invalid_google_token"
        case "GOOGLE_JWKS_UNAVAILABLE": return "error_jwks_unavailable"
        case "APPLE_INVALID_AUD": return "error_apple_invalid_aud"
        case "APPLE_INVALID_ISS": return "error_apple_invalid_iss"
        case "APPLE_INVALID_NONCE": return "error_apple_invalid_nonce"
        case "APPLE_TOKEN_EXPIRED": return "error_token_expired"
        case "APPLE_KEY_NOT_FOUND": return "error_apple_key_not_found"
        case "APPLE_INVALID_SIGNATURE": return "error_invalid_apple_token"
        case "APPLE_INVALID_ALG": return "error_invalid_apple_token"
        case "APPLE_JWKS_UNAVAILABLE": return "error_jwks_unavailable"
        case "INTERNAL_ERROR": return "error_internal_error"
        // 部署形态 / 等级配额
        case "INVALID_KIND": return "error_invalid_kind"
        case "BACKEND_REQUIRES_VIP": return "error_backend_requires_vip"
        case "EXPORT_REQUIRES_VIP": return "error_export_requires_vip"
        case "INVALID_TIER": return "error_invalid_tier"
        case "TIER_UNCHANGED": return "error_tier_unchanged"
        // 后端运行时
        case "MISSING_PACKAGE_JSON": return "error_missing_package_json"
        case "INSTALL_FAILED": return "error_install_failed"
        case "INSTALL_TIMEOUT": return "error_install_timeout"
        case "BUILD_FAILED": return "error_build_failed"
        case "BUILD_TIMEOUT": return "error_build_timeout"
        case "NO_START_SCRIPT": return "error_no_start_script"
        case "START_TIMEOUT": return "error_start_timeout"
        case "RUNTIME_BUSY": return "error_runtime_busy"
        case "RUNTIME_UNAVAILABLE": return "error_runtime_unavailable"
        case "RUNTIME_CRASHED": return "error_runtime_crashed"
        case "RUNTIME_TIMEOUT": return "error_upload_timeout"
        case "GUEST_LIMIT": return "error_guest_limit"
        case "GUEST_NO_EXPLORER": return "error_guest_no_explorer"
        case "VIP_REQUEST_GUEST_ONLY": return "vip_request_guest_only"
        default: return ""
        }
    }

    static func message(forErrorCode code: String) -> String {
        let key = messageKey(forErrorCode: code)
        // 未知错误码：直接显示码本身（便于用户反馈时定位，如 GOOGLE_JWKS_FETCH_FAILED）
        let text = key.isEmpty ? code : L10n.string(key)
        return text.isEmpty ? L10n.string("error_generic") : text
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
