import SwiftUI

/// 预览页：WKWebView + 工具栏（链接/复制/分享/Safari）+ 底部操作栏
struct PreviewView: View {
    let project: Project

    @EnvironmentObject private var appState: AppState
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    @State private var current: Project
    @State private var reloadToken = UUID()
    @State private var runtimeErrors: [String] = []
    @State private var showDiagnostics = false
    @State private var showManage = false
    @State private var showExplorer = false
    @State private var showDeleteConfirm = false
    @State private var alertItem: AlertItem?
    @State private var isRefreshing = false
    @State private var showQR = false
    @State private var isExporting = false
    @State private var exportURL: URL?
    /// 轮询窗口耗尽（约 3 分钟）仍未就绪：展示「仍在处理中」+ 手动刷新。
    @State private var pollTimedOut = false
    /// 当前在跑的 /status 轮询任务。同一时刻只允许一条：
    /// 手动刷新会先取消上一条，否则 `.task(id:)` 与刷新各起一条，
    /// 重复打 /status（限速 + 网关抖动都被放大）。
    @State private var pollTask: Task<Void, Never>?

    init(project: Project) {
        self.project = project
        _current = State(initialValue: project)
    }

    private var isExpired: Bool {
        current.status == .expired
            || (current.expiresAt.map { $0.timeIntervalSinceNow <= 0 } ?? false)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbarBar
            if current.visitStats != nil {
                visitStatsBar
            }
            webArea
            bottomBar
        }
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showDiagnostics) {
            DiagnosticsPanelView(project: current, runtimeErrors: runtimeErrors)
        }
        .sheet(isPresented: $showManage) {
            ManageFilesView(project: current) { updated in
                current = updated
            }
        }
        .sheet(isPresented: $showQR) {
            QRCodeView(project: current)
        }
        .sheet(isPresented: Binding(
            get: { exportURL != nil },
            set: { if !$0 { exportURL = nil } }
        )) {
            if let exportURL {
                ShareSheet(items: [exportURL])
            }
        }
        .confirmationDialog(
            L10n.string("delete_confirm_title"),
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button(L10n.string("delete_confirm_button"), role: .destructive) {
                Task { await deleteProject() }
            }
            Button(L10n.string("cancel"), role: .cancel) {}
        } message: {
            Text(L10n.string("delete_confirm_message"))
        }
        .alert(item: $alertItem) { item in
            Alert(
                title: Text(L10n.string(item.titleKey)),
                message: Text(item.message),
                dismissButton: .default(Text(L10n.string("done")))
            )
        }
        .overlay {
            if isRefreshing {
                ProgressView()
                    .padding()
                    .glassPanel(radius: 12)
            }
        }
        // processing 项目不能只放一个转圈：后台安装/构建可能持续十几分钟，
        // 用户会以为卡死。这里主动轮询 /status，就绪后自动加载，超时给出刷新入口。
        // 轮询统一走 startPolling()，保证同一时刻只有一条在跑。
        .task(id: current.id) {
            startPolling()
        }
        // 静默拉一次项目详情：访问统计等最新数据无需手动刷新即可见；失败保持现状
        .task {
            await refreshQuietly()
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
        // ZIP / 粘贴建的项目也能进项目模式编辑：files.js 的目录/重命名/新建接口
        // 本就全项目通用，这里只是补 iOS 的推入入口（创建空白项目仍限 SVIP）。
        // 返回时 .task 静默刷新会把编辑后的文件清单带回来。
        .navigationDestination(isPresented: $showExplorer) {
            ExplorerView(project: current)
        }
    }

    // MARK: - 顶部工具栏

    /// 访问统计条：入口页命中计数（后端内存聚合 + 定期落 KV），随静默刷新更新
    private var visitStatsBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "eye")
                .font(.caption2)
            Text(L10n.format(
                "visit_summary_format",
                current.visitStats?.total ?? 0,
                current.visitStats?.today ?? 0
            ))
            .font(.caption)
        }
        .foregroundStyle(Theme.secondaryLabel)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 4)
    }

    private var toolbarBar: some View {
        HStack(spacing: 16) {
            Image(systemName: "link")
                .foregroundStyle(Theme.secondaryLabel)
            Text(current.publicURL?.absoluteString ?? "—")
                .font(.footnote)
                .foregroundStyle(Theme.label)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if let url = current.publicURL {
                Button {
                    UIPasteboard.general.string = url.absoluteString
                    alertItem = AlertItem(message: L10n.string("link_copied"), titleKey: "alert_tip")
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .accessibilityLabel(L10n.string("copy_link"))
                ShareLink(item: url) {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel(L10n.string("share"))
                Button {
                    openURL(url)
                } label: {
                    Image(systemName: "safari")
                }
                .accessibilityLabel(L10n.string("open_in_safari"))
                Button {
                    showQR = true
                } label: {
                    Image(systemName: "qrcode")
                }
                .accessibilityLabel(L10n.string("qr_code"))
                if appState.session?.canExport == true {
                    Button {
                        Task { await exportProject() }
                    } label: {
                        if isExporting {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "square.and.arrow.down")
                        }
                    }
                    .disabled(isExporting)
                    .accessibilityLabel(L10n.string("export_backup"))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassPanel(radius: 14)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    // MARK: - 网页区域

    private var webArea: some View {
        ZStack {
            if isExpired {
                expiredPlaceholder
            } else if current.status == .failed {
                failedPlaceholder
            } else if current.status == .processing || current.status == .uploading {
                processingPlaceholder
            } else if let url = current.publicURL {
                WebView(url: url, reloadToken: reloadToken, onRuntimeError: handleRuntimeError)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// 后台仍在安装/构建：轮询中显示进度，超时后给出「仍在处理中」与手动刷新。
    private var processingPlaceholder: some View {
        VStack(spacing: 16) {
            if pollTimedOut {
                Image(systemName: "clock.badge.questionmark")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.premium)
                Text(L10n.string("preview_still_processing"))
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text(L10n.string("preview_still_processing_hint"))
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryLabel)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button(L10n.string("refresh")) {
                    Task { await refresh() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, 48)
            } else {
                ProgressView()
                Text(L10n.string("processing"))
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryLabel)
                Text(L10n.string("preview_processing_hint"))
                    .font(.caption)
                    .foregroundStyle(Theme.tertiaryLabel)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }

    private var failedPlaceholder: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 44))
                .foregroundStyle(Theme.highlight)
            Text(PlainLanguage.message(forErrorCode: current.errorCode ?? ""))
                .font(.headline)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button(L10n.string("refresh")) {
                Task { await refresh() }
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.horizontal, 48)
        }
    }

    private var expiredPlaceholder: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.orange)
            Text(L10n.string("link_expired"))
                .font(.headline)
            Button(L10n.string("refresh_link")) {
                Task { await refresh() }
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.horizontal, 48)
        }
    }

    // MARK: - 底部操作栏

    private var bottomBar: some View {
        GlassEffectContainer(spacing: 12) {
            HStack(spacing: 0) {
                bottomButton(icon: issueCount > 0 ? "exclamationmark.triangle.fill" : "checkmark.shield",
                             label: L10n.string("diagnostics_panel"),
                             badge: issueCount > 0 ? "\(issueCount)" : nil) {
                    showDiagnostics = true
                }
                bottomButton(icon: "arrow.clockwise", label: L10n.string("refresh_link")) {
                    Task { await refresh() }
                }
                bottomButton(icon: "folder", label: L10n.string("file_list")) {
                    showManage = true
                }
                bottomButton(icon: "chevron.left.forwardslash.chevron.left", label: L10n.string("edit_code")) {
                    showExplorer = true
                }
                bottomButton(icon: "trash", label: L10n.string("delete_project")) {
                    showDeleteConfirm = true
                }
            }
            .padding(.vertical, 6)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Theme.barRadius, style: .continuous))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    private func bottomButton(icon: String, label: String, badge: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: icon)
                        .font(.system(size: 18))
                    if let badge {
                        Text(badge)
                            .font(.system(size: 9).bold())
                            .foregroundStyle(PageMakeTheme.onAccent)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.highlight, in: Capsule())
                            .offset(x: 10, y: -6)
                    }
                }
                Text(label)
                    .font(.system(size: 10))
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(Theme.label)
        }
    }

    // MARK: - 操作

    private var issueCount: Int {
        current.diagnostics.count + runtimeErrors.count
    }

    private func handleRuntimeError(_ message: String) {
        // 去重 + 限量，防止错误轰炸撑爆内存和面板
        guard !runtimeErrors.contains(message), runtimeErrors.count < 50 else { return }
        runtimeErrors.append(message)
        LogStore.shared.append("runtime_error", result: "captured", errorCode: nil)
    }

    private func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let updated = try await APIClient.shared.refreshLink(current.id)
            current = updated
            runtimeErrors = []
            reloadToken = UUID() // 强制 WebView 重新加载（URL 可能不变）
            appState.upsertProject(updated)
            // 刷新后仍在部署：不要同步等待（后端可能还要十几分钟），
            // 交给后台轮询，界面继续显示「正在生成链接」。
            if updated.status == .processing || updated.status == .uploading {
                pollTimedOut = false
                startPolling()
            }
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    /// 启动轮询前先取消上一条，保证同一时刻只有一条 /status 轮询。
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { await pollUntilReady() }
    }

    /// 轮询 /api/projects/:id/status 直到终态。
    /// ready → 拉一次完整项目并自动加载网页；failed/expired → 展示对应占位页；
    /// 90 次 × 2 秒（3 分钟）仍未就绪 → 展示「仍在处理中」+ 手动刷新。
    /// 静默拉一次项目详情：访问统计等最新数据无需手动刷新即可见；失败保持现状
    private func refreshQuietly() async {
        if let project = try? await APIClient.shared.project(current.id) {
            current = project
        }
    }

    private func pollUntilReady() async {
        guard current.status == .processing || current.status == .uploading else { return }
        pollTimedOut = false

        let maxAttempts = 90
        var attempts = 0
        while !Task.isCancelled && attempts < maxAttempts {
            attempts += 1
            try? await Task.sleep(nanoseconds: UInt64(Config.pollIntervalSeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            guard let response = try? await APIClient.shared.projectStatus(current.id) else { continue }

            switch response.status {
            case .uploading, .processing:
                continue
            case .ready, .failed, .expired:
                if let project = try? await APIClient.shared.project(current.id) {
                    current = project
                    appState.upsertProject(project)
                }
                runtimeErrors = []
                reloadToken = UUID()
                return
            }
        }
        guard !Task.isCancelled else { return }
        pollTimedOut = true
    }

    private func deleteProject() async {
        // 删除失败时留在原页并提示（RootView 的 authError 弹窗），不 dismiss
        let success = await appState.deleteProject(current.id)
        if success {
            dismiss()
        }
    }

    /// 导出项目为 ZIP 并调起系统分享（备份到文件 App / iCloud / 其他设备）
    private func exportProject() async {
        guard !isExporting else { return }
        isExporting = true
        defer { isExporting = false }
        do {
            let data = try await APIClient.shared.exportProject(current.id)
            let safeName = current.name
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: ":", with: "_")
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(safeName.isEmpty ? "project" : safeName).zip")
            try? FileManager.default.removeItem(at: url)
            try data.write(to: url, options: .atomic)
            exportURL = url
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}
