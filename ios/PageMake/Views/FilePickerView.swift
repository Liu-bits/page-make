import SwiftUI
import UniformTypeIdentifiers

/// 创建入口：上传文件 / 粘贴代码 / 项目模式
struct FilePickerView: View {
    /// 当前账号能否选择后端形态（VIP / SVIP / Ultra 才行）
    let canUseBackend: Bool
    /// 当前账号能否打开项目模式（SVIP 及以上才行）
    let canUseExplorer: Bool
    /// nil = Ultra 无上限
    let maxUploadBytes: Int64?
    let onPick: (CreateSource) -> Void

    private enum Mode: Hashable {
        case files
        case paste
        case explorer
    }

    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .files
    @State private var showPicker = false
    @State private var alertItem: AlertItem?
    @State private var projectName = ""
    /// 需要用户明确确认的待定上传：不能静默降级成纯前端。
    @State private var pendingBackendUpload: PendingBackendUpload?
    /// 待回收的临时文件，只在页面真正关闭时删除（见 onDisappear）。
    /// **不能**在弹窗关闭回调里立刻删：系统关闭回调与按钮 action 的执行顺序
    /// 不确定，若先删文件，紧接着 onPick 拿到的 URL 已失效，上传必失败。
    /// 交接给上传队列时把那一批从这里摘掉即可，不需要额外的「已交接」标志
    /// （用布尔标志会让「先取消一批、再成功交接一批」时前一批永远不被回收）。
    @State private var pendingRecycleFiles: [PickedFile] = []

    // 粘贴模式内容
    @State private var html = ""
    @State private var css = ""

    private static let ordinaryPasteLimitBytes: Int64 = 300 * 1024

    /// 为什么需要用户确认
    private enum PendingUploadReason {
        /// 检测到后端项目（根目录 package.json），但当前账号没有 VIP 权限
        case backendRequiresVIP
        /// ZIP 中央目录读不出条目名，无法判定部署形态
        case undetermined
    }

    private struct PendingBackendUpload: Identifiable {
        let id = UUID()
        let files: [PickedFile]
        let name: String
        let reason: PendingUploadReason
    }

    /// 上传时用于扩展名白名单/配额的形态：VIP 及以上按后端白名单收源码，
    /// 普通账号只收静态资源；真正的部署形态由选中的文件自动识别。
    private var uploadWhitelistKind: ProjectKind {
        canUseBackend ? .npm : .staticSite
    }

