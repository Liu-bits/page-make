import Foundation

/// 全局配置（第一版）
enum Config {
    /// 后端地址（ModelScope 创空间自托管，已上线验证）
    static var baseURL: URL = URL(string: "https://liu20150413-page-make.ms.show")!

    /// Google OAuth iOS 客户端 ID（Google Cloud Console 创建，完全免费）
    /// TODO: 替换为你的 Client ID（形如 123456-abc.apps.googleusercontent.com）
    /// 未配置时 App 内 Google 登录按钮会提示未配置
    static let googleClientID = "YOUR_CLIENT_ID.apps.googleusercontent.com"

    /// 分片大小：EdgeOne Functions 单请求 body 上限 1MB，留出 base64 开销余量
    static let chunkSize = 600 * 1024

    /// 状态轮询间隔（秒）：上传完成后轮询后台处理状态
    static let pollIntervalSeconds: TimeInterval = 2

    /// 登录态剩余不足 1 天时静默刷新
    static let silentRefreshWindowSeconds: TimeInterval = 24 * 3600
}
