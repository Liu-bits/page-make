import SwiftUI

/// 设置页：导出日志 / 反馈 / 隐私政策 / 用户协议 / 退出登录
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var alertItem: AlertItem?
    @State private var showFeedback = false
    @State private var showDocument: AppDocument?
    @State private var showPasswordAuth = false

    var body: some View {
        NavigationStack {
            List {
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
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string(item.titleKey)),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done")))
                )
            }
        }
    }
}