    private var supportedTypes: [UTType] {
        var types: [UTType] = []
        let extensions = canUseBackend
            ? FileValidator.backendAllowedExtensions
            : FileValidator.staticAllowedExtensions
        for ext in extensions {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }

    private var pasteContent: PasteContent {
        PasteContent(html: html, css: css)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PageMakeBackground()
                VStack(spacing: 0) {
                    modeChooser
                        .padding(.horizontal, 16)
                        .padding(.top, 10)

                    Group {
                        switch mode {
                        case .files:
                            filesMode
                        case .paste:
                            pasteMode
                        case .explorer:
                            explorerMode
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                    autoDetectBar
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)
                }
            }
            .navigationTitle(L10n.string("creation_studio"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
            }
            .confirmationDialog(
                L10n.string(pendingDialogTitleKey),
                isPresented: Binding(
                    get: { pendingBackendUpload != nil },
                    set: { presented in
                        guard !presented else { return }
                        // 只清状态，不在这里删临时文件：系统关闭回调可能早于按钮
                        // action 执行，先删文件会让随后的 onPick 拿到失效 URL。
                        // 真正放弃时由 cancel 按钮 / onDisappear 统一回收。
                        pendingBackendUpload = nil
                    }
                ),
                titleVisibility: .visible
            ) {
                if let pending = pendingBackendUpload {
                    Button(L10n.string("deploy_downgrade_static")) {
                        // 先把文件清单取出来，再清空待定状态（会触发上面的 setter）；
                        // 这一批交给上传队列，从待回收列表摘掉；之前取消留下的
                        // 其他临时文件仍会在 onDisappear 正常回收。
                        let files = pending.files
                        let name = pending.name
                        let handedOff = Set(files.map(\.url))
                        pendingRecycleFiles.removeAll { handedOff.contains($0.url) }
                        pendingBackendUpload = nil
                        onPick(.files(files, name: name, kind: .staticSite))
                    }
                    Button(L10n.string("cancel"), role: .cancel) {
                        recycle(pending.files)
                        pendingBackendUpload = nil
                    }
                }
            } message: {
                Text(L10n.string(pendingDialogMessageKey))
            }
            .sheet(isPresented: $showPicker) {
                DocumentPicker(types: supportedTypes) { urls in
                    // UIKit delegate 回调不保证主线程；直接改 @State 会触发
                    // “Publishing changes from background threads” 甚至崩溃。
                    Task { @MainActor in
                        await handlePicked(urls)
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
            // 页面关闭时统一回收没有被交接出去的临时文件（取消 / 点空白处关闭）。
            .onDisappear {
                recycleLeftoverPendingFiles()
            }
        }
    }

    // MARK: - 待定上传提示

    private var pendingDialogTitleKey: String {
        pendingBackendUpload?.reason == .undetermined
            ? "deploy_kind_unknown_title"
            : "deploy_backend_requires_vip_title"
    }

    private var pendingDialogMessageKey: String {
        pendingBackendUpload?.reason == .undetermined
            ? "deploy_kind_unknown_message"
            : "deploy_backend_requires_vip_message"
    }

    // MARK: - 项目名称

    private var trimmedProjectName: String {
        projectName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private var nameField: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(L10n.string("project_name_field"))
                    .font(.system(.caption, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.secondaryLabel)
                    .textCase(.uppercase)
                    .tracking(0.4)
                Text(L10n.string("editor_required"))
                    .font(.caption2.bold())
                    .foregroundStyle(Theme.highlight)
            }
            TextField(L10n.string("project_name_placeholder"), text: $projectName)
                .font(.system(.body, design: .rounded, weight: .medium))
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .padding(.horizontal, 13)
                .padding(.vertical, 12)
                .glassPanel(radius: 12)
                .onChange(of: projectName) { _, newValue in
                    if newValue.count > 60 {
                        projectName = String(newValue.prefix(60))
                    }
                }
            Text(L10n.string("project_name_hint"))
                .font(.caption2)
                .foregroundStyle(Theme.secondaryLabel)
        }
    }

    private func validatedProjectName() -> String? {
        guard !trimmedProjectName.isEmpty else {
            alertItem = AlertItem(message: L10n.string("project_name_required"))
            return nil
        }
        return trimmedProjectName
    }

    // MARK: - 创建模式选择

    private var modeChooser: some View {
        HStack(spacing: 7) {
            modeButton(.files, icon: "doc.badge.plus", titleKey: "pick_mode_files")
            modeButton(.paste, icon: "chevron.left.forwardslash.chevron.right", titleKey: "pick_mode_paste")
            modeButton(.explorer, icon: "folder.badge.plus", titleKey: "mode_explorer")
        }
        .padding(5)
        .glassPanel(radius: 17)
    }

    private func modeButton(_ value: Mode, icon: String, titleKey: String) -> some View {
        let explorerDisabled = value == .explorer && !canUseExplorer
        let disabled = explorerDisabled
        return Button {
            guard !disabled else {
                alertItem = AlertItem(message: L10n.string("error_explorer_requires_svip"))
                return
            }
            withAnimation(.snappy(duration: 0.24)) {
                mode = value
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: disabled ? "lock.fill" : icon)
                    .font(.system(size: 11, weight: .semibold))
                Text(L10n.string(titleKey))
                    .font(.caption2.bold())
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(
                mode == value && !disabled ? Theme.label : Color.clear,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .foregroundStyle(disabled
                             ? Theme.tertiaryLabel
                             : (mode == value ? Theme.background : Theme.secondaryLabel))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 部署形态（自动识别，只读说明）

    /// 形态选择控件已移除：部署方式由项目文件自动判断。
    /// 这里只保留一行只读说明，让用户知道「不需要选」以及判断依据。
    private var autoDetectBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "wand.and.stars")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.positive)
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.string("deploy_auto_detect"))
                    .font(.system(.caption, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.label)
                Text(L10n.string("deploy_auto_detect_hint"))
                    .font(.caption2)
                    .foregroundStyle(Theme.secondaryLabel)
            }
            Spacer(minLength: 0)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel(radius: 17)
    }

    // MARK: - 文件模式

    private var filesMode: some View {
        ScrollView {
            VStack(spacing: 18) {
                creationHero(
                    icon: "shippingbox.fill",
                    eyebrowKey: "creation_zip_eyebrow",
                    titleKey: "pick_files_title",
                    detailKey: "pick_files_hint",
                    tint: Theme.premium,
                    detailText: uploadHint
                )

                PageMakeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        nameField

                        Label(L10n.string("creation_zip_note"), systemImage: "checkmark.circle.fill")
                            .font(.subheadline.bold())
                            .foregroundStyle(Theme.label)
                        Text(L10n.string("creation_zip_detail"))
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryLabel)
                            .fixedSize(horizontal: false, vertical: true)

                        Button {
                            if validatedProjectName() != nil {
                                showPicker = true
                            }
                        } label: {
                            Label(L10n.string("pick_files_action"), systemImage: "folder")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 18)
        }
    }

    // MARK: - 项目模式

    private var explorerMode: some View {
        ScrollView {
            VStack(spacing: 18) {
                creationHero(
                    icon: "folder.fill",
                    eyebrowKey: "creation_folder_eyebrow",
                    titleKey: "mode_explorer",
                    detailKey: "explorer_intro",
                    tint: Theme.positive
                )

                PageMakeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        nameField

                        Button {
                            if let name = validatedProjectName() {
                                // 空白项目还没有文件可检测：VIP 及以上按后端白名单建，
                                // 之后加 package.json 才能在发布时自动识别为 npm/pnpm。
                                // 普通账号建纯前端项目（后端白名单与配额本来也不可用）。
                                onPick(.explorer(name: name, kind: canUseBackend ? .npm : .staticSite))
                            }
                        } label: {
                            Label(L10n.string("explorer_create"), systemImage: "arrow.right")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 18)
        }
    }

    // MARK: - 粘贴模式

    private var pasteMode: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                creationHero(
                    icon: "chevron.left.forwardslash.chevron.right",
                    eyebrowKey: "creation_code_eyebrow",
                    titleKey: "pick_mode_paste",
                    detailKey: "paste_hint",
                    tint: Theme.highlight
                )

                nameField

                templatesRow

                editor(
                    title: L10n.string("paste_html"),
                    text: $html,
                    placeholder: L10n.string("paste_html_placeholder"),
                    minHeight: 220
                )
                editor(
                    title: L10n.string("paste_css"),
                    text: $css,
                    placeholder: L10n.string("paste_css_placeholder"),
                    minHeight: 120
                )
                Text(sizeText)
                    .font(.caption)
                    .foregroundStyle(isTooLarge ? Theme.highlight : Theme.secondaryLabel)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 18)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Divider().overlay(Theme.label.opacity(0.06))
                Button {
                    submitPaste()
                } label: {
                    Label(L10n.string("paste_create"), systemImage: "sparkles")
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .disabled(!pasteContent.hasContent)
                .opacity(pasteContent.hasContent ? 1 : 0.42)
            }
            .background(.ultraThinMaterial)
        }    }

