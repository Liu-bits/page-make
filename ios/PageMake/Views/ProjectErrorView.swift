import SwiftUI

/// 项目错误页（代码错误）
/// 未登录：只显示「您的代码有错误」+ 登录按钮
/// 已登录：显示诊断摘要 + 复制报告
struct ProjectErrorView: View {
    let project: Project

    @EnvironmentObject private var appState: AppState
    @State private var alertItem: AlertItem?

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.orange)

                if !appState.isLoggedIn {
                    Text(L10n.string("code_has_errors"))
                        .font(.title3.bold())
                    Button(L10n.string("login_apple")) {
                        Task { await appState.signIn() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .padding(.horizontal, 48)
                } else {
                    Text(PlainLanguage.message(forErrorCode: project.errorCode ?? ""))
                        .font(.headline)
                        .multilineTextAlignment(.center)

                    if !project.diagnostics.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(L10n.format("found_issues", project.diagnostics.count))
                                .font(.subheadline.bold())
                            ForEach(Array(project.diagnostics.enumerated()), id: \.offset) { index, item in
                                Text("\(index + 1). \(item.detail)")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                    }

                    Button(L10n.string("copy_report")) {
                        copyReport()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding()
        }
        .navigationTitle(L10n.string("code_has_errors"))
        .navigationBarTitleDisplayMode(.inline)
        .alert(item: $alertItem) { item in
            Button(L10n.string("done"), role: .cancel) {}
        } message: {
            Text(item.message)
        }
    }

    private func copyReport() {
        var lines: [String] = [L10n.format("report_project", project.name)]
        if let errorCode = project.errorCode {
            lines.append(L10n.format("report_error_code", errorCode))
        }
        for item in project.diagnostics {
            lines.append("- \(item.detail)")
            if !item.suggestion.isEmpty { lines.append("  → \(item.suggestion)") }
        }
        UIPasteboard.general.string = lines.joined(separator: "\n")
        alertItem = AlertItem(message: L10n.string("report_copied"))
    }
}
