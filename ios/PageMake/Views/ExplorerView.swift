import SwiftUI

/// 项目模式：Windows 风格文件资源管理器
/// - 文件夹来自后端持久化清单（包含显式创建的空目录）
/// - 支持新建/重命名/删除文件与文件夹、路径导航、详情与预览
/// - 发布后可直接进入 PreviewView，不需要再回项目列表
struct ExplorerView: View {
    let initial: Project

    @EnvironmentObject private var appState: AppState
    @State private var current: Project
    @State private var currentDir = ""
    @State private var selection: ExplorerEntry?
    @State private var activeSheet: ActiveSheet?
    @State private var deleteTarget: ExplorerEntry?
    @State private var alertItem: AlertItem?
    @State private var isPublishing = false
    @State private var isWorking = false

    init(project: Project) {
        self.initial = project
        _current = State(initialValue: project)
    }

    // MARK: - 状态

    enum ActiveSheet: Identifiable {
        case newFile
        case newFolder
        case rename(ExplorerEntry)
        case edit(String)
        case preview
        case qr

        var id: String {
            switch self {
            case .newFile: return "new-file"
            case .newFolder: return "new-folder"
            case .rename(let entry): return "rename-\(entry.path)"
            case .edit(let path): return "edit-\(path)"
            case .preview: return "preview"
            case .qr: return "qr"
            }
        }
    }

    struct ExplorerEntry: Identifiable, Hashable {
        let name: String
        let path: String
        let isFolder: Bool
        var size: Int64 = 0
        var id: String { path }
    }

    // MARK: - 目录数据

    private var entries: (folders: [ExplorerEntry], files: [ExplorerEntry]) {
        let prefix = currentDir.isEmpty ? "" : currentDir + "/"
        var folderPaths = Set<String>()
        for folder in current.folders {
            guard folder.hasPrefix(prefix), folder != prefix else { continue }
            let rest = String(folder.dropFirst(prefix.count))
            guard !rest.isEmpty else { continue }
            folderPaths.insert(String(rest.split(separator: "/")[0]))
        }
        var fileEntries: [ExplorerEntry] = []
        for file in current.files {
            guard file.path.hasPrefix(prefix), file.path != prefix else { continue }
            let rest = String(file.path.dropFirst(prefix.count))
            guard !rest.isEmpty else { continue }
            if let slash = rest.firstIndex(of: "/") {
                folderPaths.insert(String(rest[..<slash]))
            } else {
                fileEntries.append(ExplorerEntry(
                    name: rest,
                    path: file.path,
                    isFolder: false,
                    size: file.size
                ))
            }
        }
        let folders = folderPaths.sorted {
            $0.localizedStandardCompare($1) == .orderedAscending
        }.map {
            ExplorerEntry(name: $0, path: prefix + $0, isFolder: true)
        }
        fileEntries.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return (folders, fileEntries)
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

    private var parentPath: String? {
        guard !currentDir.isEmpty else { return nil }
        let parts = currentDir.split(separator: "/")
        return parts.count <= 1 ? "" : parts.dropLast().joined(separator: "/")
    }

    // MARK: - 视图

    var body: some View {
        VStack(spacing: 0) {
            addressBar
            Divider()
            buildBar
            Divider()
            content
        }
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button {
                        activeSheet = .newFile
                    } label: {
                        Label(L10n.string("explorer_new_file"), systemImage: "doc.badge.plus")
                    }
                    Button {
                        activeSheet = .newFolder
                    } label: {
                        Label(L10n.string("explorer_new_folder"), systemImage: "folder.badge.plus")
                    }
                } label: {
                    Label(L10n.string("explorer_new"), systemImage: "plus")
                }
                .accessibilityLabel(L10n.string("explorer_new"))
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        Task { await publish() }
                    } label: {
                        Label(
                            current.publicURL == nil
                                ? L10n.string("explorer_build")
                                : L10n.string("explorer_rebuild"),
                            systemImage: "hammer.fill"
                        )
                    }
                    .disabled(isPublishing)

                    Button {
                        activeSheet = .preview
                    } label: {
                        Label(L10n.string("preview"), systemImage: "eye")
                    }
                    .disabled(current.publicURL == nil)

                    Button {
                        activeSheet = .qr
                    } label: {
                        Label(L10n.string("qr_code"), systemImage: "qrcode")
                    }
                    .disabled(current.publicURL == nil)

