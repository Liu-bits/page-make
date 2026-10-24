import SwiftUI

/// 项目模式：类 Windows 资源管理器的虚拟文件视图
/// - 虚拟文件夹：由文件路径推导（如 css/style.css → css 文件夹），无需单独创建
/// - 仅支持 .html / .css / .js；支持创建、编辑、删除
/// - 「生成链接」统一发布：自动选入口（index.html 优先）→ 静态诊断 → 返回公开链接
struct ExplorerView: View {
    let initial: Project

    @EnvironmentObject private var appState: AppState
    @State private var current: Project
    @State private var currentDir = ""               // "" = 根目录
    @State private var showNewFile = false
    @State private var editingFile: EditingFile?
    @State private var deleteTarget: ExplorerEntry?
    @State private var alertItem: AlertItem?
    @State private var isPublishing = false
    @State private var showQR = false

    init(project: Project) {
        self.initial = project
        _current = State(initialValue: project)
    }

    // MARK: - 目录条目（虚拟文件夹推导）

    struct ExplorerEntry: Identifiable {
        let name: String
        let path: String
        let isFolder: Bool
        var id: String { path }
    }

    struct EditingFile: Identifiable {
        let path: String
        var id: String { path }
    }

    /// 当前目录下的子文件夹与文件（文件夹在前，均按名称排序）
    private var folders: [ExplorerEntry] {
        entriesIn(currentDir).folders
    }

    private var files: [ExplorerEntry] {
        entriesIn(currentDir).files
    }

    private func entriesIn(_ dir: String) -> (folders: [ExplorerEntry], files: [ExplorerEntry]) {
        let prefix = dir.isEmpty ? "" : dir + "/"
        var folderNames = Set<String>()
        var fileEntries: [ExplorerEntry] = []
        for file in current.files {
            guard file.path.hasPrefix(prefix), file.path != prefix else { continue }
            let rest = String(file.path.dropFirst(prefix.count))
            guard !rest.isEmpty else { continue }
            if let slash = rest.firstIndex(of: "/") {
                folderNames.insert(String(rest[..<slash]))
            } else {
                fileEntries.append(ExplorerEntry(name: rest, path: file.path, isFolder: false))
            }
        }
        let folderEntries = folderNames.sorted().map {
            ExplorerEntry(name: $0, path: prefix + $0, isFolder: true)
        }
        fileEntries.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return (folderEntries, fileEntries)
    }

    /// 面包屑层级：[(名称, 路径)]，根目录在前
    private var breadcrumbs: [(name: String, path: String)] {
        var result = [(name: L10n.string("explorer_root"), path: "")]
        var accumulated = ""
        for component in currentDir.split(separator: "/") {
            accumulated = accumulated.isEmpty ? String(component) : accumulated + "/" + component
            result.append((name: String(component), path: accumulated))
        }
        return result
    }

    // MARK: - 视图

