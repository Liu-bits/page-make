import SwiftUI

/// 诊断面板（登录后可见）
struct DiagnosticsPanelView: View {
    let project: Project
    let runtimeErrors: [String]

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var alertItem: AlertItem?
    /// 后端项目的最近运行日志（stdout/stderr 环形缓冲）
    @State private var runtimeLogs: String?
    @State private var logsLoading = false

    /// 运行时错误映射为诊断项
    private var allItems: [DiagnosticItem] {
        var items = project.diagnostics
        for error in runtimeErrors {
            items.append(DiagnosticItem(
                kind: .runtimeError,
                detail: error,
                suggestion: PlainLanguage.technical(error)
            ))
        }
        return items
    }

    var body: some View {
        NavigationStack {
            List {
                if !appState.isLoggedIn {
                    // 未登录：只显示「您的代码有错误」
                    Section {
                        Label(L10n.string("code_has_errors"), systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                    Section {
                        Button {
                            Task { await appState.signIn() }
                        } label: {
                            Text(L10n.string("login_apple"))
                        }
                        Text(L10n.string("diagnostics_login_required"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        summaryRow
                    }
                    if allItems.isEmpty {
                        Section {
                            Text(L10n.string("no_issues"))
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Section(L10n.string("diagnostics_list")) {
                            ForEach(Array(allItems.enumerated()), id: \.offset) { index, item in
                                issueRow(index: index + 1, item: item)
                            }
                        }
                    }
                    if project.kind.isBackend {
                        runtimeLogsSection
                    }
                    Section {
                        Button(L10n.string("copy_report")) {
                            copyReport()
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(PageMakeBackground())
            .navigationTitle(L10n.string("diagnostics_panel"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
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

    /// 后端项目运行日志：stdout/stderr 环形缓冲（最近 16KB），调试「为什么 503」的刚需
    private var runtimeLogsSection: some View {
        Section(L10n.string("runtime_logs")) {
            if logsLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L10n.string("loading")).font(.caption).foregroundStyle(.secondary)
                }
            } else if let logs = runtimeLogs, !logs.isEmpty {
                ScrollView {
                    Text(logs)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 220)
                Button(L10n.string("runtime_logs_copy")) {
                    UIPasteboard.general.string = logs
                    alertItem = AlertItem(message: L10n.string("report_copied"))
                }
            } else {
                Text(L10n.string("runtime_logs_empty"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .task {
            logsLoading = true
            defer { logsLoading = false }
            do {
                let payload = try await APIClient.shared.runtimeLogs(projectId: project.id)
                runtimeLogs = payload.logs
            } catch {
                // 拉取失败（静态项目 / 网络抖动）保持空态即可
                runtimeLogs = nil
            }
        }
    }

    private var summaryRow: some View {
        HStack {
            Image(systemName: allItems.isEmpty ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(allItems.isEmpty ? .green : .orange)
            Text(allItems.isEmpty
                 ? L10n.string("no_issues")
                 : L10n.format("found_issues", allItems.count))
        }
    }

    private func issueRow(index: Int, item: DiagnosticItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(index). \(item.detail)")
                .font(.subheadline)
            if let line = item.line {
                Text(L10n.format("diagnostic_line", line))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !item.suggestion.isEmpty {
                Label(item.suggestion, systemImage: "lightbulb")
                    .font(.caption)
                    .foregroundStyle(.blue)
            }
        }
        .padding(.vertical, 2)
    }

    private func copyReport() {
        var lines: [String] = []
        lines.append(L10n.format("report_project", project.name))
        lines.append(L10n.format("report_provider", L10n.string(project.provider.titleKey)))
        if let errorCode = project.errorCode {
            lines.append(L10n.format("report_error_code", errorCode))
        }
        lines.append(L10n.format("found_issues", allItems.count))
        for (index, item) in allItems.enumerated() {
            lines.append("\(index + 1). \(item.detail)")
            if !item.suggestion.isEmpty {
                lines.append("   → \(item.suggestion)")
            }
        }
        UIPasteboard.general.string = lines.joined(separator: "\n")
        alertItem = AlertItem(message: L10n.string("report_copied"))
    }
}
