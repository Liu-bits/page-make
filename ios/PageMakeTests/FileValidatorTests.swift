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
        let result = FileValidator.validate([pickedFile(name: "photo.png", size: 1024)])
        XCTAssertEqual(result.failure, .unsupportedExtension("png"))
    }

    func testRejectsTooLargeTotal() {
        let result = FileValidator.validate([pickedFile(name: "big.zip", size: 6 * 1024 * 1024)])
        XCTAssertEqual(result.failure, .tooLarge(bytes: 6 * 1024 * 1024))
    }

    func testAcceptsExactlyAtLimit() {
        let result = FileValidator.validate([pickedFile(name: "site.zip", size: 5 * 1024 * 1024)])
        XCTAssertNotNil(try? result.get())
    }

    func testCaseInsensitiveExtension() {
        let result = FileValidator.validate([pickedFile(name: "INDEX.HTML", size: 100)])
        XCTAssertNotNil(try? result.get())
    }
}

extension Result where Success == [PickedFile], Failure == FileValidationError {
    var failure: FileValidationError? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