                    if let url = current.publicURL {
                        Button {
                            UIPasteboard.general.string = url.absoluteString
                            alertItem = AlertItem(message: L10n.string("link_copied"), titleKey: "alert_tip")
                        } label: {
                            Label(L10n.string("copy_link"), systemImage: "doc.on.doc")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(L10n.string("more_actions"))
            }
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .newFile:
                NewFileSheet(
                    initialDir: currentDir,
                    existingPaths: current.files.map(\.path),
                    kind: current.kind
                ) { path in
                    createFile(path: path, sheetId: sheet.id)
                }
            case .newFolder:
                NewFolderSheet(initialDir: currentDir) { path in
                    createFolder(path: path)
                }
            case .rename(let entry):
                RenameEntrySheet(entry: entry) { newName in
                    rename(entry, to: newName)
                }
            case .edit(let path):
                FileEditorView(projectId: current.id, path: path) { updated in
                    apply(updated)
                }
            case .preview:
                NavigationStack {
                    PreviewView(project: current)
                }
            case .qr:
                QRCodeView(project: current)
            }
        }
        .confirmationDialog(
            L10n.string("explorer_delete_title"),
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n.string("delete_confirm_button"), role: .destructive) {
                if let target = deleteTarget {
                    deleteTarget = nil
                    Task { await delete(target) }
                }
            }
            Button(L10n.string("cancel"), role: .cancel) { deleteTarget = nil }
        } message: {
            if let target = deleteTarget {
                Text(target.isFolder
                     ? L10n.format("explorer_delete_folder_message", target.path)
                     : L10n.format("explorer_delete_file_message", target.path))
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
            if isWorking {
                ProgressView()
                    .padding(18)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    // MARK: - 路径栏

    private var addressBar: some View {
        HStack(spacing: 8) {
            Button {
                if let parentPath { currentDir = parentPath }
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 32, height: 32)
            }
            .disabled(parentPath == nil)
            .accessibilityLabel(L10n.string("explorer_back"))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 3) {
                    ForEach(Array(breadcrumbs.enumerated()), id: \.element.path) { index, crumb in
                        if index > 0 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(.tertiary)
                        }
                        Button {
                            currentDir = crumb.path
                        } label: {
                            Text(crumb.name)
                                .font(.system(.footnote, design: .rounded,
                                              weight: index == breadcrumbs.count - 1 ? .semibold : .regular))
                                .foregroundStyle(index == breadcrumbs.count - 1 ? .primary : .secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 4)
            }

            Button {
                Task { await refreshProject() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel(L10n.string("refresh"))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.bar)
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        let list = entries
        if current.files.isEmpty && current.folders.isEmpty {
            emptyProjectView
        } else if list.folders.isEmpty && list.files.isEmpty {
            emptyFolderView
        } else {
            List {
                if !list.folders.isEmpty {
                    Section(L10n.string("explorer_folders")) {
                        ForEach(list.folders) { folder in
                            row(folder)
                        }
                    }
                }
                if !list.files.isEmpty {
                    Section(L10n.string("explorer_files")) {
                        ForEach(list.files) { file in
                            row(file)
                        }
                    }
                }
                if let selection, !selection.isFolder {
                    Section(L10n.string("explorer_details")) {
                        fileDetails(selection)
                    }
                }
                if !current.diagnostics.isEmpty {
                    Section(L10n.format("explorer_issues_title", current.diagnostics.count)) {
                        ForEach(current.diagnostics) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.detail).font(.footnote)
                                if !item.suggestion.isEmpty {
                                    Text(item.suggestion)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .animation(.default, value: currentDir)
        }
    }

    private func row(_ entry: ExplorerEntry) -> some View {
        Button {
            if entry.isFolder {
                currentDir = entry.path
                selection = nil
            } else {
                selection = entry
                activeSheet = .edit(entry.path)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: entry.isFolder ? "folder.fill" : fileIcon(entry.path).symbol)
                    .font(.system(size: 22))
                    .foregroundStyle(entry.isFolder ? Color.blue : fileIcon(entry.path).color)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(entry.name)
                            .font(.system(.body, design: .rounded))
                            .lineLimit(1)
                        if !entry.isFolder && isEntry(entry.path) {
                            Text(L10n.string("explorer_entry_badge"))
                                .font(.caption2.bold())
                                .foregroundStyle(.green)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.green.opacity(0.12), in: Capsule())
                        }
                    }
                    Text(entry.isFolder
                         ? L10n.string("explorer_folder_kind")
                         : "\(fileKind(entry.path)) · \(ByteCountFormatter.string(fromByteCount: entry.size, countStyle: .file))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if entry.isFolder {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                deleteTarget = entry
            } label: {
                Label(L10n.string("delete_confirm_button"), systemImage: "trash")
            }
        }
        .contextMenu {
            if entry.isFolder {
                Button {
                    currentDir = entry.path
                } label: {
                    Label(L10n.string("explorer_open"), systemImage: "folder")
                }
            } else {
                Button {
                    selection = entry
                    activeSheet = .edit(entry.path)
                } label: {
                    Label(L10n.string("explorer_open"), systemImage: "doc.text")
                }
            }
            Button {
                activeSheet = .rename(entry)
            } label: {
                Label(L10n.string("rename"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleteTarget = entry
            } label: {
                Label(L10n.string("delete_confirm_button"), systemImage: "trash")
            }
        }
    }

    private func fileDetails(_ file: ExplorerEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent(L10n.string("explorer_name"), value: file.name)
            LabeledContent(L10n.string("explorer_path"), value: file.path)
            LabeledContent(L10n.string("explorer_size"),
                           value: ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file))
            LabeledContent(L10n.string("explorer_type"), value: fileKind(file.path))
            HStack {
                Button {
                    activeSheet = .edit(file.path)
                } label: {
                    Label(L10n.string("explorer_edit"), systemImage: "square.and.pencil")
                }
                .buttonStyle(.bordered)
                Button {
                    activeSheet = .rename(file)
                } label: {
                    Label(L10n.string("rename"), systemImage: "pencil")
                }
                .buttonStyle(.bordered)
            }
        }
        .font(.footnote)
    }

    private var emptyProjectView: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 54))
                .foregroundStyle(.blue)
            Text(L10n.string("explorer_empty_title"))
                .font(.system(.title3, design: .rounded, weight: .bold))
            Text(L10n.string("explorer_empty_hint"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 30)
            HStack {
                Button(L10n.string("explorer_new_file")) { activeSheet = .newFile }
                    .buttonStyle(.borderedProminent)
                Button(L10n.string("explorer_new_folder")) { activeSheet = .newFolder }
                    .buttonStyle(.bordered)
            }
            Button {
                Task { await publish() }
            } label: {
                Label(
                    current.publicURL == nil
                        ? L10n.string("explorer_build")
                        : L10n.string("explorer_rebuild"),
                    systemImage: "hammer.fill"
                )
            }
            .buttonStyle(.bordered)
            .disabled(isPublishing)
            Spacer()
        }
    }

    private var emptyFolderView: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "folder")
                .font(.system(size: 46))
                .foregroundStyle(.tertiary)
            Text(L10n.string("explorer_empty_folder"))
                .foregroundStyle(.secondary)
            Button(L10n.string("explorer_new_file")) { activeSheet = .newFile }
                .buttonStyle(.bordered)
            Spacer()
        }
    }

    /// 构建操作栏必须独立于导航栏和底栏：这两处在窄屏、动态字体或分享
    /// 按钮较多时都会压缩子视图，用户会误以为「没有构建按钮」。
    private var buildBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(current.publicURL == nil ? PageMakeTheme.gold : PageMakeTheme.sea)
                            .frame(width: 7, height: 7)
                        Text(current.publicURL == nil
                             ? L10n.string("explorer_not_built")
                             : L10n.string("explorer_built"))
                            .font(.system(.caption, design: .rounded, weight: .bold))
                            .foregroundStyle(PageMakeTheme.ink)
                    }
                    Text(entrySummary)
                        .font(.caption2)
                        .foregroundStyle(PageMakeTheme.inkSoft)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)

                Button {
                    Task { await publish() }
                } label: {
                    HStack(spacing: 6) {
                        if isPublishing {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        } else {
                            Image(systemName: "hammer.fill")
                        }
                        Text(isPublishing
                             ? L10n.string("explorer_publishing")
                             : (current.publicURL == nil
                                ? L10n.string("explorer_build")
                                : L10n.string("explorer_rebuild")))
                            .font(.system(.caption, design: .rounded, weight: .bold))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(PageMakeTheme.coral,
                                in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .disabled(isPublishing)
                .accessibilityLabel(current.publicURL == nil
                                    ? L10n.string("explorer_build")
                                    : L10n.string("explorer_rebuild"))
            }

            if let url = current.publicURL {
                HStack(spacing: 8) {
                    Text(url.absoluteString)
                        .font(.caption2.monospaced())
                        .foregroundStyle(PageMakeTheme.inkSoft)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button {
                        UIPasteboard.general.string = url.absoluteString
                        alertItem = AlertItem(message: L10n.string("link_copied"), titleKey: "alert_tip")
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .accessibilityLabel(L10n.string("copy_link"))
                    Button {
                        activeSheet = .qr
                    } label: {
                        Image(systemName: "qrcode")
                    }
                    .accessibilityLabel(L10n.string("qr_code"))
                }
                .font(.caption)
                .foregroundStyle(PageMakeTheme.inkSoft)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(PageMakeTheme.surfaceSoft)
    }

    private var entrySummary: String {
        if let entry = current.entryPath, !entry.isEmpty {
            return L10n.format("explorer_entry_summary", entry)
        }
        return L10n.string("explorer_no_entry_summary")
    }

    // MARK: - 操作

    private func apply(_ project: Project) {
        current = project
        appState.upsertProject(project)
        if !currentDir.isEmpty && !project.folders.contains(currentDir) {
            currentDir = ""
        }
    }

    private func isEntry(_ path: String) -> Bool {
        current.entryPath == path
    }

    private func fileKind(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return L10n.string("explorer_kind_html")
        case "css": return L10n.string("explorer_kind_css")
        case "js": return L10n.string("explorer_kind_js")
        default: return (path as NSString).pathExtension.uppercased()
        }
    }

    private func fileIcon(_ path: String) -> (symbol: String, color: Color) {
        switch (path as NSString).pathExtension.lowercased() {
        case "css": return ("paintbrush.pointed.fill", .blue)
        case "js": return ("chevron.left.forwardslash.chevron.right", .orange)
        default: return ("doc.richtext.fill", .red)
        }
    }

    private func refreshProject() async {
        isWorking = true
        defer { isWorking = false }
        do {
            let updated = try await APIClient.shared.project(current.id)
            apply(updated)
        } catch {
            alertItem = AlertItem(message: L10n.string("error_network"))
        }
    }

    /// 新建文件：先写入 HTML 起始骨架（css/js 为空文件），成功后直接进入编辑器
    private func createFile(path: String, sheetId: String) {
        Task {
            do {
                let content = NewFileSheet.starterContent(for: path)
                let updated = try await APIClient.shared.addFile(
                    projectId: current.id,
                    path: path,
                    content: Data(content.utf8)
                )
                apply(updated)
                // 必须留在同一个 sheet 生命周期里切换内容。若先关闭新建 sheet、
                // 下一帧再打开编辑器，SwiftUI 的关闭转场会吞掉第二次 presentation。
                guard activeSheet?.id == sheetId else { return }
                activeSheet = .edit(path)
            } catch let error as APIError {
                alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
            } catch {
                alertItem = AlertItem(message: L10n.string("error_generic"))
            }
        }
    }

    private func createFolder(path: String) {
        Task {
            isWorking = true
            defer { isWorking = false }
            do {
                let updated = try await APIClient.shared.createFolder(projectId: current.id, path: path)
                apply(updated)
            } catch let error as APIError {
                alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
            } catch {
                alertItem = AlertItem(message: L10n.string("error_generic"))
            }
        }
    }

    private func rename(_ entry: ExplorerEntry, to newName: String) {
        Task {
            isWorking = true
            defer { isWorking = false }
            let parent = entry.path.split(separator: "/").dropLast().joined(separator: "/")
            let target = parent.isEmpty ? newName : parent + "/" + newName
            do {
                let updated = try await APIClient.shared.renameEntry(
                    projectId: current.id,
                    from: entry.path,
                    to: target
                )
                apply(updated)
                selection = nil
            } catch let error as APIError {
                alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
            } catch {
                alertItem = AlertItem(message: L10n.string("error_generic"))
            }
        }
    }

    private func delete(_ entry: ExplorerEntry) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let updated = entry.isFolder
                ? try await APIClient.shared.deleteFolder(projectId: current.id, path: entry.path)
                : try await APIClient.shared.deleteFile(projectId: current.id, path: entry.path)
            apply(updated)
            if selection?.path == entry.path || selection?.path.hasPrefix(entry.path + "/") == true {
                selection = nil
            }
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
            var updated = try await APIClient.shared.publishProject(current.id, kind: current.kind)
            if updated.status == .processing {
                updated = try await APIClient.shared.waitForProjectReady(current.id)
            }
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
    /// 后端项目允许 package.json / TS 源码等；纯前端仍只收 html/css/js
    let kind: ProjectKind
    let onCreate: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(initialDir: String, existingPaths: [String], kind: ProjectKind = .staticSite, onCreate: @escaping (String) -> Void) {
        self.existingPaths = existingPaths
        self.kind = kind
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
        // 纯前端只支持 html / css / js；后端项目额外允许 package.json 与源码/配置
        let lower = raw.lowercased()
        if kind.isBackend {
            let allowed = [".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json",
                           ".ts", ".tsx", ".jsx", ".md", ".txt", ".yml", ".yaml",
                           ".toml", ".xml", ".graphql", ".gql", ".sql", ".map",
                           ".wasm", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
                           ".ico", ".bmp", ".avif", ".woff", ".woff2", ".ttf", ".otf",
                           ".eot", ".mp3", ".mp4", ".webm", ".pdf", ".csv", ".lock"]
            guard allowed.contains(where: { lower.hasSuffix($0) }) else { return nil }
        } else {
            guard lower.hasSuffix(".html") || lower.hasSuffix(".htm")
                    || lower.hasSuffix(".css") || lower.hasSuffix(".js") else { return nil }
        }
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
        let directory = (path as NSString).deletingLastPathComponent
        // HTML 位于子目录时，link 也必须相对该 HTML，否则会指向不存在的目录。
        let cssHref = directory.isEmpty ? "style.css" : directory + "/style.css"
        return """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>\(fileName)</title>
          <link rel="stylesheet" href="\(cssHref)">
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

// MARK: - 新建文件夹

struct NewFolderSheet: View {
    let initialDir: String
    let onCreate: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(initialDir: String, onCreate: @escaping (String) -> Void) {
        self.initialDir = initialDir
        self.onCreate = onCreate
        _text = State(initialValue: initialDir.isEmpty ? "" : initialDir + "/")
    }

    var normalizedPath: String? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        raw = raw.replacingOccurrences(of: "\\", with: "/")
        while raw.hasPrefix("./") { raw.removeFirst(2) }
        guard !raw.isEmpty, raw.count <= 200,
              !raw.contains(".."), !raw.hasPrefix("/"), !raw.hasSuffix("/") else { return nil }
        if raw.unicodeScalars.contains(where: { $0.value < 32 }) { return nil }
        return raw
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L10n.string("explorer_folder_placeholder"), text: $text)
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } footer: {
                    Text(L10n.string("explorer_folder_hint"))
                }
            }
            .navigationTitle(L10n.string("explorer_new_folder"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("explorer_create_folder")) {
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

// MARK: - 重命名

struct RenameEntrySheet: View {
    let entry: ExplorerView.ExplorerEntry
    let onRename: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(entry: ExplorerView.ExplorerEntry, onRename: @escaping (String) -> Void) {
        self.entry = entry
        self.onRename = onRename
        _text = State(initialValue: entry.name)
    }

    private var normalizedName: String? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        raw = raw.replacingOccurrences(of: "\\", with: "/")
        guard !raw.isEmpty, raw.count <= 100,
              !raw.contains(".."), !raw.contains("/"),
              !raw.unicodeScalars.contains(where: { $0.value < 32 }) else { return nil }
        if !entry.isFolder && !raw.contains(".") { raw += ".html" }
        if !entry.isFolder {
            let lower = raw.lowercased()
            guard lower.hasSuffix(".html") || lower.hasSuffix(".htm")
                    || lower.hasSuffix(".css") || lower.hasSuffix(".js") else { return nil }
        }
        return raw
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L10n.string("explorer_rename_placeholder"), text: $text)
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } footer: {
                    Text(entry.isFolder
                         ? L10n.string("explorer_rename_folder_hint")
                         : L10n.string("explorer_rename_file_hint"))
                }
            }
            .navigationTitle(L10n.string("rename"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("confirm")) {
                        if let name = normalizedName, name != entry.name {
                            dismiss()
                            onRename(name)
                        }
                    }
                    .disabled(normalizedName == nil || normalizedName == entry.name)
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
                            .foregroundStyle(PageMakeTheme.codeText)
                            .tint(PageMakeTheme.coral)
                            .scrollContentBackground(.hidden)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .padding(8)
                            .background(PageMakeTheme.codeBackground)
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
