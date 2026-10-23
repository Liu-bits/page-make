import Foundation

/// 客户端密码强度预检（与后端 backend/lib/password.js 的 checkPasswordStrength 保持一致）
/// 目的：后端规则比「至少 8 位」严格得多（键盘序列/片段重复/前后空格都会拒），
/// 若客户端只查长度，用户填了 Qwertyuiop12345 这类"看着很强"的密码会被前端放行、
/// 提交后才被后端拒绝，且看到的拒绝原因和实际规则对不上。这里提前拦下并给出可操作提示。
enum PasswordStrength {
    /// 后端返回的错误码（与 backend/lib/password.js 的 reason 字段一致）
    enum Rejection: String {
        case weak = "WEAK_PASSWORD"
        case common = "WEAK_PASSWORD_COMMON"
        case pattern = "WEAK_PASSWORD_PATTERN"
        case simple = "WEAK_PASSWORD_SIMPLE"
    }

    static let minLength = 8
    static let maxLength = 72

    /// QWERTY 键盘行/列（含 Shift 形态与两条对角线），与后端 KEYBOARD_ROWS 对应
    private static let keyboardRows: [String] = [
        "1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm",
        "!@#$%^&*()", "qazwsxedc", "!qaz@wsx#edc",
        "1qaz2wsx3edc4rfv5tgb", "1q2w3e4r5t6y7u8i9o0p",
    ]

    /// 常见词根：带上数字/符号尾巴也判弱（与后端 COMMON_ROOTS 对应）
    private static let commonRoots: [String] = [
        "password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "login",
        "iloveyou", "monkey", "dragon", "sunshine", "princess", "football", "baseball",
        "shadow", "master", "changeme", "secret", "pagemake", "abc123", "test",
    ]

    private static let commonPasswords: Set<String> = [
        "123456", "1234567", "12345678", "123456789", "1234567890", "123123123",
        "password", "password1", "password123", "passw0rd", "qwerty", "qwerty123",
        "abc123", "abc12345", "abcd1234", "aaaaaaa", "aaaaaaaa", "11111111", "111111111",
        "00000000", "iloveyou", "admin", "admin123", "letmein", "welcome", "monkey",
        "dragon", "sunshine", "princess", "football", "baseball", "shadow", "master",
        "login", "changeme", "secret", "test123", "pagemake", "page-make",
    ]

    /// - Returns: 通过时为 nil；被拒时返回对应错误码
    static func rejection(for password: String) -> Rejection? {
        // 前后空格必须拒绝：用户以为设的是 Aa1!xyz，实际存的是带空格版本
        if password != password.trimmingCharacters(in: .whitespacesAndNewlines) {
            return .weak
        }
        if password.count < minLength || password.count > maxLength { return .weak }
        let lower = password.lowercased()

        if commonPasswords.contains(lower) { return .common }

        // 常见词根 + 数字/符号尾巴：letmein1 / password2024 / qwerty!
        for root in commonRoots where lower.hasPrefix(root) {
            let rest = String(lower.dropFirst(root.count))
            if rest.isEmpty { return .common }
            // 只拦「词根 + 最多 1 个额外字母 + 数字尾巴」，避免误伤 PasswordManager2024 这类
            if rest.range(of: #"^[a-z]?\d+[^a-z\d]*$"#, options: .regularExpression) != nil {
                return .common
            }
        }

        if isSequential(password) { return .pattern }
        if hasKeyboardRun(lower) { return .pattern }
        if isRepeatingChunk(lower) { return .pattern }

        // 字符类别：字母 + 数字/符号至少两类
        let hasLetter = lower.rangeOfCharacter(from: .letters) != nil
        let hasDigit = lower.rangeOfCharacter(from: .decimalDigits) != nil
        let hasSymbol = lower.rangeOfCharacter(from: CharacterSet.alphanumerics.inverted) != nil
        let classes = [hasLetter, hasDigit, hasSymbol].filter { $0 }.count
        if classes < 2 { return .simple }

        return nil
    }

    /// 单一字符重复或连续递增/递减（aaaaaaa / 1234567 …）
    private static func isSequential(_ password: String) -> Bool {
        let s = password.lowercased()
        if s.count < 2 { return false }
        if let first = s.first, s.allSatisfy({ $0 == first }) { return true }
        let scalars = Array(s.unicodeScalars)
        var asc = true
        var desc = true
        for i in 1..<scalars.count {
            let diff = Int(scalars[i].value) - Int(scalars[i - 1].value)
            if diff != 1 { asc = false }
            if diff != -1 { desc = false }
        }
        return asc || desc
    }

    /// 是否含长度 >= 5 的键盘相邻序列（正/反向）；数字夹在中间也判（1qaz2wsx）
    private static func hasKeyboardRun(_ s: String) -> Bool {
        let stripped = String(s.unicodeScalars.filter { !CharacterSet.decimalDigits.contains($0) })
        for row in keyboardRows {
            let chars = Array(row)
            for len in 5...chars.count {
                for start in 0...(chars.count - len) {
                    let chunk = String(chars[start..<(start + len)])
                    if s.contains(chunk) || stripped.contains(chunk) { return true }
                    let rev = String(chunk.reversed())
                    if s.contains(rev) || stripped.contains(rev) { return true }
                }
            }
        }
        return false
    }

    /// 是否为「短片段重复 >= 2 次」构成（Aa1!Aa1!Aa1! / Passw0rdPassw0rd）
    private static func isRepeatingChunk(_ s: String) -> Bool {
        let n = s.count
        let chars = Array(s)
        guard n >= 6 else { return false }
        for len in 3...(n / 2) {
            let chunk = String(chars[0..<len])
            var count = 0
            var idx = s.startIndex
            while let found = s.range(of: chunk, range: idx..<s.endIndex) {
                count += 1
                idx = found.upperBound
            }
            if count >= 2 { return true }
        }
        return false
    }
}
