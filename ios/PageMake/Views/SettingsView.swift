import SwiftUI

/// 设置页：导出日志 / 反馈 / 隐私政策 / 用户协议 / 退出登录
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var alertItem: AlertItem?
    @State private var showFeedback = false

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
                    Link(destination: Config.privacyPolicyURL) {
                        Label(L10n.string("privacy_policy"), systemImage: "hand.raised")
                    }
                    Link(destination: Config.userAgreementURL) {
                        Label(L10n.string("user_agreement"), systemImage: "doc.text")
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
            .alert(item: $alertItem) { item in
                Button(L10n.string("done"), role: .cancel) {}
            } message: {
                Text(item.message)
            }
        }
    }
}
