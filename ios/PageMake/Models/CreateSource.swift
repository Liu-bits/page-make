import Foundation

/// 创建来源：上传文件 / 直接粘贴代码 / 项目模式（空白项目）
enum CreateSource {
    /// kind：部署形态，由项目文件自动识别（见 DeployKindDetector）。
    /// 粘贴固定为纯前端；项目模式创建时按账号等级给一个可用的文件白名单，
    /// 真正的形态在发布时按文件再次识别。
    case files([PickedFile], name: String, kind: ProjectKind)
    case paste(PasteContent, name: String)
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
