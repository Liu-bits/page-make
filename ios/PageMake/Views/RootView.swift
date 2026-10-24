import SwiftUI

/// 根视图：封号拦截 + 主界面 + 创建流程
struct RootView: View {
    @EnvironmentObject private var appState: AppState

    /// 单一 sheet 状态：避免“关闭一个 sheet 的同时打开另一个”导致 SwiftUI
    /// 在转场中丢弃 presentation（表现为点了创建没反应或偶发闪退）。
    enum ActiveSheet: Identifiable {
        case filePicker
        case create(CreateSource)
        case settings

        var id: String {
            switch self {
            case .filePicker: return "filePicker"
            case .create(let source):
                switch source {
                case .files: return "create-files"
                case .paste: return "create-paste"
                case .explorer: return "create-explorer"
                }
            case .settings: return "settings"
            }
        }
    }

    @State private var activeSheet: ActiveSheet?
    @State private var explorerProject: Project?

    var body: some View {
        Group {
            if let ban = appState.banInfo {
                BannedView(ban: ban)
            } else {
                mainContent
            }
        }
        .animation(.default, value: appState.banInfo != nil)
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .filePicker:
                FilePickerView { source in
                    handlePicked(source)
                }
            case .create(let source):
                CreateFlowView(source: source)
            case .settings:
                SettingsView()
            }
        }
        .alert(
            L10n.string("alert_error"),
            isPresented: Binding(
                get: { appState.authError != nil },
                set: { if !$0 { appState.authError = nil } }
            )
        ) {
            Button(L10n.string("done"), role: .cancel) {}
        } message: {
            if let message = appState.authError, !message.isEmpty {
                Text(message)
            } else {
                Text(L10n.string("error_generic"))
            }
        }
    }

    private var mainContent: some View {
        NavigationStack {
            ProjectListView(
                showFilePicker: Binding(
                    get: { activeSheet?.id == "filePicker" },
                    set: { if !$0, activeSheet?.id == "filePicker" { activeSheet = nil } }
                ),
                showSettings: Binding(
                    get: { activeSheet?.id == "settings" },
                    set: { if !$0, activeSheet?.id == "settings" { activeSheet = nil } }
                )
            )
                .navigationDestination(item: $explorerProject) { project in
                    ExplorerView(project: project)
                }
        }
    }

    private func handlePicked(_ source: CreateSource) {
        if case .explorer(let name) = source {
            activeSheet = nil
            Task {
                if let project = await appState.createExplorerProject(name: name) {
                    // 等 sheet 关闭动画结束后再压导航栈，避免同一帧切换两个
                    // presentation 引发 SwiftUI 状态冲突。
                    try? await Task.sleep(nanoseconds: 350_000_000)
                    explorerProject = project
                }
            }
            return
        }
        // 用新的 create 状态替换 filePicker：先赋值，SwiftUI 会在同一次更新中
        // 完成 sheet 内容切换，不再依赖“关闭后再置 pendingSource”的竞态。
        activeSheet = .create(source)
    }
}
