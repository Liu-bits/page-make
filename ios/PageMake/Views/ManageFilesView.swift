import SwiftUI
import UniformTypeIdentifiers

/// 管理界面：项目信息 + 文件列表（增删文件）
struct ManageFilesView: View {
    let project: Project
    let onChanged: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var current: Project
    @State private var showAddFile = false
    @State private var pendingDelete: String?
    @State private var editingFile: ProjectFile?
    @State private var alertItem: AlertItem?

    /// 可在应用内直接编辑内容的文本类型（与 AddFileSheet 的 html/css/js 一致并放宽常用文本）
    private static let editableExtensions: Set<String> = [
        "html", "htm", "css", "js", "mjs", "cjs", "json", "md", "txt",
        "ts", "tsx", "jsx", "xml", "yml", "yaml", "csv", "svg",
    ]

    init(project: Project, onChanged: @escaping (Project) -> Void) {
        self.project = project
        self.onChanged = onChanged
        _current = State(initialValue: project)
    }

    private func isEditable(_ path: String) -> Bool {
        Self.editableExtensions.contains((path as NSString).pathExtension.lowercased())
    }

    var body: some View {
        NavigationStack {
            List {
                Section(L10n.string("project_info")) {
                    LabeledContent(L10n.string("project_name"), value: current.name)
                    LabeledContent(L10n.string("provider_label"), value: L10n.string(current.provider.titleKey))
                    LabeledContent(L10n.string("status_label"), value: L10n.string(current.status.titleKey))
                    LabeledContent(L10n.string("created_at"), value: DateParsing.display(current.createdAt))
                    if let expiresAt = current.expiresAt {
                        LabeledContent(L10n.string("expires_at"), value: DateParsing.display(expiresAt))
                    }
                    LabeledContent(L10n.string("file_count_label"), value: L10n.format("file_count", current.fileCount))
                    LabeledContent(L10n.string("total_size"), value: ByteCountFormatter.string(fromByteCount: current.size, countStyle: .file))
                    if let stats = current.visitStats {
                        LabeledContent(L10n.string("visit_total_label"), value: L10n.format("visit_total_value", stats.total))
                        LabeledContent(L10n.string("visit_today_label"), value: L10n.format("visit_today_value", stats.today))
                    }
                }

                Section {
                    ForEach(current.files) { file in
                        HStack {
                            Image(systemName: "doc")
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(file.path)
                                    .font(.subheadline)
                                    .lineLimit(1)
                                Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            // 内容编辑下放：普通用户也能改 HTML/CSS 文本（此前只有
                            // SVIP 的项目模式才有编辑器）。仅文本类型显示编辑入口。
                            if isEditable(file.path) {
                                Button {
                                    editingFile = file
                                } label: {
                                    Image(systemName: "pencil")
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel(L10n.string("explorer_edit"))
                            }
                            Button(role: .destructive) {
                                pendingDelete = file.path
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                } header: {
                    HStack {
                        Text(L10n.string("file_list"))
                        Spacer()
                        Button {
                            showAddFile = true
                        } label: {
                            Image(systemName: "plus")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(PageMakeBackground())
            .navigationTitle(L10n.string("manage_files"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("done")) { dismiss() }
                }
            }
            .sheet(isPresented: $showAddFile) {
                AddFileSheet(project: current) { updated in
                    current = updated
                    onChanged(updated)
                }
            }
            .sheet(item: $editingFile) { file in
                FileEditorView(projectId: current.id, path: file.path) { updated in
                    current = updated
                    onChanged(updated)
                }
            }
            .confirmationDialog(
                L10n.string("delete_file_confirm"),
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(L10n.string("delete_confirm_button"), role: .destructive) {
                    if let path = pendingDelete {
                        Task { await deleteFile(path) }
                    }
                }
                Button(L10n.string("cancel"), role: .cancel) {}
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

    private func deleteFile(_ path: String) async {
        pendingDelete = nil
        do {
            let updated = try await APIClient.shared.deleteFile(projectId: current.id, path: path)
            current = updated
            onChanged(updated)
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}

/// 添加文件（单个 .html/.css/.js，≤ 900KB 直接 base64 上传）
struct AddFileSheet: View {
    let project: Project
    let onAdded: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showPicker = false
    @State private var alertItem: AlertItem?
    @State private var isUploading = false

    private static let supportedTypes: [UTType] = {
        var types: [UTType] = []
        for ext in ["html", "css", "js"] {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }()

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image(systemName: "plus.circle")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text(L10n.string("add_file_hint"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button {
                    showPicker = true
                } label: {
                    Text(L10n.string("pick_file"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, 32)
            }
            .navigationTitle(L10n.string("add_file"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
            }
            .sheet(isPresented: $showPicker) {
                DocumentPicker(types: Self.supportedTypes, allowsMultipleSelection: false) { urls in
                    Task { @MainActor in
                        if let url = urls.first {
                            await uploadFile(url)
                        }
                    }
                }
            }
            .alert(item: $alertItem) { item in
                Alert(
                    title: Text(L10n.string(item.titleKey)),
                    message: Text(item.message),
                    dismissButton: .default(Text(L10n.string("done")))
                )
            }
            .overlay {
                if isUploading { ProgressView() }
            }
        }
    }

    private func uploadFile(_ url: URL) async {
        isUploading = true
        defer { isUploading = false }

        let didStart = url.startAccessingSecurityScopedResource()
        defer { if didStart { url.stopAccessingSecurityScopedResource() } }

        guard let data = try? Data(contentsOf: url) else {
            alertItem = AlertItem(message: L10n.string("error_generic"))
            return
        }
        // 单文件直传（base64 JSON）：限制 900KB，大文件请打包成 zip 走分片上传
        guard data.count <= 900 * 1024 else {
            alertItem = AlertItem(message: L10n.string("file_too_large_single"))
            return
        }
        let path = url.lastPathComponent
        do {
            let updated = try await APIClient.shared.addFile(
                projectId: project.id,
                path: path,
                content: data
            )
            onAdded(updated)
            dismiss()
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}
