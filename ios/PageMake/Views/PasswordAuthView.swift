import SwiftUI

/// 邮箱 + 密码登录/注册页
/// 说明：密码仅用于本 App，与邮箱本身密码无关；v1 不发送验证邮件
struct PasswordAuthView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    private enum Mode: Hashable {
        case login
        case register
    }

    @State private var mode: Mode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var alertItem: AlertItem?

    private var canSubmit: Bool {
        email.contains("@") && password.count >= 8 && !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("", selection: $mode) {
                        Text(L10n.string("login")).tag(Mode.login)
                        Text(L10n.string("register")).tag(Mode.register)
                    }
                    .pickerStyle(.segmented)
                }

                Section(L10n.string("email_label")) {
                    TextField("you@example.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.emailAddress)
                }

                Section {
                    SecureField(L10n.string("password_placeholder"), text: $password)
                        .textContentType(.password)
                } header: {
                    Text(L10n.string("password_label"))
                } footer: {
                    Text(L10n.string("password_rule"))
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
                                Text(mode == .login ? L10n.string("login") : L10n.string("register"))
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit)
                }
            }
            .navigationTitle(L10n.string("password_login"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string("alert_error")),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done")))
                )
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }

        let error: String?
        switch mode {
        case .login:
            error = await appState.signInWithPassword(email: email, password: password)
        case .register:
            error = await appState.registerWithPassword(email: email, password: password)
        }

        if let error {
            alertItem = AlertItem(message: error)
        } else {
            dismiss()
        }
    }
}
