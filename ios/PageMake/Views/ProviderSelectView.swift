import SwiftUI

/// 创建流程：直接进入上传队列
/// 说明：自托管单线路（ModelScope 创空间），无需再选 EdgeOne / Cloudflare
struct CreateFlowView: View {
    let source: CreateSource
    var onCreateFinished: (() -> Void)? = nil

    var body: some View {
        UploadQueueView(source: source, provider: .local, onCreateFinished: onCreateFinished)
    }
}
