import XCTest
@testable import PageMake

/// 错误码 / 技术报错的小白话映射（纯逻辑）
final class PlainLanguageTests: XCTestCase {
    func testErrorCodeMappingCoversAllCodes() {
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "NO_ENTRY"), "error_no_entry")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "TOO_LARGE"), "error_too_large")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "BAD_ZIP"), "error_bad_zip")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "STORAGE_ERROR"), "error_storage_error")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "DB_ERROR"), "error_db_error")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "INVALID_PROVIDER"), "error_invalid_provider")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "EXPIRED"), "error_expired")
        // 密码强度与限速错误码（后端 checkPasswordStrength / ratelimit 新增）
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "WEAK_PASSWORD"), "error_weak_password")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "WEAK_PASSWORD_COMMON"), "error_weak_password_common")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "WEAK_PASSWORD_PATTERN"), "error_weak_password_pattern")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "WEAK_PASSWORD_SIMPLE"), "error_weak_password_simple")
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "TOO_MANY_ATTEMPTS"), "error_too_many_attempts")
    }

    func testUnknownErrorCodeFallsBackToGeneric() {
        // 未知错误码：messageKey 返回空，message 显示码本身（便于反馈定位），且永不为空
        XCTAssertEqual(PlainLanguage.messageKey(forErrorCode: "WHATEVER"), "")
        XCTAssertEqual(PlainLanguage.message(forErrorCode: "WHATEVER"), "WHATEVER")
        XCTAssertFalse(PlainLanguage.message(forErrorCode: "").isEmpty)
    }

    func testDifferentCodesMapToDifferentMessages() {
        XCTAssertNotEqual(PlainLanguage.messageKey(forErrorCode: "NO_ENTRY"),
                          PlainLanguage.messageKey(forErrorCode: "BAD_ZIP"))
    }

    func testTechnicalMapping() {
        XCTAssertEqual(PlainLanguage.technicalKey("GET https://x/style.css 404 (Not Found)"), "tech_not_found")
        XCTAssertEqual(PlainLanguage.technicalKey("Uncaught ReferenceError: x is not defined"), "tech_undefined_variable")
        XCTAssertEqual(PlainLanguage.technicalKey("CORS error: blocked"), "tech_cors")
        XCTAssertEqual(PlainLanguage.technicalKey("MIME type mismatch"), "tech_mime")
        XCTAssertEqual(PlainLanguage.technicalKey("Uncaught SyntaxError: Unexpected token"), "tech_syntax")
    }

    func testUnknownTechnicalKeepsOriginal() {
        let raw = "Some random message"
        XCTAssertEqual(PlainLanguage.technicalKey(raw), "")
        XCTAssertEqual(PlainLanguage.technical(raw), raw)
    }
}
