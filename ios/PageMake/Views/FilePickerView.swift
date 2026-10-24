import SwiftUI
import UniformTypeIdentifiers

/// 创建入口：上传文件 / 粘贴代码 / 项目模式
struct FilePickerView: View {
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
    @State private var explorerName = ""

    // 粘贴模式内容
    @State private var html = ""
    @State private var css = ""
    @State private var js = ""

    private static let pasteLimitBytes = 300 * 1024

    private static let supportedTypes: [UTType] = {
        var types: [UTType] = []
        for ext in ["zip", "html", "css", "js"] {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }()

    private var pasteContent: PasteContent {
        PasteContent(html: html, css: css, js: js)
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
                }
            }
            .navigationTitle(L10n.string("creation_studio"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.light, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
            }
            .sheet(isPresented: $showPicker) {
                DocumentPicker(types: Self.supportedTypes) { urls in
                    // UIKit delegate 回调不保证主线程；直接改 @State 会触发
                    // “Publishing changes from background threads” 甚至崩溃。
                    Task { @MainActor in
                        handlePicked(urls)
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
        }
    }

    // MARK: - 创建模式选择

    private var modeChooser: some View {
        HStack(spacing: 7) {
            modeButton(.files, icon: "doc.badge.plus", titleKey: "pick_mode_files")
            modeButton(.paste, icon: "chevron.left.forwardslash.chevron.right", titleKey: "pick_mode_paste")
            modeButton(.explorer, icon: "folder.badge.plus", titleKey: "mode_explorer")
        }
        .padding(5)
        .background(.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .stroke(PageMakeTheme.ink.opacity(0.07), lineWidth: 1)
        }
    }

    private func modeButton(_ value: Mode, icon: String, titleKey: String) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.24)) {
                mode = value
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                Text(L10n.string(titleKey))
                    .font(.caption2.bold())
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(
                mode == value ? PageMakeTheme.ink : Color.clear,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .foregroundStyle(mode == value ? .white : PageMakeTheme.inkSoft)
        }
        .buttonStyle(.plain)
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
                    tint: PageMakeTheme.gold
                )

                PageMakeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Label(L10n.string("creation_zip_note"), systemImage: "checkmark.circle.fill")
                            .font(.subheadline.bold())
                            .foregroundStyle(PageMakeTheme.ink)
                        Text(L10n.string("creation_zip_detail"))
                            .font(.caption)
                            .foregroundStyle(PageMakeTheme.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)

                        Button {
                            showPicker = true
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
                    tint: PageMakeTheme.sea
                )

                PageMakeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L10n.string("explorer_name_placeholder"))
                            .font(.caption.bold())
                            .foregroundStyle(PageMakeTheme.inkSoft)
                            .textCase(.uppercase)
                            .tracking(0.5)

                        TextField(L10n.string("explorer_name_placeholder"), text: $explorerName)
                            .font(.system(.body, design: .rounded, weight: .medium))
                            .padding(.horizontal, 13)
                            .padding(.vertical, 12)
                            .background(PageMakeTheme.paperWarm, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(PageMakeTheme.ink.opacity(0.08), lineWidth: 1)
                            }

                        Button {
                            let name = explorerName.trimmingCharacters(in: .whitespacesAndNewlines)
                            onPick(.explorer(name: name.isEmpty ? L10n.string("explorer_default_name") : name))
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
                    tint: PageMakeTheme.coral
                )

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
                editor(
                    title: L10n.string("paste_js"),
                    text: $js,
                    placeholder: L10n.string("paste_js_placeholder"),
                    minHeight: 120
                )

                Text(sizeText)
                    .font(.caption)
                    .foregroundStyle(isTooLarge ? PageMakeTheme.coral : PageMakeTheme.inkSoft)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 18)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Divider().overlay(PageMakeTheme.ink.opacity(0.06))
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
        }
    }

    // MARK: - 模板

    private var templatesRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.string("templates"))
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(PageMakeTheme.ink)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(PasteTemplates.all) { tpl in
                        Button {
                            applyTemplate(tpl)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(L10n.string(tpl.nameKey))
                                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                                    .foregroundStyle(PageMakeTheme.ink)
                                Text(L10n.string("use_template"))
                                    .font(.caption)
                                    .foregroundStyle(PageMakeTheme.inkSoft)
                            }
                            .padding(12)
                            .frame(width: 150, alignment: .leading)
                            .background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 15, style: .continuous)
                                    .stroke(PageMakeTheme.ink.opacity(0.07), lineWidth: 1)
                            }
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
        js = tpl.js
    }

    private func editor(title: String, text: Binding<String>, placeholder: String, minHeight: CGFloat) -> some View {
        let isRequired = title == L10n.string("paste_html")
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle()
                    .fill(editorTint(title))
                    .frame(width: 7, height: 7)
                Text(title)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(PageMakeTheme.ink)
                Spacer()
                Text(L10n.string(isRequired ? "editor_required" : "editor_optional"))
                    .font(.caption2)
                    .foregroundStyle(isRequired ? PageMakeTheme.coral : PageMakeTheme.inkSoft.opacity(0.8))
            }
            ZStack(alignment: .topLeading) {
                TextEditor(text: text)
                    .font(.system(.footnote, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(minHeight: minHeight, alignment: .topLeading)
                if text.wrappedValue.isEmpty {
                    Text(placeholder)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(PageMakeTheme.inkSoft.opacity(0.55))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 14)
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(12)
        .background(.white.opacity(0.82), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(PageMakeTheme.ink.opacity(0.07), lineWidth: 1)
        }
    }

    private func editorTint(_ title: String) -> Color {
        switch title {
        case L10n.string("paste_html"): return PageMakeTheme.coral
        case L10n.string("paste_css"): return PageMakeTheme.sea
        default: return PageMakeTheme.gold
        }
    }

    private func creationHero(
        icon: String,
        eyebrowKey: String,
        titleKey: String,
        detailKey: String,
        tint: Color
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
            Text(L10n.string(detailKey))
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
        pasteContent.totalBytes > Self.pasteLimitBytes
    }

    private var sizeText: String {
        let kb = Double(pasteContent.totalBytes) / 1024
        return L10n.format("paste_size", String(format: "%.1f", kb))
    }

    private func submitPaste() {
        guard pasteContent.hasContent else {
            alertItem = AlertItem(message: L10n.string("paste_content_required"))
            return
        }
        guard !isTooLarge else {
            alertItem = AlertItem(message: L10n.string("paste_too_large"))
            return
        }
        onPick(.paste(pasteContent))
    }

    // MARK: - 文件选择

    /// 拷贝到临时目录（脱离安全作用域资源）+ 本地校验
    private func handlePicked(_ urls: [URL]) {
        var picked: [PickedFile] = []
        for url in urls {
            let didStart = url.startAccessingSecurityScopedResource()
            defer { if didStart { url.stopAccessingSecurityScopedResource() } }

            let name = url.lastPathComponent
            let ext = name.lowercased().components(separatedBy: ".").last ?? ""
            guard FileValidator.allowedExtensions.contains(ext) else {
                alertItem = AlertItem(message: L10n.format("validation_extension", ext))
                return
            }

            let values = try? url.resourceValues(forKeys: [.fileSizeKey])
            let size = Int64(values?.fileSize ?? 0)
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString)_\(name)")
            do {
                try FileManager.default.copyItem(at: url, to: destination)
                picked.append(PickedFile(url: destination, name: name, size: size))
            } catch {
                alertItem = AlertItem(message: L10n.string("error_generic"))
                return
            }
        }

        switch FileValidator.validate(picked) {
        case .success(let files):
            onPick(.files(files))
        case .failure(let error):
            alertItem = AlertItem(message: error.errorDescription ?? L10n.string("error_generic"))
        }
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
