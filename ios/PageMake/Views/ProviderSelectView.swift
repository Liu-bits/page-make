import SwiftUI

/// 创建流程：直接进入上传队列
/// 说明：单一部署线路，无需选择服务商
struct CreateFlowView: View {
    let source: CreateSource
    var onCreateFinished: (() -> Void)? = nil

    var body: some View {
        UploadQueueView(source: source, provider: .local, onCreateFinished: onCreateFinished)
    }
}
