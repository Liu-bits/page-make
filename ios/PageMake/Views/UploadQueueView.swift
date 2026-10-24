import SwiftUI
import Combine

/// 上传队列页：进度条 + 可取消 + 完成后轮询状态
struct UploadQueueView: View {
    let source: CreateSource
    let provider: HostProvider
    var onCreateFinished: (() -> Void)? = nil

    @StateObject private var uploadService = UploadService()
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var didStart = false
    @State private var createdProject: Project?

    var body: some View {
        NavigationStack {
            Group {
                if uploadService.items.isEmpty {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text(L10n.string("uploading"))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    List {
                        ForEach(uploadService.items) { item in
                            itemRow(item)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle(L10n.string("upload_queue"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
            .onAppear {
                guard !didStart else { return }
                didStart = true
                // 每次进入创建流程都先刷新一次，避免上次异常退出遗留的旧队列项。
                uploadService.clearFinishedItems()
                switch source {
                case .files(let files):
                    uploadService.upload(files: files, provider: provider)
                case .paste(let content):
                    uploadService.createPasted(
                        content,
                        provider: provider,
                        name: L10n.string("paste_project_name")
                    )
                case .explorer:
                    // 项目模式由 RootView 直接创建并打开资源管理器，不进入上传队列
                    break
                }
            }
            .onReceive(uploadService.createdProject) { project in
                createdProject = project
                Task {
                    await appState.projectDidBecomeReady(project)
                    // 创建成功后主动关闭入口 sheet 并让列表页刷新，不等用户手动点完成。
                    onCreateFinished?()
                }
            }
            .navigationDestination(item: $createdProject) { project in
                PreviewView(project: project)
            }
        }
    }

    private func itemRow(_ item: UploadService.Item) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                statusLabel(item)
            }

            switch item.status {
            case .uploading:
                ProgressView(value: item.progress)
                Text(L10n.string("uploading"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .processing:
                ProgressView()
                Text(L10n.string("processing"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .failed:
                if let message = item.errorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            case .ready:
                if let project = item.project {
                    NavigationLink {
                        PreviewView(project: project)
                    } label: {
                        Text(L10n.string("open_preview"))
                    }
                    .buttonStyle(.bordered)
                    Button(L10n.string("done")) {
                        uploadService.remove(item)
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                }
            case .expired:
                Text(L10n.string("error_expired"))
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if item.status == .uploading || item.status == .processing {
                Button(L10n.string("cancel"), role: .destructive) {
                    uploadService.cancel(item)
                }
                .font(.footnote)
            }
        }
        .padding(12)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private func statusLabel(_ item: UploadService.Item) -> some View {
        switch item.status {
        case .uploading:
            Text(L10n.string("uploading")).font(.footnote).foregroundStyle(.secondary)
        case .processing:
            Text(L10n.string("processing")).font(.footnote).foregroundStyle(.secondary)
        case .ready:
            Text(L10n.string("status_ready")).font(.footnote).foregroundStyle(.green)
        case .failed:
            Text(L10n.string("upload_failed")).font(.footnote).foregroundStyle(.red)
        case .expired:
            Text(L10n.string("status_expired")).font(.footnote).foregroundStyle(.orange)
        }
    }
}
