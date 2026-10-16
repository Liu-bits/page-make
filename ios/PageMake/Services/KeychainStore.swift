import Foundation
import Security

/// Keychain 封装（会话凭证存储）
final class KeychainStore {
    static let shared = KeychainStore()

    private let service = "com.pagemake.keychain"

    private init() {}

    func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    func string(forKey key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - 会话快捷方式

    var sessionToken: String? {
        string(forKey: "session_token")
    }

    var sessionExpiresAt: Date? {
        string(forKey: "session_expires_at").flatMap(DateParsing.parse)
    }

    var userId: String? {
        string(forKey: "user_id")
    }

    var userEmail: String? {
        string(forKey: "user_email")
    }

    func saveSession(_ response: AuthResponse) {
        set(response.token, for: "session_token")
        set(DateParsing.string(response.expiresAt), for: "session_expires_at")
        set(response.userId, for: "user_id")
        if let email = response.email { set(email, for: "user_email") }
    }

    func clearSession() {
        remove("session_token")
        remove("session_expires_at")
        remove("user_id")
        remove("user_email")
    }
}
