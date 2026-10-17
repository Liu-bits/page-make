import SwiftUI
import UniformTypeIdentifiers

/// 创建入口：上传文件 / 直接粘贴代码（两种方式二选一）
struct FilePickerView: View {
    let onPick: (CreateSource) -> Void

    private enum Mode: Hashable {
        case files
        case paste
    }

    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .files
    @State private var showPicker = false
    @State private var alertItem: AlertItem?

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
            VStack(spacing: 0) {
                Picker("", selection: $mode) {
                    Text(L10n.string("pick_mode_files")).tag(Mode.files)
                    Text(L10n.string("pick_mode_paste")).tag(Mode.paste)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top, 8)

                switch mode {
                case .files:
                    filesMode
                case .paste:
                    pasteMode
                }
            }
            .navigationTitle(L10n.string("add_project"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("cancel")) { dismiss() }
                }
            }
            .sheet(isPresented: $showPicker) {
                DocumentPicker(types: Self.supportedTypes) { urls in
                    handlePicked(urls)
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

    // MARK: - 文件模式

    private var filesMode: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text(L10n.string("pick_files_title"))
                .font(.title2.bold())
            Text(L10n.string("pick_files_hint"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                showPicker = true
            } label: {
                Text(L10n.string("pick_files_action"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .padding(.horizontal, 32)
            Spacer()
        }
    }

    // MARK: - 粘贴模式

    private var pasteMode: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(L10n.string("paste_hint"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)

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
                    .foregroundStyle(isTooLarge ? .red : .secondary)
            }
            .padding()
        }
        .safeAreaInset(edge: .bottom) {
            Button(L10n.string("paste_create")) {
                submitPaste()
            }
            .buttonStyle(.glassProminent)
            .padding()
            .disabled(pasteContent.isHtmlEmpty)
            .opacity(pasteContent.isHtmlEmpty ? 0.4 : 1)
        }
    }

    // MARK: - 模板

    private var templatesRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.string("templates"))
                .font(.subheadline.bold())
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(PasteTemplates.all) { tpl in
                        Button {
                            applyTemplate(tpl)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(L10n.string(tpl.nameKey))
                                    .font(.subheadline.bold())
                                Text(L10n.string("use_template"))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(12)
                            .frame(width: 150, alignment: .leading)
                            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 14))
                        }
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
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.bold())
            ZStack(alignment: .topLeading) {
                TextEditor(text: text)
                    .font(.system(.footnote, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(minHeight: minHeight, alignment: .topLeading)
                if text.wrappedValue.isEmpty {
                    Text(placeholder)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 14)
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(12)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
    }

    private var isTooLarge: Bool {
        pasteContent.totalBytes > Self.pasteLimitBytes
    }

    private var sizeText: String {
        let kb = Double(pasteContent.totalBytes) / 1024
        return L10n.format("paste_size", String(format: "%.1f", kb))
    }

    private func submitPaste() {
        guard !pasteContent.isHtmlEmpty else {
            alertItem = AlertItem(message: L10n.string("paste_html_required"))
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
            onPick(urls)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {}
    }
}
