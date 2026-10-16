import Foundation

/// 本地化入口（Localizable.strings · zh-Hans / en）
/// 规则：所有用户可见文案必须走这里，不硬编码
enum L10n {
    static func string(_ key: String) -> String {
        NSLocalizedString(key, bundle: .main, comment: "")
    }

    static func format(_ key: String, _ args: CVarArg...) -> String {
        String(format: NSLocalizedString(key, bundle: .main, comment: ""), arguments: args)
    }
}
