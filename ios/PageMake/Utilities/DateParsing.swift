import Foundation

/// ISO8601 日期解析（兼容带/不带毫秒两种格式）
enum DateParsing {
    static let isoWithFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ string: String) -> Date? {
        isoWithFractional.date(from: string) ?? iso.date(from: string)
    }

    static func string(_ date: Date) -> String {
        isoWithFractional.string(from: date)
    }

    /// 展示用时间格式（跟随系统语言）
    static func display(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }
}
