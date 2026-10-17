import SwiftUI

/// 设置页：导出日志 / 反馈 / 隐私政策 / 用户协议 / 退出登录
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var alertItem: AlertItem?
    @State private var showFeedback = false
    @State private var showDocument: AppDocument?
    @State private var showPasswordAuth = false
    @State private var showDeleteAccountConfirm = false
    @State private var isDeletingAccount = false

    var body: some View {
        NavigationStack {
            List {
                if appState.isLoggedIn, let stats = appState.stats {
                    Section(L10n.string("stats_section")) {
                        LabeledContent(L10n.string("stats_projects"), value: "\(stats.projectCount)")
                        LabeledContent(L10n.string("stats_files"), value: "\(stats.fileCount)")
                        LabeledContent(L10n.string("stats_size"), value: formatBytes(stats.totalSize))
                    }
                }

                Section(L10n.string("account_section")) {
                    if appState.isLoggedIn {
                        if let session = appState.session {
                            if let email = session.email {
                                LabeledContent(L10n.string("account_label"), value: email)
                            } else {
                                LabeledContent(L10n.string("account_label"), value: session.userId)
                            }
                        }
                        if let ban = appState.banInfo {
                            LabeledContent(L10n.string("ban_level"), value: "L\(ban.level)")
                        }
                        Button(L10n.string("sign_out"), role: .destructive) {
                            appState.signOut()
                        }
                        // App Store 5.1.1(v)：必须提供 App 内账号删除
                        Button(role: .destructive) {
                            showDeleteAccountConfirm = true
                        } label: {
                            if isDeletingAccount {
                                ProgressView()
                            } else {
                                Text(L10n.string("delete_account"))
                            }
                        }
                        .disabled(isDeletingAccount)
                    } else {
                        Button(L10n.string("login_apple")) {
                            Task { await appState.signIn() }
                        }
                        Button(L10n.string("login_google")) {
                            Task {
                                if let error = await appState.signInWithGoogle() {
                                    alertItem = AlertItem(message: error)
                                }
                            }
                        }
                        Button(L10n.string("password_login")) {
                            showPasswordAuth = true
                        }
                        Button(L10n.string("login_guest")) {
                            Task { await appState.signInAsGuest() }
                        }
                    }
                }

                Section(L10n.string("tools_section")) {
                    if let exportURL = LogStore.shared.export() {
                        ShareLink(item: exportURL) {
                            Label(L10n.string("export_logs"), systemImage: "square.and.arrow.up")
                        }
                    }
                    Button {
                        showFeedback = true
                    } label: {
                        Label(L10n.string("feedback"), systemImage: "bubble.left.and.bubble.right")
                    }
                }

                Section(L10n.string("about_section")) {
                    Button {
                        showDocument = .privacyPolicy
                    } label: {
                        Label(L10n.string("privacy_policy"), systemImage: "hand.raised")
                            .foregroundStyle(.primary)
                    }
                    Button {
                        showDocument = .userAgreement
                    } label: {
                        Label(L10n.string("user_agreement"), systemImage: "doc.text")
                            .foregroundStyle(.primary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(L10n.string("settings"))
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await appState.loadStats()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
            .sheet(isPresented: $showFeedback) {
                FeedbackView()
            }
            .sheet(item: $showDocument) { document in
                DocumentView(document: document)
            }
            .sheet(isPresented: $showPasswordAuth) {
                PasswordAuthView()
                    .environmentObject(appState)
            }
            .confirmationDialog(
                L10n.string("delete_account_confirm_title"),
                isPresented: $showDeleteAccountConfirm,
                titleVisibility: .visible
            ) {
                Button(L10n.string("delete_account_button"), role: .destructive) {
                    Task { await deleteAccount() }
                }
                Button(L10n.string("cancel"), role: .cancel) {}
            } message: {
                Text(L10n.string("delete_account_confirm_message"))
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string(item.titleKey)),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done")))
                )
            }
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }

    private func deleteAccount() async {
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        if let error = await appState.deleteAccount() {
            alertItem = AlertItem(message: error)
        } else {
            dismiss()
        }
    }
}
