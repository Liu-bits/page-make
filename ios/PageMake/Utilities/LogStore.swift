import Foundation

/// 本地日志环（最近 100 条），设置页可导出
final class LogStore {
    static let shared = LogStore()

    struct Entry: Identifiable {
        let id = UUID()
        let timestamp: Date
        let step: String
        let result: String
        let errorCode: String?
    }

    private(set) var entries: [Entry] = []
    private let queue = DispatchQueue(label: "com.pagemake.logstore")
    let maxEntries = 100

    private init() {}

    func append(_ step: String, result: String, errorCode: String? = nil) {
        let entry = Entry(timestamp: Date(), step: step, result: result, errorCode: errorCode)
        queue.async {
            self.entries.append(entry)
            if self.entries.count > self.maxEntries {
                self.entries.removeFirst(self.entries.count - self.maxEntries)
            }
        }
    }

    /// 导出为文本文件（返回临时文件 URL）
    func export() -> URL? {
        var snapshot: [Entry] = []
        queue.sync { snapshot = entries }
        let lines = snapshot.reversed().map { entry -> String in
            let code = entry.errorCode.map { " [\($0)]" } ?? ""
            return "\(DateParsing.isoWithFractional.string(from: entry.timestamp)) [\(entry.step)] \(entry.result)\(code)"
        }
        let text = lines.joined(separator: "\n")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("pagemake-logs-\(Int(Date().timeIntervalSince1970)).txt")
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }
}
