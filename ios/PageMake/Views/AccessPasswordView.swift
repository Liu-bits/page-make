import SwiftUI

/// 站点访问密码：开启后公开链接需要密码才能访问（静态与后端项目都支持）。
///
/// 行为：
/// - 未设置：两个输入框（密码 + 确认）+ 设置按钮，密码 6-128 位；
/// - 已设置：显示「已开启」状态 + 修改 / 关闭（关闭需二次确认）；
/// - 关闭后访问者无需密码，已发出去的解锁 cookie 也会因指纹变化失效。
struct AccessPasswordView: View {
    let project: Project
    let onChanged: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var alertItem: AlertItem?
    @State private var showDisableConfirm = false

    private var hasPassword: Bool { project.hasAccessPassword }

    private var canSet: Bool {
        password.count >= 6 && password.count <= 128 && password == confirm
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if hasPassword {
                        statusRow
                    } else {
                        emptyHint
                    }
                } footer: {
                    Text(L10n.string(hasPassword ? "access_password_on_hint" : "access_password_off_hint"))
                }

                Section(hasPassword ? L10n.string("access_password_modify_section") : L10n.string("access_password_set_section")) {
                    SecureField(L10n.string("access_password_field"), text: $password)
                        .textContentType(.newPassword)
                    SecureField(L10n.string("access_password_confirm_field"), text: $confirm)
                    if !confirm.isEmpty && password != confirm {
                        Text(L10n.string("access_password_mismatch"))
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    Button {
                        Task { await setPassword() }
                    } label: {
                        if busy {
                            ProgressView()
                        } else {
                            Label(L10n.string("access_password_enable"), systemImage: "lock")
                        }
                    }
                    .disabled(!canSet || busy)
                }

                if hasPassword {
                    Section {
                        Button(role: .destructive) {
                            showDisableConfirm = true
                        } label: {
                            Label(L10n.string("access_password_disable"), systemImage: "lock.open")
                        }
                        .disabled(busy)
                    }
                }
            }
            .navigationTitle(L10n.string("access_password_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
            .alert(item: $alertItem) { item in
                Alert(title: Text(L10n.string(item.titleKey)), message: Text(item.message))
            }
            .confirmationDialog(
                L10n.string("access_password_disable_confirm"),
                isPresented: $showDisableConfirm,
                titleVisibility: .visible
            ) {
                Button(L10n.string("access_password_disable"), role: .destructive) {
                    Task { await clearPassword() }
                }
                Button(L10n.string("cancel"), role: .cancel) {}
            }
        }
    }

    private var statusRow: some View {
        HStack {
            Label(L10n.string("access_password_status"), systemImage: "lock.fill")
                .foregroundStyle(Theme.positive)
            Spacer()
            Text(L10n.string("access_password_enabled"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var emptyHint: some View {
        Text(L10n.string("access_password_empty"))
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    private func setPassword() async {
        guard canSet, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let updated = try await APIClient.shared.setAccessPassword(
                projectId: project.id,
                password: password
            )
            onChanged(updated)
            password = ""
            confirm = ""
            alertItem = AlertItem(message: L10n.string("access_password_set_ok"), titleKey: "alert_tip")
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func clearPassword() async {
        busy = true
        defer { busy = false }
        do {
            let updated = try await APIClient.shared.clearAccessPassword(projectId: project.id)
            onChanged(updated)
            alertItem = AlertItem(message: L10n.string("access_password_clear_ok"), titleKey: "alert_tip")
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}
