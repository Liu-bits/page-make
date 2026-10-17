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
    @State private var showDeleteConfirm = false
    @State private var alertItem: AlertItem?
    @State private var isRefreshing = false
    @State private var showQR = false

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
            webArea
            Divider()
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
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - 顶部工具栏

    private var toolbarBar: some View {
        HStack(spacing: 16) {
            Image(systemName: "link")
                .foregroundStyle(.secondary)
            Text(current.publicURL?.absoluteString ?? "—")
                .font(.footnote)
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
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    // MARK: - 网页区域

    private var webArea: some View {
        ZStack {
            if isExpired {
                expiredPlaceholder
            } else if let url = current.publicURL {
                WebView(url: url, reloadToken: reloadToken, onRuntimeError: handleRuntimeError)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            bottomButton(icon: "trash", label: L10n.string("delete_project")) {
                showDeleteConfirm = true
            }
        }
        .padding(.vertical, 6)
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
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.red, in: Capsule())
                            .offset(x: 10, y: -6)
                    }
                }
                Text(label)
                    .font(.system(size: 10))
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(.primary)
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
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func deleteProject() async {
        // 删除失败时留在原页并提示（RootView 的 authError 弹窗），不 dismiss
        let success = await appState.deleteProject(current.id)
        if success {
            dismiss()
        }
    }
}
