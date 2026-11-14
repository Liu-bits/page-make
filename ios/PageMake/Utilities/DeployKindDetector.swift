import Foundation

/// 部署形态自动识别：不再让用户在创建页手动选择纯前端 / npm / pnpm / bun。
///
/// 规则（与后端 `publish` 的 kind 语义一致）：
/// - **根目录**有 `bun.lockb` / `bun.lock` → bun
/// - **根目录**有 `pnpm-lock.yaml` → pnpm
/// - **根目录**有 `package.json`（或 package-lock.json / yarn.lock）→ npm
/// - 都没有 → 纯前端（static）
/// - 文件清单读不全（ZIP 结构异常 / zip64 / 条目名非 UTF-8）→ `nil`（无法判定）
///
/// 「根目录」这条限制很重要：`node_modules/express/package.json`、
/// `sub/package.json` 都不代表项目本身是 Node 后端，静态站里带 node_modules
/// 是最常见的误判来源（一误判就会把纯前端项目当 npm 后端去 install/build）。
///
/// 单文件 ZIP 无法直接看文件名，这里只读 ZIP 的**中央目录**（文件名清单），
/// 不解压内容，几十 MB 的包也只读末尾几 KB + 目录区，不会把整包读进内存。
enum DeployKindDetector {
    /// 已知完整文件清单时的判定。清单本身可信（项目模式里的真实路径），
    /// 所以总能给出结论：没有根目录 package.json 就是纯前端。
    static func detect(fileNames: [String]) -> ProjectKind {
        var hasPackageJSON = false
        var hasPnpmLock = false
        var hasBunLock = false

        for rawName in fileNames {
            guard let name = rootFileName(rawName) else { continue }
            switch name {
            case "package.json":
                hasPackageJSON = true
            case "pnpm-lock.yaml":
                hasPnpmLock = true
            // bun.lockb（二进制）与 bun.lock（文本，1.2+ 默认）都算 bun 锁文件
            case "bun.lockb", "bun.lock":
                hasBunLock = true
            // package-lock.json / yarn.lock 走 npm 安装链路，而 npm 本来就是
            // 「有 package.json」时的默认结果，因此无需单独记录。
            default:
                break
            }
        }

        guard hasPackageJSON else { return .staticSite }
        if hasBunLock { return .bun }
        return hasPnpmLock ? .pnpm : .npm
    }

    /// 从已选文件推断部署形态；ZIP 会读取中央目录里的条目名。
    ///
    /// 返回 `nil` 表示**无法判定**：ZIP 的条目名读不出来时，既不能断言
    /// 「没有 package.json」（可能是后端项目），也不能断言「有」。
    /// 调用方必须给用户明确提示，不能静默按纯前端处理。
    static func detect(files: [PickedFile]) async -> ProjectKind? {
        var names: [String] = []
        var undetermined = false

        for file in files {
            if file.name.lowercased().hasSuffix(".zip") {
                // 中央目录最多 8MB：放后台读，别在文件选择回调里卡主线程。
                let url = file.url
                let entries = await Task.detached(priority: .userInitiated) {
                    ZipEntryNames.names(at: url)
                }.value
                if let entries {
                    names.append(contentsOf: entries)
                } else {
                    undetermined = true
                }
            } else {
                names.append(file.name)
            }
        }

        // 任一 ZIP 读不出条目名 → 清单不完整，无法判定
        guard !undetermined else { return nil }
        return detect(fileNames: names)
    }

    /// 项目模式（资源管理器）里的文件路径 → 部署形态。
    /// 路径清单来自服务端，始终可信，因此不会是「无法判定」。
    static func detect(paths: [String]) -> ProjectKind {
        detect(fileNames: paths)
    }

    /// 根目录文件名（小写）；位于子目录的条目返回 nil。
    /// ZIP 条目用 `/` 分隔，Windows 打包工具偶尔写 `\`，两者都归一。
    private static func rootFileName(_ rawName: String) -> String? {
        var name = rawName.replacingOccurrences(of: "\\", with: "/")
        while name.hasPrefix("./") { name.removeFirst(2) }
        guard !name.isEmpty, !name.contains("/") else { return nil }
        return name.lowercased()
    }
}

