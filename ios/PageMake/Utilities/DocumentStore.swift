import Foundation

/// 应用内文档（隐私政策 / 用户协议）
enum AppDocument: String, Identifiable, CaseIterable {
    case privacyPolicy = "privacy-policy"
    case userAgreement = "user-agreement"

    var id: String { rawValue }

    var titleKey: String {
        switch self {
        case .privacyPolicy: return "privacy_policy"
        case .userAgreement: return "user_agreement"
        }
    }
}

/// 文档加载：跟随 iOS 系统语言（中文 → zh-Hans，其他 → en），加载失败回退英文
enum DocumentStore {
    static func text(for document: AppDocument) -> String {
        if let text = load(language: preferredLanguage(), document: document) {
            return text
        }
        if let text = load(language: "en", document: document) {
            return text
        }
        return NSLocalizedString("document_unavailable", comment: "")
    }

    private static func preferredLanguage() -> String {
        let preferred = Locale.preferredLanguages.first ?? "en"
        return preferred.hasPrefix("zh") ? "zh-Hans" : "en"
    }

    private static func load(language: String, document: AppDocument) -> String? {
        let name = "Documents/\(language)/\(document.rawValue)"
        guard let url = Bundle.main.url(forResource: name, withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return text
    }
}
