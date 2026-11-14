import SwiftUI

/// 表单提交列表：查看 / 删除 / 清空 / 导出（静态站 /p/<id>/__form 收集的数据）
struct FormSubmissionsView: View {
    let project: Project
    /// 回传最新条数给父页面（管理文件页的计数徽章）
    let onCountChanged: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var submissions: [FormSubmission] = []
    @State private var isLoading = true
    @State private var pendingDelete: FormSubmission?
    @State private var showClearConfirm = false
    @State private var alertItem: AlertItem?
    @State private var exportURL: URL?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if submissions.isEmpty {
                    VStack(spacing: 14) {
                        Image(systemName: "text.bubble")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text(L10n.string("form_empty"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(L10n.string("form_hint"))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        Section {
                            ForEach(submissions) { submission in
                                submissionRow(submission)
                            }
                        }
                        Section {
                            Button(role: .destructive) {
                                showClearConfirm = true
                            } label: {
                                Label(L10n.string("form_clear"), systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(PageMakeBackground())
            .navigationTitle(L10n.string("form_submissions"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
                if !submissions.isEmpty {
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            exportAsText()
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel(L10n.string("share"))
                    }
                }
            }
            .confirmationDialog(
                L10n.string("form_delete_confirm"),
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(L10n.string("form_delete"), role: .destructive) {
                    if let target = pendingDelete {
                        Task { await deleteSubmission(target) }
                    }
                }
                Button(L10n.string("cancel"), role: .cancel) {}
            }
            .confirmationDialog(
                L10n.string("form_clear_confirm"),
                isPresented: $showClearConfirm,
                titleVisibility: .visible
            ) {
                Button(L10n.string("form_clear"), role: .destructive) {
                    Task { await clearAll() }
                }
                Button(L10n.string("cancel"), role: .cancel) {}
            }
            .sheet(isPresented: Binding(
                get: { exportURL != nil },
                set: { if !$0 { exportURL = nil } }
            )) {
                if let exportURL {
                    ShareSheet(items: [exportURL])
                }
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string(item.titleKey)),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done")))
                )
            }
            .task { await load() }
        }
    }

    private func submissionRow(_ submission: FormSubmission) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(DateParsing.display(submission.createdAt ?? Date.distantPast))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(role: .destructive) {
                    pendingDelete = submission
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
            ForEach(submission.fields.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                VStack(alignment: .leading, spacing: 1) {
                    Text(key)
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    Text(value.isEmpty ? "—" : value)
                        .font(.subheadline)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let payload = try await APIClient.shared.formSubmissions(projectId: project.id)
            submissions = payload.submissions
            onCountChanged(payload.count)
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func deleteSubmission(_ submission: FormSubmission) async {
        do {
            try await APIClient.shared.deleteFormSubmission(projectId: project.id, submissionId: submission.id)
            submissions.removeAll { $0.id == submission.id }
            onCountChanged(submissions.count)
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func clearAll() async {
        do {
            try await APIClient.shared.clearFormSubmissions(projectId: project.id)
            submissions = []
            onCountChanged(0)
            alertItem = AlertItem(message: L10n.string("form_cleared"), titleKey: "alert_tip")
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    /// 导出为文本文件走系统分享面板（不做云同步，隐私口径与统计一致）
    private func exportAsText() {
        var lines: [String] = []
        for submission in submissions {
            lines.append("=== \(DateParsing.display(submission.createdAt ?? Date.distantPast)) ===")
            for (key, value) in submission.fields.sorted(by: { $0.key < $1.key }) {
                lines.append("\(key): \(value)")
            }
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("form-\(project.id).txt")
        do {
            try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
            exportURL = url
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}
