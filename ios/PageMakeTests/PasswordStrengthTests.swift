import XCTest
@testable import PageMake

/// 客户端密码强度预检（与后端 backend/lib/password.js 的 checkPasswordStrength 同规则）
/// 重点是「双向」验证：既不能漏放弱密码，也不能误伤正常强密码
final class PasswordStrengthTests: XCTestCase {
    // MARK: 应拒绝

    func testCommonPasswordsRejected() {
        for pw in ["12345678", "123456789", "password", "password1", "aaaaaaaa",
                   "11111111", "qwerty123", "abc12345", "letmein1", "pagemake1",
                   "Admin123456", "Iloveyou2024"] {
            XCTAssertNotNil(PasswordStrength.rejection(for: pw), "\(pw) 应被判弱")
        }
    }

    func testSequentialPatternsRejected() {
        for pw in ["qqqqqqqq", "zzzzzzzz", "abcdefgh", "12345678", "87654321"] {
            XCTAssertNotNil(PasswordStrength.rejection(for: pw), "\(pw) 应被判为序列弱模式")
        }
    }

    func testKeyboardRunsRejected() {
        // 后端加固后新增：键盘相邻序列
        for pw in ["Qwertyuiop12345", "Asdfghjkl123", "1qaz2wsx3edc", "!QAZ2wsx#EDC",
                   "Qazwsxedc12345", "Mnbvcxz123", "Zxcvbnm12345", "Zaq12wsx34rfv",
                   "1q2w3e4r5t6y"] {
            XCTAssertNotNil(PasswordStrength.rejection(for: pw), "\(pw) 应被判为键盘弱模式")
        }
    }

    func testRepeatingChunksRejected() {
        // 后端加固后新增：短片段重复
        for pw in ["Aa1!Aa1!Aa1!", "Passw0rdPassw0rd", "abcabcabc123", "Xy9#Xy9#Xy9#",
                   "Ab1!Ab1!Ab1!Ab1!"] {
            XCTAssertNotNil(PasswordStrength.rejection(for: pw), "\(pw) 应被判为重复弱模式")
        }
    }

    func testLeetspeakVariantsRejected() {
        // 后端加固后新增：leetspeak 变形（P@ssw0rd / Qw3rty / 4dm1n 此前全部漏过）
        for pw in ["P@ssw0rd!", "p@ssword1", "Qw3rty!23", "Qw3rty", "L3tm31n!x",
                   "4dm1n2024", "4dmin!", "Welcome1", "Monkey123", "Sunshine!",
                   "F00tball", "Dr4g0n2024", "Iloveyou123"] {
            XCTAssertNotNil(PasswordStrength.rejection(for: pw), "\(pw) 应被判为弱口令（leetspeak 变形）")
        }
    }

    func testReverseKeyboardDiagonalsRejected() {
        // 后端加固后新增：反向对角线（Zaq12wsx / Xsw2cde 此前完全漏过）
        for pw in ["Zaq12wsx", "Xsw2cde3", "Cde34rfv", "Vfr45tgb"] {
            XCTAssertNotNil(PasswordStrength.rejection(for: pw), "\(pw) 应被判为键盘弱模式")
        }
    }

    func testSurroundingWhitespaceRejected() {
        // 后端加固后新增：前后空格（用户以为设的是 Aa1!xyz）
        XCTAssertNotNil(PasswordStrength.rejection(for: "   Aa1!xyz   "))
        XCTAssertNotNil(PasswordStrength.rejection(for: "Aa1!xyz   "))
        XCTAssertNotNil(PasswordStrength.rejection(for: "   Aa1!xyz"))
    }

    func testLengthBounds() {
        XCTAssertNotNil(PasswordStrength.rejection(for: "Ab1#"))
        XCTAssertNotNil(PasswordStrength.rejection(for: String(repeating: "A", count: 73) + "1"))
        XCTAssertNil(PasswordStrength.rejection(for: "Ab1#efgh"))
    }

    func testSingleCharacterClassRejected() {
        XCTAssertNotNil(PasswordStrength.rejection(for: "onlyletters"))
        XCTAssertNotNil(PasswordStrength.rejection(for: "1234567890"))
    }

    // MARK: 应放行（不能误伤）

    func testStrongPasswordsAccepted() {
        for pw in ["Test#Passw0rd1", "Adm1n#Secure99", "Xk7#mQ2vLp9!", "Tr0ub4dor&3x",
                   "correct-horse-Battery9", "MyP@ss2024w0rd", "Vh8#nLp2Kd4x",
                   "Battery9Staple!", "G7m$2Xq9Wv", "Pl4y!Wr1te#Run"] {
            XCTAssertNil(PasswordStrength.rejection(for: pw), "\(pw) 不应被误伤")
        }
    }

    func testHardeningDoesNotOverReject() {
        // 加固的边界：这些是合理的自定义/随机密码，必须放行。
        // 曾因"词根包含匹配"兜底把 Test#Passw0rd1 误判，该规则已回退
        for pw in ["Test#Passw0rd1", "Tr0ub4dor&3", "correct-horse-battery",
                   "Kx9#mQ2vLp", "Zhang.San.2026", "B7$wR!2nZq", "MyP@ss2024",
                   "hello2024world", "Str0ng#Pass", "Ab1#efgh"] {
            XCTAssertNil(PasswordStrength.rejection(for: pw), "\(pw) 不应被误伤")
        }
    }

    // MARK: 与后端错误码对齐

    func testRejectionCodesMatchBackend() {
        // 客户端返回的 rawValue 必须与后端 reason 字段一致，否则 PlainLanguage 映射不上
        XCTAssertEqual(PasswordStrength.rejection(for: "password")?.rawValue, "WEAK_PASSWORD_COMMON")
        XCTAssertEqual(PasswordStrength.rejection(for: "Qwertyuiop12345")?.rawValue, "WEAK_PASSWORD_PATTERN")
        XCTAssertEqual(PasswordStrength.rejection(for: "onlyletters")?.rawValue, "WEAK_PASSWORD_SIMPLE")
        XCTAssertEqual(PasswordStrength.rejection(for: "   Aa1!xyz   ")?.rawValue, "WEAK_PASSWORD")
    }

    func testRejectionCodesMapToLocalizedMessages() {
        // 每个错误码都要有本地化文案，不能出现空串（空串会让用户看到通用错误）
        for code in ["WEAK_PASSWORD", "WEAK_PASSWORD_COMMON", "WEAK_PASSWORD_PATTERN", "WEAK_PASSWORD_SIMPLE"] {
            let key = PlainLanguage.messageKey(forErrorCode: code)
            XCTAssertFalse(key.isEmpty, "\(code) 应有本地化 key")
            XCTAssertFalse(L10n.string(key).isEmpty, "\(key) 应有文案")
        }
    }
}
