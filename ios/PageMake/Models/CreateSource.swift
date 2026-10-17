import Foundation

/// 创建来源：上传文件 / 直接粘贴代码
enum CreateSource {
    case files([PickedFile])
    case paste(PasteContent)
}

/// 粘贴的代码内容（HTML 必填，CSS/JS 可选）
struct PasteContent {
    var html: String
    var css: String
    var js: String

    /// HTML + CSS + JS 的总字节数
    var totalBytes: Int {
        html.utf8.count + css.utf8.count + js.utf8.count
    }

    var isHtmlEmpty: Bool {
        html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
