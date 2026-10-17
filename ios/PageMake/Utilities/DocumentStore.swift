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

/// 文档加载：跟随 iOS 系统语言（中文 → -zh，其他 → -en），加载失败回退英文
/// 文件布局：Resources/Documents/<文档名>-<zh|en>.txt（语言放文件名，避开 XcodeGen 本地化目录歧义）
enum DocumentStore {
    static func text(for document: AppDocument) -> String {
        if let text = load(document: document, suffix: preferredSuffix()) {
            return text
        }
        if let text = load(document: document, suffix: "en") {
            return text
        }
        return NSLocalizedString("document_unavailable", comment: "")
    }

    private static func preferredSuffix() -> String {
        let preferred = Locale.preferredLanguages.first ?? "en"
        return preferred.hasPrefix("zh") ? "zh" : "en"
    }

    private static func load(document: AppDocument, suffix: String) -> String? {
        // 资源在打包时被拍平到 .app 根目录（XcodeGen 不保留 Documents/ 子目录），
        // 先按根目录找，再兼容带子目录的布局
        let candidates = [
            "\(document.rawValue)-\(suffix)",
            "Documents/\(document.rawValue)-\(suffix)",
        ]
        for name in candidates {
            if let url = Bundle.main.url(forResource: name, withExtension: "txt"),
               let text = try? String(contentsOf: url, encoding: .utf8) {
                return text
            }
        }
        return nil
    }
}
