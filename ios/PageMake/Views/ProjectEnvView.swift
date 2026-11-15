import SwiftUI

/// 后端项目环境变量：key-value 编辑（仅后端项目，值明文存储在服务端）。
///
/// 说明：
/// - 变量会注入 install / build / 常驻进程三处；保存后服务端会自动重新构建，
///   所以保存成功 = 变量已生效（等待构建完成即可）。
/// - 值以**明文**存 KV（用户自己的 API Key / 数据库地址），UI 默认打码展示。
struct ProjectEnvView: View {
    let project: Project
    let onChanged: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var rows: [EnvRow] = []
    @State private var maxKeys = 24
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var saving = false
    @State private var alertItem: AlertItem?

    /// 一行变量；revealed 控制值是否明文显示（默认打码）
    struct EnvRow: Identifiable {
        let id = UUID()
        var key: String
        var value: String
        var revealed = false
    }

    /// 服务端校验规则（lib/project-env.js）：与后端一致，保存前先拦一遍
    private static let keyRegex = try? NSRegularExpression(pattern: "^[A-Z_][A-Z0-9_]{0,63}$")
    private static let maxValueBytes = 2000

    var body: some View {
        NavigationStack {
            Group {
                if loadFailed {
                    ContentUnavailableViewCompat(
                        icon: "exclamationmark.triangle",
                        title: L10n.string("error_generic")
                    )
                } else if !loaded {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    listBody
                }
            }
            .navigationTitle(L10n.string("env_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(L10n.string("env_save")) { Task { await save() } }
                            .disabled(!canSave)
                    }
                }
            }
            .alert(item: $alertItem) { item in
                Alert(title: Text(L10n.string(item.titleKey)), message: Text(item.message))
            }
            .task(id: project.id) { await load() }
        }
    }

    private var listBody: some View {
        List {
            Section {
                ForEach($rows) { $row in
                    envRow($row)
                }
                .onDelete { rows.remove(atOffsets: $0) }

                if rows.count < maxKeys {
                    Button {
                        rows.append(EnvRow(key: "", value: ""))
                    } label: {
                        Label(L10n.string("env_add"), systemImage: "plus.circle")
                    }
                }
            } header: {
                Text(L10n.string("env_section_header"))
            } footer: {
                Text(L10n.string("env_hint"))
            }

            Section {
                Text(L10n.string("env_rebuild_hint"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func envRow(_ binding: Binding<EnvRow>) -> some View {
        let keyInvalid = !binding.wrappedValue.key.isEmpty && !Self.isValidKey(binding.wrappedValue.key)
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                TextField(
                    L10n.string("env_key_placeholder"),
                    text: binding.key
                )
                .font(.system(.footnote, design: .monospaced).weight(.semibold))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                if keyInvalid {
                    Text(L10n.string("env_key_invalid"))
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                HStack {
                    if binding.wrappedValue.revealed {
                        TextField(L10n.string("env_value_placeholder"), text: binding.value)
                            .font(.system(.footnote, design: .monospaced))
                    } else {
                        SecureField(L10n.string("env_value_placeholder"), text: binding.value)
                            .font(.system(.footnote, design: .monospaced))
                    }
                }
            }
            Spacer(minLength: 4)
            Button {
                binding.wrappedValue.revealed.toggle()
            } label: {
                Image(systemName: binding.wrappedValue.revealed ? "eye.slash" : "eye")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.string("env_toggle_reveal"))
        }
    }

    private var canSave: Bool {
        !rows.isEmpty && rows.allSatisfy { row in
            Self.isValidKey(row.key) && !row.value.isEmpty
        }
    }

    private static func isValidKey(_ key: String) -> Bool {
        guard let regex = keyRegex else { return false }
        let range = NSRange(key.startIndex..., in: key)
        return regex.firstMatch(in: key, range: range) != nil
    }

    private func load() async {
        do {
            let payload = try await APIClient.shared.projectEnv(projectId: project.id)
            maxKeys = payload.limits?.maxKeys ?? 24
            rows = payload.env
                .sorted(by: { $0.key < $1.key })
                .map { EnvRow(key: $0.key, value: $0.value) }
            loaded = true
        } catch let error as APIError {
            loadFailed = true
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            loadFailed = true
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func save() async {
        // 与后端同一套校验：非法行内标红，能保存说明整表合法
        for row in rows where !Self.isValidKey(row.key) {
            alertItem = AlertItem(message: L10n.string("env_key_invalid"))
            return
        }
        var env: [String: String] = [:]
        for row in rows {
            let bytes = Data(row.value.utf8).count
            if bytes > 2000 {
                alertItem = AlertItem(message: L10n.string("env_value_too_large"))
                return
            }
            env[row.key] = row.value
        }
        saving = true
        defer { saving = false }
        do {
            try await APIClient.shared.saveProjectEnv(projectId: project.id, env: env)
            // 保存后服务端自动重建：静默刷新一次状态，拿到新的 runtimePort
            if let updated = try? await APIClient.shared.waitForProjectReady(project.id) {
                onChanged(updated)
            }
            alertItem = AlertItem(message: L10n.string("env_saved"), titleKey: "alert_tip")
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}

/// 简化的空态视图（iOS 17 的 ContentUnavailableView 之外的手写实现，风格与仓库一致）
struct ContentUnavailableViewCompat: View {
    let icon: String
    let title: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
