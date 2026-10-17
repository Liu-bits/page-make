import XCTest
@testable import PageMake

final class PasteContentTests: XCTestCase {
    func testTotalBytesSumsAllParts() {
        let content = PasteContent(html: "ab", css: "cd", js: "ef")
        XCTAssertEqual(content.totalBytes, 6)
    }

    func testTotalBytesCountsUTF8() {
        // 中文每字 3 字节
        let content = PasteContent(html: "网页", css: "", js: "")
        XCTAssertEqual(content.totalBytes, 6)
    }

    func testIsHtmlEmptyTrimsWhitespace() {
        XCTAssertTrue(PasteContent(html: "  \n\t ", css: "", js: "").isHtmlEmpty)
        XCTAssertFalse(PasteContent(html: "<p>x</p>", css: "", js: "").isHtmlEmpty)
    }
}