    // MARK: - 模板

    private var templatesRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.string("templates"))
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(Theme.label)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(PasteTemplates.all) { tpl in
                        Button {
                            applyTemplate(tpl)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(L10n.string(tpl.nameKey))
                                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                                    .foregroundStyle(Theme.label)
                                Text(L10n.string("use_template"))
                                    .font(.caption)
                                    .foregroundStyle(Theme.secondaryLabel)
                            }
                            .padding(12)
                            .frame(width: 150, alignment: .leading)
                            .glassPanel(radius: 15)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    private func applyTemplate(_ tpl: PasteTemplate) {
        html = tpl.html
        css = tpl.css
    }

    private func editor(title: String, text: Binding<String>, placeholder: String, minHeight: CGFloat) -> some View {
        let isRequired = title == L10n.string("paste_html")
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle()
                    .fill(editorTint(title))
                    .frame(width: 7, height: 7)
                Text(title)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(Theme.label)
                Spacer()
                Text(L10n.string(isRequired ? "editor_required" : "editor_optional"))
                    .font(.caption2)
                    .foregroundStyle(isRequired ? Theme.highlight : Theme.secondaryLabel.opacity(0.8))
            }
            ZStack(alignment: .topLeading) {
                TextEditor(text: text)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.label)
                    .tint(Theme.highlight)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(minHeight: minHeight, alignment: .topLeading)
                if text.wrappedValue.isEmpty {
                    Text(placeholder)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Theme.secondaryLabel.opacity(0.55))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 14)
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(12)
        .glassPanel(radius: 18)
    }

    private func editorTint(_ title: String) -> Color {
        switch title {
        case L10n.string("paste_html"): return Theme.highlight
        case L10n.string("paste_css"): return Theme.positive
        default: return Theme.premium
        }
    }

    private func creationHero(
        icon: String,
        eyebrowKey: String,
        titleKey: String,
        detailKey: String,
        tint: Color,
        detailText: String? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 45, height: 45)
                    .background(.white.opacity(0.11), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                Spacer()
                Text(L10n.string(eyebrowKey))
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(.white.opacity(0.58))
            }
            Text(L10n.string(titleKey))
                .font(.system(size: 28, weight: .bold, design: .serif))
                .foregroundStyle(.white)
            Text(detailText ?? L10n.string(detailKey))
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.68))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(19)
        .background(PageMakeTheme.heroGradient, in: RoundedRectangle(cornerRadius: 23, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Circle()
                .fill(tint.opacity(0.26))
                .frame(width: 110, height: 110)
                .blur(radius: 28)
                .offset(x: 28, y: -36)
        }
        .clipShape(RoundedRectangle(cornerRadius: 23, style: .continuous))
    }

    private var isTooLarge: Bool {
        guard let limit = pasteLimitBytes else { return false }
        return Int64(pasteContent.totalBytes) > limit
    }

    private var sizeText: String {
        let kb = Double(pasteContent.totalBytes) / 1024
        if let limit = pasteLimitBytes {
            return L10n.format("paste_size_with_limit", String(format: "%.1f", kb), formatLimit(limit))
        }
        return L10n.format("paste_size", String(format: "%.1f", kb))
    }

    private func submitPaste() {
        guard let name = validatedProjectName() else { return }
        guard pasteContent.hasContent else {
            alertItem = AlertItem(message: L10n.string("paste_content_required"))
            return
        }
        guard !isTooLarge else {
            let message = pasteLimitBytes.map {
                L10n.format("paste_too_large_limit", formatLimit($0))
            } ?? L10n.string("paste_too_large")
            alertItem = AlertItem(message: message)
            return
        }
        // 粘贴通道只产出纯前端项目（HTML + CSS，没有 package.json）；
        // 形态由 CreateSource.paste 自身固定，不再传 kind。
        onPick(.paste(pasteContent, name: name))
    }

    // MARK: - 文件选择

    /// 拷贝到临时目录（脱离安全作用域资源）+ 本地校验。
    /// 判定 ZIP 形态要读中央目录，因此是 async（读取本身在后台线程）。
    private func handlePicked(_ urls: [URL]) async {
        guard let name = validatedProjectName() else { return }
        var picked: [PickedFile] = []
        func discardPicked() {
            for file in picked {
                try? FileManager.default.removeItem(at: file.url)
            }
        }
        for url in urls {
            let didStart = url.startAccessingSecurityScopedResource()
            defer { if didStart { url.stopAccessingSecurityScopedResource() } }

            let name = url.lastPathComponent
            let ext = name.lowercased().components(separatedBy: ".").last ?? ""
            guard FileValidator.allowedExtensions(for: uploadWhitelistKind).contains(ext) else {
                discardPicked()
                alertItem = AlertItem(message: L10n.format("validation_extension", ext))
                return
            }

            let values = try? url.resourceValues(forKeys: [.fileSizeKey])
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            // Xcode 27 SDK 中 fileSize / int64Value 的整型宽度与旧 SDK 不同，
            // 不依赖 int64Value：直接把 NSNumber 转成 Int64，避免 SDK 推断差异。
            let resourceSize = values?.fileSize.map { Int64($0) }
            let attributeSize = (attributes?[.size] as? NSNumber).map { Int64(truncating: $0) }
            let size = resourceSize ?? attributeSize ?? 0
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString)_\(name)")
            do {
                try FileManager.default.copyItem(at: url, to: destination)
                picked.append(PickedFile(url: destination, name: name, size: size))
            } catch {
                discardPicked()
                alertItem = AlertItem(message: L10n.string("error_generic"))
                return
            }
        }

        switch FileValidator.validate(picked, limitBytes: maxUploadBytes, kind: uploadWhitelistKind) {
        case .success(let files):
            // 部署形态由文件自动识别（**根目录** package.json / pnpm-lock.yaml）。
            let detected = await DeployKindDetector.detect(files: files)
            guard let detected else {
                // ZIP 中央目录读不出条目名（zip64 / 加密 / 条目名非 UTF-8）：
                // 无法判定是纯前端还是后端，必须让用户知情后再决定，
                // 不能静默按纯前端上传（后端项目会缺 Node 运行时）。
                pendingBackendUpload = PendingBackendUpload(
                    files: files,
                    name: name,
                    reason: .undetermined
                )
                return
            }
            if detected.isBackend && !canUseBackend {
                // 非 VIP 选了含 package.json 的项目：不能静默按纯前端上传，
                // 让用户明确选择「降级纯前端」或取消去升级。
                pendingBackendUpload = PendingBackendUpload(
                    files: files,
                    name: name,
                    reason: .backendRequiresVIP
                )
                return
            }
            onPick(.files(files, name: name, kind: detected))
        case .failure(let error):
            discardPicked()
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        }
    }

    /// 登记待回收的临时文件（真正的删除推迟到页面关闭，见 onDisappear）。
    private func recycle(_ files: [PickedFile]) {
        pendingRecycleFiles.append(contentsOf: files)
    }

    /// 页面关闭时回收：已交给上传队列的文件在交接时就从列表里摘掉了，
    /// 这里只需要删剩下的（取消弹窗留下的那一批）。
    private func recycleLeftoverPendingFiles() {
        for file in pendingRecycleFiles {
            try? FileManager.default.removeItem(at: file.url)
        }
        pendingRecycleFiles.removeAll()
    }

    private var uploadHint: String {
        let limitKey = canUseBackend ? "pick_files_hint_backend_limit" : "pick_files_hint_limit"
        let unlimitedKey = canUseBackend ? "pick_files_hint_backend_unlimited" : "pick_files_hint_unlimited"
        guard let maxUploadBytes else {
            return L10n.string(unlimitedKey)
        }
        return L10n.format(limitKey, formatLimit(maxUploadBytes))
    }

    /// 普通用户保留 300KB 快速粘贴上限；VIP 及以上按服务端静态配额。
    private var pasteLimitBytes: Int64? {
        canUseBackend ? maxUploadBytes : Self.ordinaryPasteLimitBytes
    }

    private func formatLimit(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_048_576.0
        return mb >= 1 ? String(format: "%.0f MB", mb) : String(format: "%.0f KB", Double(bytes) / 1024.0)
    }
}

/// UIDocumentPicker 封装
struct DocumentPicker: UIViewControllerRepresentable {
    let types: [UTType]
    let allowsMultipleSelection: Bool
    let onPick: ([URL]) -> Void

    init(types: [UTType], allowsMultipleSelection: Bool = true, onPick: @escaping ([URL]) -> Void) {
        self.types = types
        self.allowsMultipleSelection = allowsMultipleSelection
        self.onPick = onPick
    }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        picker.allowsMultipleSelection = allowsMultipleSelection
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: ([URL]) -> Void

        init(onPick: @escaping ([URL]) -> Void) {
            self.onPick = onPick
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if Thread.isMainThread {
                onPick(urls)
            } else {
                DispatchQueue.main.async { [onPick] in
                    onPick(urls)
                }
            }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {}
    }
}
