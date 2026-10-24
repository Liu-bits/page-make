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

    var errorDescription: String? {
        switch self {
        case .emptySelection: return L10n.string("validation_empty")
        case .unsupportedExtension(let ext): return L10n.format("validation_extension", ext)
        case .tooLarge(let bytes): return L10n.format("validation_too_large", Double(bytes) / 1_048_576.0)
        }
    }
}

/// 选文件页本地校验：后缀 + 总大小（5MB）
enum FileValidator {
    static let maxTotalBytes: Int64 = 5 * 1024 * 1024
    static let allowedExtensions: Set<String> = ["zip", "html", "css", "js"]

    static func validate(_ files: [PickedFile]) -> Result<[PickedFile], FileValidationError> {
        guard !files.isEmpty else { return .failure(.emptySelection) }

        for file in files {
            let ext = file.name.lowercased().components(separatedBy: ".").last ?? ""
            guard allowedExtensions.contains(ext) else {
                return .failure(.unsupportedExtension(ext))
            }
        }

        let total = files.reduce(Int64(0)) { $0 + $1.size }
        guard total <= maxTotalBytes else {
            return .failure(.tooLarge(bytes: total))
        }
        return .success(files)
    }
}