    var body: some View {
        List {
            if currentDir.isEmpty && current.files.isEmpty {
                emptySection
            } else {
                breadcrumbSection
                if !folders.isEmpty || !files.isEmpty {
                    directorySections
                } else {
                    emptyFolderSection
                }
            }
            if let url = current.publicURL {
                linkSection(url)
            }
            diagnosticsSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { publishBar }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showNewFile = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(L10n.string("explorer_new_file"))
            }
        }
        .sheet(isPresented: $showNewFile) {
            NewFileSheet(
                initialDir: currentDir,
                existingPaths: current.files.map(\.path)
            ) { path in
                createFile(path: path)
            }
        }
        .sheet(item: $editingFile) { file in
            FileEditorView(projectId: current.id, path: file.path) { updated in
                apply(updated)
            }
        }
        .sheet(isPresented: $showQR) {
            QRCodeView(project: current)
        }
        .confirmationDialog(
            L10n.string("explorer_delete_file_title"),
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n.string("delete_confirm_button"), role: .destructive) {
                if let target = deleteTarget {
                    deleteTarget = nil
                    Task { await deleteFile(target) }
                }
            }
            Button(L10n.string("cancel"), role: .cancel) { deleteTarget = nil }
        } message: {
            if let target = deleteTarget {
                Text("\(target.path)\n\(L10n.string("explorer_delete_file_message"))")
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

    // MARK: 空项目

    private var emptySection: some View {
        Section {
            VStack(spacing: 14) {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 48))
                    .foregroundStyle(.secondary)
                Text(L10n.string("explorer_empty_title"))
                    .font(.title3.bold())
                Text(L10n.string("explorer_empty_hint"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    showNewFile = true
                } label: {
                    Label(L10n.string("explorer_new_file"), systemImage: "plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .padding(.horizontal, 24)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .listRowBackground(Color.clear)
        }
    }

    private var emptyFolderSection: some View {
        Section {
            Text(L10n.string("explorer_empty_folder"))
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    // MARK: 面包屑

    private var breadcrumbSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(Array(breadcrumbs.enumerated()), id: \.element.path) { index, crumb in
                        if index > 0 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10))
                                .foregroundStyle(.tertiary)
                        }
                        Button {
                            currentDir = crumb.path
                        } label: {
                            Text(crumb.name)
                                .font(.footnote)
                                .fontWeight(index == breadcrumbs.count - 1 ? .bold : .regular)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(index == breadcrumbs.count - 1 ? .primary : .secondary)
                    }
                }
            }
        }
    }

    // MARK: 目录内容

    @ViewBuilder
    private var directorySections: some View {
        Section {
            ForEach(folders) { folder in
                Button {
                    currentDir = folder.path
                } label: {
                    Label {
                        Text(folder.name)
                    } icon: {
                        Image(systemName: "folder.fill")
                            .foregroundStyle(.blue)
                    }
                }
                .foregroundStyle(.primary)
            }
        }
        Section {
            ForEach(files) { file in
                Button {
                    editingFile = EditingFile(path: file.path)
                } label: {
                    Label {
                        Text(file.name)
                            .lineLimit(1)
                        if let url = current.publicURL, isEntry(file.path) {
                            Text(L10n.string("explorer_entry_badge"))
                                .font(.caption2)
                                .foregroundStyle(.green)
                        }
                    } icon: {
                        let icon = fileIcon(file.path)
                        Image(systemName: icon.symbol)
                            .foregroundStyle(icon.color)
                    }
                }
                .foregroundStyle(.primary)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        deleteTarget = file
                    } label: {
                        Label(L10n.string("delete_confirm_button"), systemImage: "trash")
                    }
                }
            }
        }
    }

    private func isEntry(_ path: String) -> Bool {
        current.entryPath.map { $0 == path } ?? false
    }

    private func fileIcon(_ path: String) -> (symbol: String, color: Color) {
        let lower = path.lowercased()
        if lower.hasSuffix(".css") { return ("paintbrush.pointed.fill", .blue) }
        if lower.hasSuffix(".js") { return ("chevron.left.forwardslash.chevron.right", .orange) }
        return ("doc.richtext.fill", .red)
    }

    // MARK: 公开链接

    private func linkSection(_ url: URL) -> some View {
        Section(L10n.string("explorer_link_section")) {
            HStack(spacing: 14) {
                Text(url.absoluteString)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button {
                    UIPasteboard.general.string = url.absoluteString
                    alertItem = AlertItem(message: L10n.string("link_copied"), titleKey: "alert_tip")
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .accessibilityLabel(L10n.string("copy_link"))
                Button {
                    showQR = true
                } label: {
                    Image(systemName: "qrcode")
                }
                .accessibilityLabel(L10n.string("qr_code"))
            }
        }
    }

    // MARK: 发布检查提示（小白话，帮助新手发现问题）

    @ViewBuilder
    private var diagnosticsSection: some View {
        if !current.diagnostics.isEmpty {
            Section(L10n.format("explorer_issues_title", current.diagnostics.count)) {
                ForEach(current.diagnostics) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Label {
                            Text(item.detail)
                                .font(.footnote)
                        } icon: {
                            Image(systemName: "lightbulb")
                                .foregroundStyle(.orange)
                        }
                        if !item.suggestion.isEmpty {
                            Text(item.suggestion)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    // MARK: 底部发布栏

    private var publishBar: some View {
        HStack(spacing: 12) {
            if isPublishing {
                ProgressView()
                Text(L10n.string("explorer_publishing"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button {
                Task { await publish() }
            } label: {
                Text(current.publicURL == nil
                     ? L10n.string("explorer_publish")
                     : L10n.string("explorer_republish"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .disabled(isPublishing)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: - 操作

    private func apply(_ project: Project) {
        current = project
        appState.upsertProject(project)
    }

    /// 新建文件：先写入 HTML 起始骨架（css/js 为空文件），成功后直接进入编辑器
    private func createFile(path: String) {
        Task {
            do {
                let content = NewFileSheet.starterContent(for: path)
                let updated = try await APIClient.shared.addFile(
                    projectId: current.id,
                    path: path,
                    content: Data(content.utf8)
                )
                apply(updated)
                editingFile = EditingFile(path: path)
            } catch let error as APIError {
                alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
            } catch {
                alertItem = AlertItem(message: L10n.string("error_generic"))
            }
        }
    }

    private func deleteFile(_ entry: ExplorerEntry) async {
        do {
            let updated = try await APIClient.shared.deleteFile(projectId: current.id, path: entry.path)
            apply(updated)
        } catch let error as APIError {
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }

    private func publish() async {
        isPublishing = true
        defer { isPublishing = false }
        do {
            let updated = try await APIClient.shared.publishProject(current.id)
            apply(updated)
            alertItem = AlertItem(message: L10n.string("explorer_publish_done"), titleKey: "alert_tip")
        } catch let error as APIError {
            if case .http(_, let code) = error, code == "NO_ENTRY" {
                alertItem = AlertItem(message: L10n.string("explorer_need_entry"))
            } else {
                alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
            }
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}

// MARK: - 新建文件

/// 新建文件 sheet：输入文件名或路径（css/style.css 自动建虚拟文件夹，默认补 .html）
struct NewFileSheet: View {
    let existingPaths: [String]
    let onCreate: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(initialDir: String, existingPaths: [String], onCreate: @escaping (String) -> Void) {
        self.existingPaths = existingPaths
        self.onCreate = onCreate
        // 位于文件夹内时预填路径前缀
        _text = State(initialValue: initialDir.isEmpty ? "" : initialDir + "/")
    }

    /// 规范化 + 校验；返回 nil 表示不合法
    var normalizedPath: String? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        raw = raw.replacingOccurrences(of: "\\", with: "/")
        while raw.hasPrefix("./") { raw.removeFirst(2) }
        // 无扩展名 → 默认 .html（细节：降低新手门槛）
        if !raw.contains(".") { raw += ".html" }
        guard raw.count <= 200,
              !raw.contains(".."),
              !raw.hasPrefix("/"),
              !raw.hasSuffix("/") else { return nil }
        // 禁止控制字符与反斜杠
        if raw.unicodeScalars.contains(where: { $0.value < 32 }) { return nil }
        // 仅支持 html / css / js
        let lower = raw.lowercased()
        guard lower.hasSuffix(".html") || lower.hasSuffix(".htm")
                || lower.hasSuffix(".css") || lower.hasSuffix(".js") else { return nil }
        return raw
    }

    /// 文件是否已存在（存在则提示覆盖）
    var isOverwrite: Bool {
        guard let path = normalizedPath else { return false }
        return existingPaths.contains(path)
    }

    /// 新文件起始内容：HTML 给最小骨架，CSS 给注释行，JS 为空
    static func starterContent(for path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".css") {
            return L10n.string("explorer_css_starter") + "\n"
        }
        if lower.hasSuffix(".js") {
            return ""
        }
        let fileName = (path as NSString).lastPathComponent
        return """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>\(fileName)</title>
        </head>
        <body>
          <h1>\(fileName)</h1>
          <p>\(L10n.string("explorer_html_starter"))</p>
        </body>
        </html>
        """
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L10n.string("explorer_new_file_placeholder"), text: $text)
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                        if let path = normalizedPath {
                            Label(path, systemImage: "doc.badge.plus")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if isOverwrite {
                                Label(L10n.string("explorer_exists_overwrite"), systemImage: "exclamationmark.triangle")
                                    .font(.footnote)
                                    .foregroundStyle(.orange)
                            }
                        } else {
                            Label(L10n.string("explorer_bad_name"), systemImage: "xmark.circle")
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                } header: {
                    Text(L10n.string("explorer_new_file"))
                } footer: {
                    Text(L10n.string("explorer_new_file_hint"))
                }
            }
            .navigationTitle(L10n.string("explorer_new_file"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("explorer_create_file")) {
                        if let path = normalizedPath {
                            dismiss()
                            onCreate(path)
                        }
                    }
                    .disabled(normalizedPath == nil)
                }
            }
        }
    }
}

// MARK: - 文件编辑器

/// 全屏文本编辑器：载入 → 编辑 → 保存；关闭时未保存会确认
struct FileEditorView: View {
    let projectId: String
    let path: String
    let onSaved: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var original = ""
    @State private var isLoading = true
    @State private var loadFailed = false
    @State private var isSaving = false
    @State private var showDiscardConfirm = false
    @State private var alertItem: AlertItem?

    private var isModified: Bool { content != original }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else if loadFailed {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 40))
                            .foregroundStyle(.orange)
                        Text(L10n.string("explorer_read_failed"))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(spacing: 0) {
                        Text(path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .padding(.horizontal)
                            .padding(.vertical, 6)
                        TextEditor(text: $content)
                            .font(.system(.footnote, design: .monospaced))
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                }
            }
            .navigationTitle((path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("done")) {
                        if isModified {
                            showDiscardConfirm = true
                        } else {
                            dismiss()
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    HStack(spacing: 8) {
                        if isModified && !isLoading && !loadFailed {
                            Text(L10n.string("explorer_unsaved"))
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                        Button {
                            Task { await save() }
                        } label: {
                            if isSaving {
                                ProgressView()
                            } else {
                                Text(L10n.string("explorer_save"))
                            }
                        }
                        .disabled(isSaving || isLoading || loadFailed || !isModified)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !isLoading && !loadFailed {
                    Text(L10n.format("explorer_chars", content.count))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.bottom, 4)
                }
            }
            .confirmationDialog(
                L10n.string("explorer_discard_confirm"),
                isPresented: $showDiscardConfirm,
                titleVisibility: .visible
            ) {
                Button(L10n.string("explorer_discard_yes"), role: .destructive) { dismiss() }
                Button(L10n.string("cancel"), role: .cancel) {}
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

    private func load() async {
        do {
            let text = try await APIClient.shared.readTextFile(projectId: projectId, path: path)
            content = text
            original = text
        } catch {
            loadFailed = true
        }
        isLoading = false
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await APIClient.shared.addFile(
                projectId: projectId,
                path: path,
                content: Data(content.utf8)
            )
            original = content
            onSaved(updated)
        } catch let error as APIError {
            if case .http(_, let code) = error, code == "TOO_LARGE" {
                alertItem = AlertItem(message: L10n.string("file_too_large_single"))
            } else {
                alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
            }
        } catch {
            alertItem = AlertItem(message: L10n.string("error_generic"))
        }
    }
}
