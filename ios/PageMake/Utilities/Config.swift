import Foundation

/// 全局配置（第一版）
enum Config {
    /// TODO(第一版)：部署后台后替换为 EdgeOne Pages 项目域名
    /// 例如：https://page-make.edgeone.app
    static var baseURL: URL = URL(string: "https://pagemake.example.com")!

    /// 分片大小：EdgeOne Functions 单请求 body 上限 1MB，留出 base64 开销余量
    static let chunkSize = 600 * 1024

    /// 状态轮询间隔（秒）：上传完成后轮询后台处理状态
    static let pollIntervalSeconds: TimeInterval = 2

    /// 登录态剩余不足 1 天时静默刷新
    static let silentRefreshWindowSeconds: TimeInterval = 24 * 3600

    /// 隐私政策 / 用户协议
    /// TODO(上架前必须替换)：Apple 审核必查隐私政策，example.com 占位地址会被拒。
    /// 替换为真实可访问地址，并同步在 App Store Connect 填写。
    static let privacyPolicyURL = URL(string: "https://example.com/pagemake/privacy")!
    static let userAgreementURL = URL(string: "https://example.com/pagemake/terms")!
}
