import Foundation

/// 上传服务：分片上传 + 状态轮询（每 2 秒）
@MainActor
final class UploadService: ObservableObject {
    static let shared = UploadService()

    enum ItemStatus: Equatable {
        case uploading
        case processing
        case ready
        case failed
        case expired
    }

    struct Item: Identifiable, Equatable {
        var id = UUID()
        var name: String
        var provider: HostProvider
        var progress: Double = 0
        var status: ItemStatus = .uploading
        var errorMessage: String?
        var projectId: String?
        var uploadId: String?
        var project: Project?
    }

    @Published private(set) var items: [Item] = []

    private let api = APIClient.shared
    private var tasks: [UUID: Task<Void, Never>] = [:]

    private init() {}

    func upload(files: [PickedFile], provider: HostProvider) {
        let displayName = files.count == 1
            ? files[0].name
            : "\(files.count) \(L10n.string("file_count_unit"))"
        let item = Item(name: displayName, provider: provider)
        items.append(item)
        let itemId = item.id
        tasks[itemId] = Task { [weak self] in
            await self?.run(itemId: itemId, files: files, provider: provider)
        }
    }

    func cancel(_ item: Item) {
        tasks[item.id]?.cancel()
        tasks[item.id] = nil
        items.removeAll { $0.id == item.id }
        // 通知后端清理已上传的临时分片（fire-and-forget，失败无感）
        if let uploadId = item.uploadId {
            Task { try? await api.cancelUpload(uploadId: uploadId) }
        }
    }

    /// 粘贴代码直接创建（单次请求，无需分片与轮询）
    func createPasted(_ content: PasteContent, provider: HostProvider, name: String) {
        let item = Item(name: name, provider: provider, status: .uploading)
        items.insert(item, at: 0)
        let itemId = item.id
        tasks[itemId] = Task { [weak self] in
            guard let self else { return }
            do {
                let project = try await self.api.createPastedProject(
                    provider: provider,
                    html: content.html,
                    css: content.css,
                    js: content.js,
                    name: name
                )
                self.update(itemId) { $0.status = .ready; $0.progress = 1; $0.project = project }
                LogStore.shared.append("paste", result: "ok", errorCode: nil)
            } catch let error as APIError {
                self.update(itemId) { $0.status = .failed; $0.errorMessage = error.errorDescription }
                LogStore.shared.append("paste", result: "failed", errorCode: "\(error)")
            } catch {
                self.update(itemId) { $0.status = .failed; $0.errorMessage = L10n.string("error_generic") }
                LogStore.shared.append("paste", result: "failed", errorCode: "network")
            }
        }
    }

    private func update(_ itemId: UUID, _ transform: (inout Item) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
        transform(&items[index])
    }

    func remove(_ item: Item) {
        tasks[item.id]?.cancel()
        tasks[item.id] = nil
        items.removeAll { $0.id == item.id }
    }

    private func run(itemId: UUID, files: [PickedFile], provider: HostProvider) async {
        func update(_ transform: (inout Item) -> Void) {
            guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
            transform(&items[index])
        }

        do {
            let initResponse = try await api.initUpload(provider: provider, files: files)
            update { $0.uploadId = initResponse.uploadId }

            let totalChunks = files.reduce(0) { count, file in
                count + max(1, Int((Double(file.size) / Double(Config.chunkSize)).rounded(.up)))
            }
            var uploaded = 0

            for (fileIndex, file) in files.enumerated() {
                let data = try Data(contentsOf: file.url)
                let chunkCount = max(1, Int((Double(data.count) / Double(Config.chunkSize)).rounded(.up)))
                for chunkIndex in 0..<chunkCount {
                    if Task.isCancelled { return }
                    let start = chunkIndex * Config.chunkSize
                    let end = min(start + Config.chunkSize, data.count)
                    try await api.uploadChunk(
                        uploadId: initResponse.uploadId,
                        fileIndex: fileIndex,
                        chunkIndex: chunkIndex,
                        data: data.subdata(in: start..<end)
                    )
                    uploaded += 1
                    update { $0.progress = Double(uploaded) / Double(max(totalChunks, 1)) }
                }
            }

            let finish = try await api.finishUpload(uploadId: initResponse.uploadId)
            update { $0.status = .processing; $0.projectId = finish.projectId }
            LogStore.shared.append("upload_finish", result: "processing", errorCode: nil)

            await pollStatus(itemId: itemId, projectId: finish.projectId)
        } catch let error as APIError {
            update { $0.status = .failed; $0.errorMessage = error.errorDescription }
            LogStore.shared.append("upload", result: "failed", errorCode: "\(error)")
        } catch {
            update { $0.status = .failed; $0.errorMessage = L10n.string("error_generic") }
            LogStore.shared.append("upload", result: "failed", errorCode: "network")
        }
    }

    private func pollStatus(itemId: UUID, projectId: String) async {
        // 最大轮询 150 次（约 5 分钟，2 秒间隔），超时判失败；404（项目已删）立即退出
        let maxAttempts = 150
        var attempts = 0

        while !Task.isCancelled && attempts < maxAttempts {
            attempts += 1
            try? await Task.sleep(nanoseconds: UInt64(Config.pollIntervalSeconds * 1_000_000_000))

            do {
                let response = try await api.projectStatus(projectId)
                guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
                switch response.status {
                case .ready:
                    if let project = response.project {
                        items[index].status = .ready
                        items[index].project = project
                    } else {
                        items[index].status = .ready
                        items[index].errorMessage = nil
                    }
                    return
                case .failed:
                    items[index].status = .failed
                    items[index].errorMessage = PlainLanguage.message(forErrorCode: response.errorCode ?? "")
                    return
                case .expired:
                    items[index].status = .expired
                    return
                default:
                    continue
                }
            } catch let error as APIError {
                // 项目不存在（已删除）→ 立即退出，不再重试
                if case .http(let status, _) = error, status == 404 {
                    if let index = items.firstIndex(where: { $0.id == itemId }) {
                        items[index].status = .failed
                        items[index].errorMessage = L10n.string("error_project_gone")
                    }
                    return
                }
                continue // 网络 / 服务错误继续重试
            } catch {
                continue
            }
        }

        if !Task.isCancelled {
            if let index = items.firstIndex(where: { $0.id == itemId }) {
                items[index].status = .failed
                items[index].errorMessage = L10n.string("error_upload_timeout")
            }
        }
    }
}
