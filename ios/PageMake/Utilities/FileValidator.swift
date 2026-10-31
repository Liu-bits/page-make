import Foundation

/// 选中的文件（已拷贝到临时目录，脱离安全作用域资源）
struct PickedFile: Identifiable, Equatable {
    let id = UUID()
    let url: URL
    let name: String
    let size: Int64
}

/// 本地校验错误（文案走本地化）
enum FileValidationError: LocalizedError, Equatable {
    case emptySelection
    case unsupportedExtension(String)
    case tooLarge(bytes: Int64)
    case tooLargeForTier(bytes: Int64, limit: Int64)

    var errorDescription: String? {
        switch self {
        case .emptySelection: return L10n.string("validation_empty")
        case .unsupportedExtension(let ext): return L10n.format("validation_extension", ext)
        case .tooLarge(let bytes): return L10n.format("validation_too_large", Double(bytes) / 1_048_576.0)
        case .tooLargeForTier(let bytes, let limit):
            return L10n.format(
                "validation_too_large_limit",
                Double(bytes) / 1_048_576.0,
                Self.formatLimit(limit)
            )
        }
    }

    private static func formatLimit(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_048_576.0
        return mb >= 1 ? String(format: "%.0f MB", mb) : String(format: "%.0f KB", Double(bytes) / 1024.0)
    }
}

/// 选文件页本地校验：后缀 + 当前等级总大小
enum FileValidator {
    static let maxTotalBytes: Int64 = 5 * 1024 * 1024
    static let staticAllowedExtensions: Set<String> = ["zip", "html", "css", "js"]
    /// 后端项目需要 package.json、TS/JS 源码、配置和静态资源；ZIP 仍可直接上传。
    static let backendAllowedExtensions: Set<String> = [
        "zip", "html", "htm", "css", "js", "mjs", "cjs", "json",
        "ts", "tsx", "jsx", "md", "txt", "yml", "yaml", "toml", "xml",
        "graphql", "gql", "sql", "map", "wasm", "svg", "png", "jpg", "jpeg",
        "gif", "webp", "ico", "bmp", "avif", "woff", "woff2", "ttf", "otf",
        "eot", "mp3", "mp4", "webm", "pdf", "csv", "lock",
    ]

    static func allowedExtensions(for kind: ProjectKind) -> Set<String> {
        kind.isBackend ? backendAllowedExtensions : staticAllowedExtensions
    }

    /// limitBytes = nil 表示 Ultra 无上限。
    static func validate(
        _ files: [PickedFile],
        limitBytes: Int64? = FileValidator.maxTotalBytes,
        kind: ProjectKind = .staticSite
    ) -> Result<[PickedFile], FileValidationError> {
        guard !files.isEmpty else { return .failure(.emptySelection) }

        for file in files {
            let ext = file.name.lowercased().components(separatedBy: ".").last ?? ""
            guard allowedExtensions(for: kind).contains(ext) else {
                return .failure(.unsupportedExtension(ext))
            }
        }

        let total = files.reduce(Int64(0)) { $0 + $1.size }
        if let limitBytes, total > limitBytes {
            if limitBytes == maxTotalBytes {
                return .failure(.tooLarge(bytes: total))
            }
            return .failure(.tooLargeForTier(bytes: total, limit: limitBytes))
        }
        return .success(files)
    }
}