/// 读取 ZIP 中央目录中的条目名（只读元数据，不解压）。
enum ZipEntryNames {
    /// 单个 ZIP 最多解析多少条目，防止异常压缩包拖住读取线程。
    private static let maxEntries = 4000
    /// 中央目录最大读取量；正常项目远小于此值。
    private static let maxDirectoryBytes = 8 * 1024 * 1024

    /// 返回 nil 表示「读不出条目名」：不是 ZIP、加密、zip64、条目名非 UTF-8、
    /// 目录区被截断等。调用方必须当成「无法判定部署形态」。
    static func names(at url: URL) -> [String]? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }

        guard let fileSize = try? handle.seekToEnd(), fileSize > 22 else { return nil }
        let tailLength = Int(min(UInt64(65_557), fileSize))
        guard (try? handle.seek(toOffset: fileSize - UInt64(tailLength))) != nil,
              let tail = try? handle.read(upToCount: tailLength),
              tail.count >= 22,
              let eocd = endOfCentralDirectory(in: tail) else { return nil }

        let totalEntries = Int(readUInt16(tail, eocd + 10))
        let directorySize = Int(readUInt32(tail, eocd + 12))
        let directoryOffset = UInt64(readUInt32(tail, eocd + 16))
        // 0xFFFF / 0xFFFFFFFF 表示 zip64，条目数超过 65535，本项目场景不需要
        guard totalEntries < 0xFFFF,
              directorySize < 0xFFFF_FFFF,
              directoryOffset < fileSize else { return nil }
        // 空包（0 条目）没有可识别的形态，按「读不出清单」处理
        guard totalEntries > 0, directorySize > 0 else { return nil }
        // 目录区超过上限时只读一部分，条目清单会被截断 → 同样不可信
        guard directorySize <= maxDirectoryBytes else { return nil }

        guard (try? handle.seek(toOffset: directoryOffset)) != nil,
              let directory = try? handle.read(upToCount: directorySize),
              directory.count == directorySize else { return nil }

        var names: [String] = []
        var cursor = 0
        while cursor + 46 <= directory.count {
            guard readUInt32(directory, cursor) == 0x0201_4b50 else { return nil }
            let nameLength = Int(readUInt16(directory, cursor + 28))
            let extraLength = Int(readUInt16(directory, cursor + 30))
            let commentLength = Int(readUInt16(directory, cursor + 32))
            let nameStart = cursor + 46
            guard nameStart + nameLength <= directory.count else { return nil }
            // 非 UTF-8 条目名（未置 UTF-8 标志的旧包）：清单不可信
            let nameRange = (directory.startIndex + nameStart)..<(directory.startIndex + nameStart + nameLength)
            guard let name = String(data: directory.subdata(in: nameRange), encoding: .utf8) else {
                return nil
            }
            names.append(name)
            guard names.count < maxEntries else { return nil }
            cursor = nameStart + nameLength + extraLength + commentLength
        }
        return names.isEmpty ? nil : names
    }

    /// 从尾部数据里向前找 EOCD 签名 0x06054b50
    private static func endOfCentralDirectory(in data: Data) -> Int? {
        guard data.count >= 22 else { return nil }
        var index = data.count - 22
        while index >= 0 {
            if readUInt32(data, index) == 0x0605_4b50 { return index }
            index -= 1
        }
        return nil
    }

    // MARK: - 字节读取
    //
    // 索引基准统一：`offset` 一律是**相对 Data 起点**的偏移（0 基语义），
    // 内部再叠加 `startIndex` 得到真实下标。`subdata(in:)` 同样按真实下标
    // 取切片，两处不能各用一套基准（曾出现读到的字节错位）。

    private static func readUInt16(_ data: Data, _ offset: Int) -> UInt16 {
        guard offset >= 0, offset + 2 <= data.count else { return 0 }
        let start = data.startIndex + offset
        return UInt16(data[start]) | (UInt16(data[start + 1]) << 8)
    }

    private static func readUInt32(_ data: Data, _ offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= data.count else { return 0 }
        let start = data.startIndex + offset
        return UInt32(data[start])
            | (UInt32(data[start + 1]) << 8)
            | (UInt32(data[start + 2]) << 16)
            | (UInt32(data[start + 3]) << 24)
    }
}
