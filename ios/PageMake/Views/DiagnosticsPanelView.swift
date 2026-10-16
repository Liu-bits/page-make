import SwiftUI

/// 诊断面板（登录后可见）
struct DiagnosticsPanelView: View {
    let project: Project
    let runtimeErrors: [String]

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var alertItem: AlertItem?

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
                    Section {
                        Button(L10n.string("copy_report")) {
                            copyReport()
                        }
                    }
                }
            }
            .navigationTitle(L10n.string("diagnostics_panel"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text("alert_error"),
                    message: Text(item.message),
                    dismissButton: .default(Text("done"))
                )
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
