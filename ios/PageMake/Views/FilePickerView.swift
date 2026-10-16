import SwiftUI
import UniformTypeIdentifiers

/// 选文件页（UIDocumentPicker + 本地校验）
struct FilePickerView: View {
    let onPick: ([PickedFile]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showPicker = false
    @State private var alertItem: AlertItem?

    private static let supportedTypes: [UTType] = {
        var types: [UTType] = []
        for ext in ["zip", "html", "css", "js"] {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }()

    var body: some View {
        NavigationStack {
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
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, 32)
                Spacer()
            }
            .navigationTitle(L10n.string("pick_files_title"))
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
                Button(L10n.string("done"), role: .cancel) {}
            } message: {
                Text(item.message)
            }
        }
    }

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
            onPick(files)
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
