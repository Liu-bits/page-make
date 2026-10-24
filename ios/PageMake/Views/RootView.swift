import SwiftUI

/// 根视图：封号拦截 + 主界面 + 创建流程
struct RootView: View {
    @EnvironmentObject private var appState: AppState

    /// 两个互斥 presentation：
    /// - 入口选择与设置只负责选择；
    /// - 创建队列单独承载，入口必须先真正 dismiss 再打开。
    /// 之前用一个 `.sheet(item:)` 在同一帧替换内容，部分 iOS 版本会把
    /// 第二次 presentation 吞掉，表现为“所有按钮都没反应”。
    enum ActiveSheet: Identifiable {
        case filePicker

        var id: String {
            switch self {
            case .filePicker: return "filePicker"
            }
        }
    }

    enum MainTab: String {
        case workspace
        case settings
    }

    @State private var activeSheet: ActiveSheet?
    @State private var createSource: CreateSource?
    @State private var explorerProject: Project?
    @State private var selectedTab: MainTab = .workspace

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
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if appState.banInfo == nil, activeSheet == nil, createSource == nil {
                MainTabBar(selection: $selectedTab) {
                    activeSheet = .filePicker
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { createSource != nil },
            set: { if !$0 { createSource = nil } }
        )) {
            if let source = createSource {
                CreateFlowView(source: source) {
                    createSource = nil
                }
            }
        }
        // 不用全局 alert 展示网络状态：alert 一旦与 sheet 同帧出现，
        // SwiftUI 会把 presentation 锁死，所有按钮看似“失灵”。全局错误改为
        // 顶部非阻塞横幅，用户可继续操作并在需要时重试。
        .overlay(alignment: .top) {
            if activeSheet == nil, createSource == nil, let message = appState.authError {
                ErrorBanner(message: message) {
                    appState.authError = nil
                }
            }
        }
    }

    private var mainContent: some View {
        NavigationStack {
            Group {
                switch selectedTab {
                case .workspace:
                    ProjectListView(
                        onCreateTapped: {
                            activeSheet = .filePicker
                        }
                    )
                case .settings:
                    SettingsView()
                }
            }
            .navigationDestination(item: $explorerProject) { project in
                ExplorerView(project: project)
            }
        }
    }

    private func handlePicked(_ source: CreateSource) {
        // 先 dismiss 入口 sheet，避免一个 presentation 在转场中被另一个覆盖。
        activeSheet = nil
        if case .explorer(let name) = source {
            Task {
                if let project = await appState.createExplorerProject(name: name) {
                    try? await Task.sleep(nanoseconds: 450_000_000)
                    explorerProject = project
                }
            }
            return
        }
        // 等 dismiss 转场结束再打开创建队列；两个 sheet 状态各自独立，
        // 不会再因 item id 在同一帧变化而丢失。
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 450_000_000)
            createSource = source
        }
    }
}
