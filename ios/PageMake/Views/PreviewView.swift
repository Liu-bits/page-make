import SwiftUI

/// 预览页：WKWebView + 工具栏（链接/复制/分享/Safari）+ 底部操作栏
struct PreviewView: View {
    let project: Project

    @EnvironmentObject private var appState: AppState
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    @State private var current: Project
    @State private var runtimeErrors: [String] = []
    @State private var showDiagnostics = false
    @State private var showManage = false
    @State private var showDeleteConfirm = false
    @State private var alertItem: AlertItem?
    @State private var isRefreshing = false

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
            Divider()
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
                title: Text("alert_error"),
                message: Text(item.message),
                dismissButton: .default(Text("done"))
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
                    alertItem = AlertItem(message: L10n.string("link_copied"))
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
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    // MARK: - 网页区域

    private var webArea: some View {
        ZStack {
            if isExpired {
                expiredPlaceholder
            } else if let url = current.publicURL {
                WebView(url: url, onRuntimeError: handleRuntimeError)
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
            appState.upsertProject(updated)
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func deleteProject() async {
        await appState.deleteProject(current.id)
        dismiss()
    }
}
