import XCTest
@testable import PageMake

/// 选文件本地校验：后缀 + 总大小
final class FileValidatorTests: XCTestCase {
    private func pickedFile(name: String, size: Int64) -> PickedFile {
        PickedFile(url: URL(fileURLWithPath: "/tmp/\(name)"), name: name, size: size)
    }

    func testAcceptsZipAndWebFiles() {
        let files = [
            pickedFile(name: "site.zip", size: 1024),
            pickedFile(name: "index.html", size: 512)
        ]
        let result = FileValidator.validate(files)
        XCTAssertEqual(try? result.get().count, 2)
    }

    func testRejectsEmptySelection() {
        let result = FileValidator.validate([])
        XCTAssertEqual(result.failure, .emptySelection)
    }

    func testRejectsUnsupportedExtension() {
        let result = FileValidator.validate([pickedFile(name: "photo.exe", size: 1024)])
        XCTAssertEqual(result.failure, .unsupportedExtension("exe"))
    }

    func testBackendProjectAcceptsPackageJsonAndSourceFiles() {
        let files = [
            pickedFile(name: "package.json", size: 1024),
            pickedFile(name: "server.ts", size: 2048),
            pickedFile(name: "public/logo.png", size: 4096)
        ]
        let result = FileValidator.validate(files, limitBytes: 1024 * 1024, kind: .npm)
        XCTAssertEqual(try? result.get().count, 3)
    }

    /// bun 形态走同一份后端白名单：TS 源码与两种锁文件（bun.lockb 二进制 /
    /// bun.lock 文本）都必须放行——lockb 曾不在白名单里导致老 bun 项目被拒收
    func testBunProjectAcceptsTSAndLockFiles() {
        let files = [
            pickedFile(name: "package.json", size: 256),
            pickedFile(name: "server.ts", size: 2048),
            pickedFile(name: "bun.lockb", size: 512),
            pickedFile(name: "bun.lock", size: 384)
        ]
        let result = FileValidator.validate(files, limitBytes: 1024 * 1024, kind: .bun)
        XCTAssertEqual(try? result.get().count, 4)
    }

    func testRejectsTooLargeTotal() {
        let result = FileValidator.validate([pickedFile(name: "big.zip", size: 6 * 1024 * 1024)])
        XCTAssertEqual(result.failure, .tooLarge(bytes: 6 * 1024 * 1024))
    }

    func testAcceptsExactlyAtLimit() {
        let result = FileValidator.validate([pickedFile(name: "site.zip", size: 300 * 1024)])
        XCTAssertNotNil(try? result.get())
    }

    func testCaseInsensitiveExtension() {
        let result = FileValidator.validate([pickedFile(name: "INDEX.HTML", size: 100)])
        XCTAssertNotNil(try? result.get())
    }

    func testVIPRejectsProjectOverOneMegabyte() {
        let result = FileValidator.validate(
            [pickedFile(name: "site.zip", size: 2 * 1024 * 1024)],
            limitBytes: 1024 * 1024
        )
        XCTAssertEqual(result.failure, .tooLargeForTier(bytes: 2 * 1024 * 1024, limit: 1024 * 1024))
    }

    func testSVIPAcceptsHundredMegabytesAndUltraHasNoLimit() {
        let exactlyTenMB = FileValidator.validate(
            [pickedFile(name: "site.zip", size: 10 * 1024 * 1024)],
            limitBytes: 10 * 1024 * 1024
        )
        XCTAssertNotNil(try? exactlyTenMB.get())

        let unlimited = FileValidator.validate(
            [pickedFile(name: "site.zip", size: 1024 * 1024 * 1024)],
            limitBytes: nil
        )
        XCTAssertNotNil(try? unlimited.get())
    }
}

extension Result where Success == [PickedFile], Failure == FileValidationError {
    var failure: FileValidationError? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
