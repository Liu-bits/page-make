import SwiftUI

/// VIP 账号登录页：账号由管理后台发放，不提供 App 内注册。
struct VIPLoginView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var alertItem: AlertItem?

    private var canSubmit: Bool {
        email.contains("@") && !password.isEmpty && !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(L10n.string("vip_login_title"))
                                .font(.headline)
                            Text(L10n.string("vip_login_hint"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "crown.fill")
                            .foregroundStyle(PageMakeTheme.gold)
                    }
                }

                Section(L10n.string("email_label")) {
                    TextField("you@example.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                }

                Section(L10n.string("password_label")) {
                    SecureField(L10n.string("password_placeholder"), text: $password)
                        .textContentType(.password)
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text(L10n.string("login"))
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit)
                }
            }
            .navigationTitle(L10n.string("vip_login"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
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

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }

        let error = await appState.signInWithVIP(email: email, password: password)
        if let error {
            alertItem = AlertItem(message: error)
        } else {
            dismiss()
        }
    }
}
