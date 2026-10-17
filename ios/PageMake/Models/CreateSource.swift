import Foundation

/// 创建来源：上传文件 / 直接粘贴代码 / 项目模式（空白项目）
enum CreateSource {
    case files([PickedFile])
    case paste(PasteContent)
    case explorer(name: String)
}

/// 粘贴的代码内容（HTML 或 PHP 至少一项；CSS/JS 可选）
struct PasteContent {
    var html: String
    var css: String
    var js: String
    var php: String = ""

    /// 全部内容的总字节数
    var totalBytes: Int {
        html.utf8.count + css.utf8.count + js.utf8.count + php.utf8.count
    }

    var isHtmlEmpty: Bool {
        html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var isPhpEmpty: Bool {
        php.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// HTML 或 PHP 至少一项
    var hasContent: Bool {
        !isHtmlEmpty || !isPhpEmpty
    }
}
