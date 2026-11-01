import Foundation

/// 创建来源：上传文件 / 直接粘贴代码 / 项目模式（空白项目）
enum CreateSource {
    /// kind：部署形态（纯前端 / npm / pnpm），由创建页的部署选项决定
    case files([PickedFile], name: String, kind: ProjectKind)
    case paste(PasteContent, name: String, kind: ProjectKind)
    case explorer(name: String, kind: ProjectKind)
}

/// 粘贴的代码内容（HTML 必填；CSS 可选；JS 不再支持）
struct PasteContent {
    var html: String
    var css: String
    /// 历史兼容：不再接收 JS，保留字段让旧调用不崩，但值恒为空串
    var js: String = ""

    /// 全部内容的总字节数（HTML + CSS；JS 已不支持）
    var totalBytes: Int {
        html.utf8.count + css.utf8.count
    }

    var isHtmlEmpty: Bool {
        html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// HTML 必填
    var hasContent: Bool {
        !isHtmlEmpty
    }
}
